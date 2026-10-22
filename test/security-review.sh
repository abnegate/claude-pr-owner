#!/usr/bin/env bash
# Exercises security-review.yml's plan step and the security-review/ plumbing.
# Runs on the same bash as GitHub-hosted Ubuntu runners.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

expect_line() {
  grep -qxF -- "$2" "$1" || fail "expected '$2' in $1, got: $(cat "$1")"
}

expect_output() {
  local value
  value=$(grep -E "^$2=" "$1" | tail -1 | cut -d= -f2-)
  [[ "$value" == "$3" ]] || fail "expected output $2='$3', got '$value'"
}

temp=$(mktemp -d)
trap 'kill "${stub_pid:-}" 2> /dev/null || true; rm -rf "$temp"' EXIT

report=security-review/report.js

finding() {
  jq -nc --arg title "$1" --arg file "$2" --arg symbol "$3" '{
    title: $title, severity: "high", confidence: "high", cwe: "CWE-639",
    file: $file, line: 12, symbol: $symbol,
    description: "d", evidence: "e", impact: "i", recommendation: "r"
  }'
}

# areas assigns tracked findings to the first area whose path owns them, and the rest to the first area.
export WORK="$temp/work"
mkdir -p "$WORK"
jq -n '[
  {fingerprint: "aaaaaaaaaaaaaaaa", state: "open", title: "A", file: "src/auth/session.php", line: 3},
  {fingerprint: "bbbbbbbbbbbbbbbb", state: "dismissed", title: "B", file: "src/storage/file.php", line: 4},
  {fingerprint: "cccccccccccccccc", state: "open", title: "C", file: "elsewhere.php", line: 5}
]' > "$WORK/known.json"
printf '%s\n' '# comment' 'auth: src/auth/' 'storage: src/storage app/storage.php' > "$temp/areas.txt"
node "$report" areas "$temp/areas.txt" > /dev/null
[[ "$(jq -c '[.[].name]' "$WORK/areas.json")" == '["auth","storage"]' ]] || fail "areas.json is $(cat "$WORK/areas.json")"
[[ "$(jq -c '[.known[].fingerprint]' "$WORK/areas/0.json")" == '["aaaaaaaaaaaaaaaa","cccccccccccccccc"]' ]] \
  || fail "area 0 known is $(jq -c .known "$WORK/areas/0.json")"
[[ "$(jq -c '[.known[].fingerprint]' "$WORK/areas/1.json")" == '["bbbbbbbbbbbbbbbb"]' ]] || fail 'area 1 known is wrong'
[[ "$(jq -c .paths "$WORK/areas/1.json")" == '["src/storage","app/storage.php"]' ]] || fail 'area paths are not trimmed'
grep -q 'fingerprint aaaaaaaaaaaaaaaa' "$WORK/areas/0.md" || fail 'tracked markdown misses a finding'

printf '\n' > "$temp/empty.txt"
node "$report" areas "$temp/empty.txt" > /dev/null
[[ "$(jq -c '.paths' "$WORK/areas/0.json")" == '["."]' ]] || fail 'an empty area list is not the whole repository'
[[ "$(jq '.known | length' "$WORK/areas/0.json")" == 3 ]] || fail 'the whole repository does not own every tracked finding'

printf 'no separator\n' > "$temp/bad.txt"
if node "$report" areas "$temp/bad.txt" > "$temp/out" 2>&1; then
  fail 'an area without a name was accepted'
fi
expect_line "$temp/out" "::error::Area 'no separator' is not 'name: path path ...'."

# collect normalises both providers and rejects failures without printing model output.
one=$(finding 'Missing project check' app/controllers/api/x.php /v1/x)
jq -n --argjson finding "$one" '{is_error: false, num_turns: 4, total_cost_usd: 1.5, structured_output: {findings: [$finding]}}' > "$temp/claude.json"
node "$report" collect anthropic "$temp/claude.json" "$temp/reviews/0-0.json" claude-opus-5-5 review > "$temp/out"
expect_line "$temp/out" 'claude-opus-5-5: 4 turns ($1.50).'
expect_line "$temp/out" 'claude-opus-5-5: 1 findings.'
[[ "$(jq -r .model "$temp/reviews/0-0.json")" == claude-opus-5-5 ]] || fail 'collect does not record the model'

jq -n --argjson finding "$one" '{findings: [$finding]}' > "$temp/sol.json"
node "$report" collect openai "$temp/sol.json" "$temp/reviews/0-1.json" gpt-6.1-sol review > /dev/null

jq -n '{is_error: true, terminal_reason: "api_error", num_turns: 1, result: "SECRET FINDING TEXT"}' > "$temp/failed.json"
if node "$report" collect anthropic "$temp/failed.json" "$temp/unused.json" claude-opus-5-5 review > "$temp/out"; then
  fail 'a failed Claude run was collected'
fi
expect_line "$temp/out" '::error::claude-opus-5-5 failed: api_error after 1 turns ($0.00).'
jq -n '{is_error: true, terminal_reason: "api_error", api_error_status: 529, num_turns: 18, total_cost_usd: 0.6}' > "$temp/overloaded.json"
if node "$report" collect anthropic "$temp/overloaded.json" "$temp/unused.json" claude-fable-5-1 triage > "$temp/out"; then
  fail 'an overloaded Claude run was collected'
fi
expect_line "$temp/out" '::error::claude-fable-5-1 failed: api_error (HTTP 529) after 18 turns ($0.60).'
grep -q 'SECRET' "$temp/out" && fail 'collect printed model output'

if node "$report" collect openai "$temp/missing.json" "$temp/unused.json" gpt-6.1-sol review > "$temp/out"; then
  fail 'a missing GPT result was collected'
fi
expect_line "$temp/out" '::error::gpt-6.1-sol produced no result.'

jq -n '{findings: []}' > "$temp/no-resolved.json"
if node "$report" collect openai "$temp/no-resolved.json" "$temp/unused.json" gpt-6.1-sol triage > /dev/null; then
  fail 'a triage result without resolved was collected'
fi

# candidates merges every reviewer of an area and decides whether triage runs.
node "$report" areas "$temp/areas.txt" > /dev/null
GITHUB_OUTPUT="$temp/candidates.out" node "$report" candidates "$temp/reviews" 0 > "$temp/out"
expect_line "$temp/out" 'Candidates: 2. Open tracked findings to recheck: 2.'
expect_output "$temp/candidates.out" triage true
[[ "$(jq -c '[.[].reviewer]' "$WORK/candidates.json")" == '["claude-opus-5-5","gpt-6.1-sol"]' ]] || fail 'candidates lose the reviewer'
[[ "$(jq '[.[].fingerprint]' "$WORK/known.json" | jq length)" == 2 ]] || fail 'candidates does not narrow known.json to the area'

GITHUB_OUTPUT="$temp/candidates.out" node "$report" candidates "$temp/nothing" 1 > /dev/null
expect_output "$temp/candidates.out" triage false

confirmed=$(jq -c '. + {sources: ["claude-opus-5-5", "gpt-6.1-sol"], duplicateOf: null}' <<< "$one")

# publish to issues against a stub GitHub API: one issue per new finding, one resolved comment per issue.
cat > "$temp/stub.js" << 'JS'
const fs = require('fs');
const http = require('http');
const log = process.argv[2];
const issues = [
  { number: 7, state: 'open', title: 'Old', body: '**Location:** [`a.php:3`](x)\n\n<!-- security-review:fingerprint=aaaaaaaaaaaaaaaa -->' },
  { number: 8, state: 'open', title: 'Flagged', body: '<!-- security-review:fingerprint=bbbbbbbbbbbbbbbb -->' },
  { number: 9, state: 'open', title: 'Pull', body: '<!-- security-review:fingerprint=eeeeeeeeeeeeeeee -->', pull_request: {} },
];
const comments = { 7: [], 8: [{ body: 'x <!-- security-review:resolved -->' }] };
const server = http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    fs.appendFileSync(log, `${request.method} ${request.url} ${body}\n`);
    const url = new URL(request.url, 'http://stub');
    let payload = { number: 100 };
    let status = 200;
    if (url.pathname === '/repos/acme/fresh/code-scanning/alerts') {
      status = 404;
      payload = { message: 'no analysis found' };
    } else if (url.pathname === '/repos/acme/disabled/code-scanning/alerts') {
      status = 403;
      payload = { message: 'Code scanning is not enabled for this repository' };
    } else if (url.pathname === '/repos/acme/broken/code-scanning/alerts') {
      status = 500;
      payload = { message: 'boom' };
    } else if (url.pathname === '/repos/acme/app/code-scanning/alerts') {
      payload =
        url.searchParams.get('state') === 'open' && url.searchParams.get('page') === '1'
          ? [
              {
                rule: { id: 'security-review/aaaaaaaaaaaaaaaa', description: 'A', security_severity_level: 'high', tags: ['security'] },
                most_recent_instance: { location: { path: 'a.php', start_line: 3 }, message: { text: 'm' } },
              },
            ]
          : [];
    } else if (request.method === 'GET' && url.pathname === '/repos/acme/filed/issues') {
      payload =
        url.searchParams.get('page') === '1'
          ? [{ number: 11, state: 'open', title: 'Filed', body: '<!-- security-review:fingerprint=a9ec607ab969fe7c -->' }]
          : [];
    } else if (request.method === 'GET' && url.pathname.endsWith('/issues')) {
      payload = url.searchParams.get('page') === '1' ? issues : [];
    } else if (request.method === 'GET' && url.pathname.endsWith('/comments')) {
      payload = comments[url.pathname.split('/').at(-2)] ?? [];
    }
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(`${log}.port`, String(server.address().port)));
JS
node "$temp/stub.js" "$temp/api.log" &
stub_pid=$!
for _ in $(seq 50); do
  [[ -s "$temp/api.log.port" ]] && break
  sleep 0.1
done
[[ -s "$temp/api.log.port" ]] || fail 'stub API did not start'
api="http://127.0.0.1:$(cat "$temp/api.log.port")"

SINK=code-scanning GITHUB_API_URL="$api" TARGET_REPOSITORY=acme/app GITHUB_TOKEN=token node "$report" known > "$temp/out"
expect_line "$temp/out" 'Tracked findings: 1 (1 open).'
[[ "$(jq -c '.[0] | [.fingerprint, .state, .severity, .file, .line]' "$WORK/known.json")" == '["aaaaaaaaaaaaaaaa","open","high","a.php",3]' ]] \
  || fail "code scanning alert is not parsed: $(jq -c '.[0]' "$WORK/known.json")"

SINK=code-scanning GITHUB_API_URL="$api" TARGET_REPOSITORY=acme/fresh GITHUB_TOKEN=token node "$report" known > "$temp/out" \
  || fail 'a repository with no code scanning analysis yet failed'
expect_line "$temp/out" 'Tracked findings: 0 (0 open).'

if SINK=code-scanning GITHUB_API_URL="$api" TARGET_REPOSITORY=acme/disabled GITHUB_TOKEN=token node "$report" known > "$temp/out"; then
  fail 'disabled code scanning was treated as no findings'
fi
expect_line "$temp/out" '::error::Code scanning is not enabled for acme/disabled, so findings have nowhere private to go. Enable code scanning, or pass sink: issues on a private repository.'

if SINK=code-scanning GITHUB_API_URL="$api" TARGET_REPOSITORY=acme/broken GITHUB_TOKEN=token node "$report" known > "$temp/out"; then
  fail 'a server error was treated as no findings'
fi
expect_line "$temp/out" '::error::GET /repos/acme/broken/code-scanning/alerts?tool_name=ureview%20security%20review&state=open&per_page=100&page=1 returned 500'

SINK=issues GITHUB_API_URL="$api" TARGET_REPOSITORY=acme/app GITHUB_TOKEN=token node "$report" known > "$temp/out"
expect_line "$temp/out" 'Tracked findings: 2 (2 open).'
[[ "$(jq -c '.[0] | [.fingerprint, .number, .file, .line]' "$WORK/known.json")" == '["aaaaaaaaaaaaaaaa",7,"a.php",3]' ]] \
  || fail "issue location is not parsed: $(jq -c '.[0]' "$WORK/known.json")"

mkdir -p "$temp/triage"
known_duplicate=$(jq -c '. + {sources: ["claude-opus-5-5"], duplicateOf: null}' <<< "$(finding Same a.php A::b)")
jq -n --argjson a "$confirmed" --argjson b "$confirmed" --argjson c "$known_duplicate" \
  '{model: "claude-fable-5-1", findings: [$a, $b, $c], resolved: ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]}' > "$temp/triage/0.json"
: > "$temp/api.log"
SINK=issues GITHUB_API_URL="$api" TARGET_REPOSITORY=acme/app GITHUB_TOKEN=token GITHUB_SERVER_URL=https://github.com HEAD_SHA=abc \
  node "$report" publish "$temp/triage" > "$temp/out"
expect_line "$temp/out" 'New issues: 2. Flagged as resolved: 1.'
[[ "$(grep -c '^POST /repos/acme/app/issues ' "$temp/api.log")" == 2 ]] || fail "issues created: $(cat "$temp/api.log")"
grep -q '^POST /repos/acme/app/issues/7/comments ' "$temp/api.log" || fail 'resolved issue 7 was not flagged'
grep -q '^POST /repos/acme/app/issues/8/comments ' "$temp/api.log" && fail 'issue 8 was flagged twice'
grep '^POST /repos/acme/app/issues ' "$temp/api.log" | head -1 | grep -q 'security-review:fingerprint=a9ec607ab969fe7c' \
  || fail 'issue body carries no fingerprint marker'
grep -q 'blob/abc/app/controllers/api/x.php#L12' "$temp/api.log" || fail 'issue links the wrong location'

# A rerun publishes with the plan's snapshot of tracked findings, taken before the first attempt filed anything.
echo '[]' > "$WORK/known.json"
jq -n --argjson a "$confirmed" '{model: "claude-fable-5-1", findings: [$a], resolved: []}' > "$temp/triage/0.json"
: > "$temp/api.log"
SINK=issues GITHUB_API_URL="$api" TARGET_REPOSITORY=acme/filed GITHUB_TOKEN=token GITHUB_SERVER_URL=https://github.com HEAD_SHA=abc \
  node "$report" publish "$temp/triage" > "$temp/out"
expect_line "$temp/out" 'New issues: 0. Flagged as resolved: 0.'
grep -q '^POST /repos/acme/filed/issues ' "$temp/api.log" && fail 'a rerun filed a finding that is already an issue'

# publish to code scanning against the stub API: new findings, kept tracked alerts, resolved ones dropped, duplicates not re-emitted.
node "$report" areas "$temp/areas.txt" > /dev/null
jq -n '[
  {fingerprint: "aaaaaaaaaaaaaaaa", state: "open", title: "A", severity: "medium", tags: ["security", "cwe-79"], file: "a.php", line: 3, message: "m"},
  {fingerprint: "bbbbbbbbbbbbbbbb", state: "open", title: "B", severity: "low", tags: [], file: "b.php", line: 4, message: "m"},
  {fingerprint: "cccccccccccccccc", state: "dismissed", title: "C", severity: "low", tags: [], file: "c.php", line: 1, message: "m"},
  {fingerprint: "dddddddddddddddd", state: "open", title: "D", severity: "high", tags: [], file: "d.php", line: 1, message: "m"}
]' > "$WORK/known.json"
duplicate=$(jq -c '. + {sources: ["gpt-6.1-sol"], duplicateOf: "dddddddddddddddd"}' <<< "$(finding Again d.php X::y)")
rm -rf "$temp/triage"
mkdir -p "$temp/triage"
jq -n --argjson a "$confirmed" '{model: "claude-fable-5-1", findings: [$a], resolved: ["bbbbbbbbbbbbbbbb"]}' > "$temp/triage/0.json"
jq -n --argjson a "$duplicate" '{model: "claude-fable-5-1", findings: [$a], resolved: ["dddddddddddddddd"]}' > "$temp/triage/1.json"
SINK=code-scanning GITHUB_API_URL="$api" TARGET_REPOSITORY=acme/app GITHUB_TOKEN=token HEAD_SHA=abc BRANCH=main \
  node "$report" publish "$temp/triage" > "$temp/out"
expect_line "$temp/out" 'New alerts: 1. Kept: 3. Resolved: 1.'
expect_line "$temp/out" 'Uploaded the code scanning analysis.'
upload=$(grep '^POST /repos/acme/app/code-scanning/sarifs ' "$temp/api.log" | cut -d' ' -f3-)
[[ -n "$upload" ]] || fail "the analysis was not uploaded: $(cat "$temp/api.log")"
[[ "$(jq -r '[.commit_sha, .ref] | join(" ")' <<< "$upload")" == 'abc refs/heads/main' ]] || fail "the analysis targets the wrong commit: $(jq -c '[.commit_sha, .ref]' <<< "$upload")"
jq -r .sarif <<< "$upload" | base64 -d | gunzip | cmp -s - "$WORK/security-review.sarif" || fail 'the uploaded SARIF is not the written one'
sarif="$WORK/security-review.sarif"
[[ "$(jq -c '[.runs[0].results[].ruleId] | sort' "$sarif")" == '["security-review/a9ec607ab969fe7c","security-review/aaaaaaaaaaaaaaaa","security-review/cccccccccccccccc","security-review/dddddddddddddddd"]' ]] \
  || fail "SARIF results are $(jq -c '[.runs[0].results[].ruleId]' "$sarif")"
[[ "$(jq -r '.runs[0].results[] | select(.ruleId == "security-review/a9ec607ab969fe7c") | .partialFingerprints["securityReview/v1"]' "$sarif")" == a9ec607ab969fe7c ]] \
  || fail 'new alerts carry no stable fingerprint'
[[ "$(jq -r '.runs[0].tool.driver.rules[] | select(.id == "security-review/a9ec607ab969fe7c") | .properties["security-severity"]' "$sarif")" == '8.0' ]] \
  || fail 'severity is not mapped to a security-severity score'

[[ "$(jq -r '.runs[0].automationDetails.id' "$sarif")" == 'security-review/' ]] || fail 'the analysis has no stable category'

rm -rf "$temp/triage"
mkdir -p "$temp/triage"
: > "$temp/api.log"
SINK=code-scanning GITHUB_API_URL="$api" TARGET_REPOSITORY=acme/app GITHUB_TOKEN=token HEAD_SHA=abc BRANCH=main \
  node "$report" publish "$temp/triage" > "$temp/out"
grep -q 'code-scanning/sarifs' "$temp/api.log" && fail 'an analysis with nothing new or resolved was uploaded'

# artifacts round-trip with the right key and refuse the wrong one.
mkdir -p "$temp/pack"
echo secret > "$temp/pack/file.txt"
export GITHUB_REPOSITORY=acme/app GITHUB_RUN_ID=42
ARTIFACT_SECRET_KEY=one security-review/artifact.sh pack "$temp/pack" "$temp/pack.enc"
grep -q secret "$temp/pack.enc" && fail 'artifact is not encrypted'
ARTIFACT_SECRET_KEY=one security-review/artifact.sh unpack "$temp/pack.enc" "$temp/unpacked"
[[ "$(cat "$temp/unpacked/file.txt")" == secret ]] || fail 'artifact did not round-trip'
if ARTIFACT_SECRET_KEY=two security-review/artifact.sh unpack "$temp/pack.enc" "$temp/wrong" 2> /dev/null; then
  fail 'artifact unpacked with the wrong key'
fi
if ARTIFACT_SECRET_KEY='' security-review/artifact.sh pack "$temp/pack" "$temp/none.enc" > "$temp/out"; then
  fail 'artifact packed without a key'
fi

# The plan step: provider selection, credentials, sink, and the incremental range.
python3 - << 'PY'
import yaml
from pathlib import Path
data = yaml.safe_load(Path(".github/workflows/security-review.yml").read_text())
plan = next(step["run"] for step in data["jobs"]["plan"]["steps"] if step.get("id") == "plan")
Path("/tmp/security-review-plan.sh").write_text(plan)
PY
bash -n /tmp/security-review-plan.sh

python3 - << 'PY'
import re
import yaml
from pathlib import Path
jobs = yaml.safe_load(Path(".github/workflows/security-review.yml").read_text())["jobs"]
labels = {name: job["runs-on"] for name, job in jobs.items()}
for name, label in labels.items():
    match = re.fullmatch(r"\$\{\{ format\(inputs\.runner, format\('\{0\}-\{1\}-security-review-([a-z]+)[^']*', github\.run_id, github\.run_attempt[^)]*\)\) \}\}", label)
    if match is None or match.group(1) != name:
        raise SystemExit(f"FAIL: job {name} does not run on inputs.runner with its own id: {label}")
if "{1}-security-review-review-{2}-{3}', github.run_id, github.run_attempt, matrix.area, matrix.slot" not in labels["review"]:
    raise SystemExit("FAIL: review runner ids are not unique per area and reviewer")
if "{1}-security-review-triage-{2}', github.run_id, github.run_attempt, matrix.area" not in labels["triage"]:
    raise SystemExit("FAIL: triage runner ids are not unique per area")
inputs = yaml.safe_load(Path(".github/workflows/security-review.yml").read_text())[True]["workflow_call"]["inputs"]
if inputs["runner"].get("default") != "ubuntu-24.04":
    raise SystemExit("FAIL: runner does not default to GitHub-hosted runners")
for name, job in jobs.items():
    if job.get("environment") != "${{ inputs.environment }}":
        raise SystemExit(f"FAIL: job {name} does not run in inputs.environment, so its secrets are not branch-protected")
text = Path(".github/workflows/security-review.yml").read_text()
seeds = re.findall(r"ARTIFACT_SECRET_KEY: (.*)", text)
if len(seeds) != 6 or any(seed != "${{ secrets.app_private_key || secrets.api_key || secrets.oauth_token || secrets.openai_api_key }}" for seed in seeds):
    raise SystemExit(f"FAIL: the artifact key does not prefer the app private key, so rotating a model key breaks reruns: {set(seeds)}")
if inputs["environment"].get("default") != "security-review":
    raise SystemExit("FAIL: environment does not default to security-review")
PY

repository="$temp/plan/repository"
mkdir -p "$repository"
git -C "$repository" init -q -b main
git -C "$repository" config user.email test@example.com
git -C "$repository" config user.name test
GIT_COMMITTER_DATE='2020-01-01T00:00:00Z' git -C "$repository" commit -q --allow-empty -m first --date '2020-01-01T00:00:00Z'
first=$(git -C "$repository" rev-parse HEAD)
git -C "$repository" commit -q --allow-empty -m second
second=$(git -C "$repository" rev-parse HEAD)
mkdir -p "$temp/plan/ureview"
cp -R security-review "$temp/plan/ureview/"
mkdir -p "$temp/bin"
cat > "$temp/bin/gh" << 'GH'
#!/usr/bin/env bash
echo "gh $* token=$GH_TOKEN" >> "$GH_LOG"
case "$1 $2" in
  'api repos/'*) echo "${GH_PRIVATE:-false}" ;;
  'run list') echo "${GH_RUN:-}" ;;
  'run download')
    [[ -n "${GH_HEAD:-}" ]] || exit 1
    while [[ $# -gt 0 && "$1" != --dir ]]; do shift; done
    mkdir -p "$2"
    echo "$GH_HEAD" > "$2/head"
    ;;
esac
GH
chmod +x "$temp/bin/gh"
cat > "$temp/bin/node" << 'NODE'
#!/usr/bin/env bash
if [[ "$2" == known ]]; then
  echo '[]' > "$WORK/known.json"
  echo "known SINK=$SINK TARGET_REPOSITORY=$TARGET_REPOSITORY GITHUB_TOKEN=$GITHUB_TOKEN" >> "$GH_LOG"
  exit 0
fi
exec "$REAL_NODE" "$@"
NODE
chmod +x "$temp/bin/node"

run_plan() {
  : > "$temp/plan.out"
  : > "$temp/gh.log"
  (
    cd "$temp/plan"
    export PATH="$temp/bin:$PATH" REAL_NODE="$(command -v node)" GH_LOG="$temp/gh.log"
    export RUNNER_TEMP="$temp/plan/runner" GITHUB_OUTPUT="$temp/plan.out" GITHUB_REPOSITORY=acme/security-review
    export TARGET=acme/app TARGET_TOKEN=target-token GH_TOKEN=caller-token
    export GITHUB_REF_NAME=main GITHUB_WORKFLOW_REF='acme/app/.github/workflows/security-review.yml@refs/heads/main'
    export MODE="${MODE:-incremental}" SINCE="${SINCE:-}" HISTORY="${HISTORY:-}" PROJECT=.github/security-review.md
    export AREAS="${AREAS:-}" REVIEWERS="${REVIEWERS:-}" TRIAGE_MODEL="${TRIAGE_MODEL:-claude-fable-5-1}"
    export EFFORT="${EFFORT:-}" BUDGET="${BUDGET:-}" SINK_INPUT="${SINK_INPUT:-}"
    export RUNNER="${RUNNER-ubuntu-24.04}" TIMEOUT="${TIMEOUT:-}" GITHUB_RUN_ID=77 GITHUB_RUN_ATTEMPT=1
    export HAS_ANTHROPIC="${HAS_ANTHROPIC:-true}" HAS_OPENAI="${HAS_OPENAI:-true}"
    rm -rf "$RUNNER_TEMP"
    bash -e /tmp/security-review-plan.sh > "$temp/plan.stdout" 2>&1
  )
}

GH_RUN='2026-10-01T00:00:00Z 555' GH_HEAD="$first" run_plan || fail "plan failed: $(cat "$temp/plan.stdout")"
expect_output "$temp/plan.out" changed true
expect_output "$temp/plan.out" head "$second"
expect_output "$temp/plan.out" branch main
grep -qF 'gh run list --repo acme/security-review' "$temp/gh.log" || fail 'run history is not read from the calling repository'
grep -qF 'gh run download 555 --repo acme/security-review --name security-review-head' "$temp/gh.log" || fail 'the last reviewed commit is not read from the newest successful run'
grep -qF 'gh api repos/acme/app --jq .private token=target-token' "$temp/gh.log" || fail 'visibility is not read from the target with its token'
grep -qF 'known SINK=code-scanning TARGET_REPOSITORY=acme/app GITHUB_TOKEN=target-token' "$temp/gh.log" || fail 'tracked findings are not read from the target with its token'
expect_output "$temp/plan.out" sink code-scanning
expect_output "$temp/plan.out" effort xhigh
expect_output "$temp/plan.out" budget 40
expect_output "$temp/plan.out" timeout 360
expect_output "$temp/plan.out" triage_provider anthropic
expect_output "$temp/plan.out" reviews '[{"area":0,"name":"repository","slot":0,"model":"claude-opus-5-5","provider":"anthropic"},{"area":0,"name":"repository","slot":1,"model":"gpt-6.1-sol","provider":"openai"}]'
expect_output "$temp/plan.out" areas '[{"area":0}]'
grep -q "Changes: \`git diff $first $second\`" "$temp/plan/runner/security-review/scope.md" || fail 'the range does not start at the last successful run'
grep -q -- '--workflow security-review.yml' "$temp/gh.log" || fail 'history does not default to the calling workflow'
grep -q 'No project description was provided.' "$temp/plan/runner/security-review/project.md" || fail 'a missing project file is not tolerated'

HISTORY='security-review.yml, security-review-deep.yml' GH_RUN='2026-10-01T00:00:00Z 555' GH_HEAD="$first" run_plan || fail 'plan failed with history'
[[ "$(grep -c -- '--workflow security-review' "$temp/gh.log")" == 2 ]] || fail 'every history workflow is not consulted'

GH_RUN='2026-10-01T00:00:00Z 555' GH_HEAD="$second" run_plan || fail 'plan failed with nothing new'
expect_output "$temp/plan.out" changed false

GH_PRIVATE=true HAS_OPENAI=false run_plan || fail 'plan failed without OpenAI credentials'
expect_output "$temp/plan.out" sink issues
expect_output "$temp/plan.out" reviews '[{"area":0,"name":"repository","slot":0,"model":"claude-opus-5-5","provider":"anthropic"}]'
grep -qF '::warning::No openai credentials are set, so gpt-6.1-sol does not review this run.' "$temp/plan.stdout" || fail 'a skipped reviewer is not warned about'

MODE=deep AREAS=$'auth: src/auth\nstorage: src/storage' run_plan || fail "deep plan failed: $(cat "$temp/plan.stdout")"
expect_output "$temp/plan.out" effort max
expect_output "$temp/plan.out" budget ''
expect_output "$temp/plan.out" timeout 7200
expect_output "$temp/plan.out" areas '[{"area":0},{"area":1}]'
[[ "$(grep -E '^reviews=' "$temp/plan.out" | cut -d= -f2- | jq -c '[.[] | [.area, .model]]')" == '[[0,"claude-fable-5-1"],[0,"gpt-6.1-sol"],[1,"claude-fable-5-1"],[1,"gpt-6.1-sol"]]' ]] \
  || fail 'deep mode does not review every area with every reviewer'
grep -q -- 'run list' "$temp/gh.log" && fail 'deep mode looked up a range'

GH_RUN='2026-10-01T00:00:00Z 555' run_plan || fail 'plan failed without a recorded commit'
grep -q "Changes: \`git diff $first $second\`" "$temp/plan/runner/security-review/scope.md" || fail 'an expired record does not fall back to the last 24 hours'

mkdir -p "$temp/plan/caller/.github"
echo 'The system under review.' > "$temp/plan/caller/.github/security-review.md"
GH_RUN='2026-10-01T00:00:00Z 555' GH_HEAD="$first" run_plan || fail 'plan failed with a project file'
grep -qx 'The system under review.' "$temp/plan/runner/security-review/project.md" || fail 'the project file is not read from the calling repository'
rm -rf "$temp/plan/caller"

HAS_ANTHROPIC=false run_plan && fail 'triage without its credentials was accepted'
grep -qF '::error::No anthropic credentials are set for the triage model claude-fable-5-1.' "$temp/plan.stdout" || fail 'missing triage credentials are not explained'

HAS_ANTHROPIC=false HAS_OPENAI=false run_plan && fail 'a plan with no reviewer was accepted'
REVIEWERS=llama-3 run_plan && fail 'an unknown provider was accepted'
REVIEWERS='claude;rm' run_plan && fail 'an invalid model id was accepted'
MODE=quick run_plan && fail 'an unknown mode was accepted'
EFFORT=extreme run_plan && fail 'an unknown effort was accepted'
BUDGET=lots run_plan && fail 'a non-numeric budget was accepted'
SINK_INPUT=slack run_plan && fail 'an unknown sink was accepted'
TIMEOUT=forever run_plan && fail 'a non-numeric timeout was accepted'
RUNNER='' run_plan && fail 'an empty runner was accepted'
TIMEOUT=600 run_plan || fail 'an explicit timeout was rejected'
expect_output "$temp/plan.out" timeout 600

echo 'security review tests passed'
