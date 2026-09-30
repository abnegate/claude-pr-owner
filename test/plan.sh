#!/usr/bin/env bash
# Exercises the orchestrator planner and the prompts it builds.
# Runs on the same bash as GitHub-hosted Ubuntu runners.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

python3 - << 'PY'
import yaml
from pathlib import Path
text = Path(".github/workflows/orchestrator.yml").read_text()
data = yaml.safe_load(text)
plan = next(step["run"] for step in data["jobs"]["plan"]["steps"] if step.get("id") == "plan")
run_prompt = next(step["run"] for step in data["jobs"]["run"]["steps"] if step.get("id") == "prompt")
review_prompt = next(step["run"] for step in data["jobs"]["review"]["steps"] if step.get("id") == "prompt")
push = next(step["run"] for step in data["jobs"]["consolidate"]["steps"] if step.get("name") == "Push")
owner = yaml.safe_load(Path(".github/workflows/owner.yml").read_text())
resolve = next(step["run"] for step in owner["jobs"]["resolve"]["steps"] if step.get("id") == "owner")
Path("/tmp/cpo-plan.sh").write_text(plan)
Path("/tmp/cpo-run-prompt.sh").write_text(run_prompt)
Path("/tmp/cpo-review-prompt.sh").write_text(review_prompt)
Path("/tmp/cpo-push.sh").write_text(push)
Path("/tmp/cpo-owner.sh").write_text(resolve)
PY

bash -n /tmp/cpo-plan.sh
bash -n /tmp/cpo-run-prompt.sh
bash -n /tmp/cpo-review-prompt.sh
bash -n /tmp/cpo-push.sh
bash -n /tmp/cpo-owner.sh

mock=$(mktemp -d)
cat > "$mock/gh" << 'EOF'
#!/usr/bin/env bash
joined="$*"
if [[ -n "${MOCK_LOG:-}" ]]; then
  printf '%s\n' "$joined" >> "$MOCK_LOG"
fi
if [[ "$joined" == *"/commits/"* ]]; then
  if [[ "${MOCK_BOT:-}" == "1" ]]; then
    printf '%s\n' 'claude-bot@users.noreply.github.com'
  else
    printf '%s\n' 'dev@example.com'
  fi
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "list" ]]; then
  if [[ "${MOCK_GH_FAIL:-0}" == "1" ]]; then
    echo "gh: simulated failure" >&2
    exit 1
  fi
  filter=.
  while (($#)); do
    if [[ "$1" == "--jq" ]]; then
      filter="$2"
    fi
    shift
  done
  if [[ -n "${MOCK_PRS:-}" ]]; then
    pulls="$MOCK_PRS"
  else
    pulls=$(jq -nc --arg author "${MOCK_AUTHOR-abnegate}" '
      [
        {number: 86, author: {login: "fork-user"}, headRefOid: "dddddddddddddddddddddddddddddddddddddddd", isCrossRepository: true},
        {number: 87, author: {login: "other-user"}, headRefOid: "cccccccccccccccccccccccccccccccccccccccc", isCrossRepository: false}
      ] + if $author == "" then [] else [{number: 88, author: {login: $author}, headRefOid: "dddddddddddddddddddddddddddddddddddddddd", isCrossRepository: false}] end')
  fi
  jq -r "$filter" <<<"$pulls"
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "view" ]]; then
  printf '%s\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "comment" ]]; then
  exit 0
fi
echo "unexpected gh: $*" >&2
exit 1
EOF
chmod +x "$mock/gh"

cat > "$mock/git" << 'EOF'
#!/usr/bin/env bash
if [[ "$1" == "rev-parse" && "$2" == "HEAD" ]]; then
  printf '%s\n' 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  exit 0
fi
if [[ "$1" == "rev-parse" ]]; then
  printf '%s\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  exit 0
fi
if [[ "$1" == "push" ]]; then
  exit 0
fi
echo "unexpected git: $*" >&2
exit 1
EOF
chmod +x "$mock/git"

mock_log="$mock/calls.log"
empty_object='{}'
run_sha=dddddddddddddddddddddddddddddddddddddddd
other_sha=cccccccccccccccccccccccccccccccccccccccc
unknown_sha=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

run_plan() {
  local outfile rc
  outfile=$(mktemp)
  set +e
  env PATH="$mock:$PATH" GITHUB_OUTPUT="$outfile" \
    REPO=acme/app \
    EVENT_NAME="${EVENT_NAME:-pull_request}" \
    PR_HEAD_REF="${PR_HEAD_REF:-feature/review-mode}" \
    PR_HEAD_SHA="${PR_HEAD_SHA:-abc123}" \
    PR_BASE_REF="${PR_BASE_REF:-main}" \
    PR_NUMBER="${PR_NUMBER:-42}" \
    PR_HEAD_REPO_FULL="${PR_HEAD_REPO_FULL:-acme/app}" \
    PR_ASSOC="${PR_ASSOC:-OWNER}" \
    REVIEW_USER="${REVIEW_USER:-}" \
    REVIEW_ID="${REVIEW_ID:-}" \
    COMMENT_ASSOC="${COMMENT_ASSOC:-}" \
    COMMENT_BODY="${COMMENT_BODY:-}" \
    ISSUE_NUMBER="${ISSUE_NUMBER:-}" \
    ISSUE_PR_URL="${ISSUE_PR_URL:-}" \
    ISSUE_TITLE="${ISSUE_TITLE:-}" \
    ISSUE_BODY="${ISSUE_BODY:-}" \
    ISSUE_ASSOC="${ISSUE_ASSOC:-}" \
    WR_CONCLUSION="${WR_CONCLUSION:-}" \
    WR_EVENT="${WR_EVENT:-}" \
    WR_HEAD_BRANCH="${WR_HEAD_BRANCH:-}" \
    WR_HEAD_REPO_FULL="${WR_HEAD_REPO_FULL:-}" \
    WR_HEAD_SHA="${WR_HEAD_SHA:-}" \
    WR_ID="${WR_ID:-}" \
    IMPROVEMENT_ENABLED="${IMPROVEMENT_ENABLED:-true}" \
    HEALING_ENABLED="${HEALING_ENABLED:-true}" \
    BOTS_ENABLED="${BOTS_ENABLED:-true}" \
    COMMENTS_ENABLED="${COMMENTS_ENABLED:-true}" \
    REVIEW_ENABLED="${REVIEW_ENABLED:-false}" \
    BOT_ALLOWLIST="${BOT_ALLOWLIST:-coderabbitai[bot],greptile-apps[bot],greptileai[bot],codex[bot],copilot-*,github-copilot*}" \
    TRUSTED_ASSOCS="${TRUSTED_ASSOCS:-OWNER,MEMBER,COLLABORATOR}" \
    SEVERITIES="${SEVERITIES-critical,high}" \
    OWNER="${OWNER:-}" \
    MODEL="${MODEL:-claude-opus-5-5}" \
    VARS_JSON="${VARS_JSON-$empty_object}" \
    HAS_OAUTH="${HAS_OAUTH:-true}" \
    HAS_API_KEY="${HAS_API_KEY:-false}" \
    MOCK_BOT="${MOCK_BOT:-0}" \
    MOCK_AUTHOR="${MOCK_AUTHOR-abnegate}" \
    MOCK_PRS="${MOCK_PRS:-}" \
    MOCK_GH_FAIL="${MOCK_GH_FAIL:-0}" \
    MOCK_LOG="$mock_log" \
    bash /tmp/cpo-plan.sh > /tmp/cpo-plan.out
  rc=$?
  set -e
  PLAN_OUT=$(cat "$outfile" 2>/dev/null || true)
  rm -f "$outfile"
  return "$rc"
}

run_owner() {
  local outfile rc
  outfile=$(mktemp)
  set +e
  env PATH="$mock:$PATH" GITHUB_OUTPUT="$outfile" \
    GH_TOKEN=test-token \
    REPO=acme/app \
    EVENT_NAME="${EVENT_NAME:-pull_request}" \
    PR_AUTHOR="${PR_AUTHOR:-}" \
    ISSUE_USER="${ISSUE_USER:-}" \
    WR_CONCLUSION="${WR_CONCLUSION:-}" \
    WR_EVENT="${WR_EVENT:-}" \
    WR_HEAD_BRANCH="${WR_HEAD_BRANCH:-}" \
    WR_HEAD_REPO_FULL="${WR_HEAD_REPO_FULL:-}" \
    WR_HEAD_SHA="${WR_HEAD_SHA:-}" \
    VARS_JSON="${VARS_JSON-$empty_object}" \
    MOCK_AUTHOR="${MOCK_AUTHOR-abnegate}" \
    MOCK_PRS="${MOCK_PRS:-}" \
    MOCK_GH_FAIL="${MOCK_GH_FAIL:-0}" \
    MOCK_LOG="$mock_log" \
    bash -e /tmp/cpo-owner.sh > /tmp/cpo-owner.out 2> /tmp/cpo-owner.err
  rc=$?
  set -e
  OWNER_OUT=$(cat "$outfile" 2>/dev/null || true)
  rm -f "$outfile"
  return "$rc"
}

run_push() {
  local rc
  set +e
  env PATH="$mock:$PATH" \
    GH_TOKEN=test-token \
    REPO=acme/app \
    PR_NUMBER=42 \
    HEAD_BRANCH=feature/review-mode \
    APPLIED=improvement \
    HAS_PUSH_TOKEN="${HAS_PUSH_TOKEN:-false}" \
    OWNER="${OWNER:-}" \
    KEY="${KEY:-}" \
    bash -e /tmp/cpo-push.sh > /tmp/cpo-push.out
  rc=$?
  set -e
  return "$rc"
}

expect_in() {
  local label="$1" output="$2" key="$3" want="$4"
  local got
  got=$(awk -F= -v k="$key" '$1==k { sub(/^[^=]*=/,""); print; found=1; exit } END { if (!found) exit 1 }' <<<"$output") \
    || fail "$label $key: missing from outputs"
  [[ "$got" == "$want" ]] || fail "$label $key: got '$got' want '$want'"
}

expect_output() {
  expect_in plan "$PLAN_OUT" "$@"
}

expect_owner() {
  expect_in owner "$OWNER_OUT" "$@"
}

expect_stdout() {
  local file="$1" text="$2"
  grep -qF -- "$text" "$file" || fail "$file does not contain '$text'; it has: $(cat "$file")"
}

expect_line() {
  local file="$1" line="$2"
  grep -qxF -- "$line" "$file" || fail "$file has no line '$line'; it has: $(cat "$file")"
}

expect_no_line_starting() {
  local file="$1" prefix="$2"
  if awk -v prefix="$prefix" 'index($0, prefix) == 1 { found = 1 } END { exit !found }' "$file"; then
    fail "$file has a line starting with '$prefix': $(cat "$file")"
  fi
}

expect_no_gh_calls() {
  if [[ -s "$mock_log" ]]; then
    fail "expected no gh calls, got: $(cat "$mock_log")"
  fi
}

expect_not_enrolled_owner() {
  expect_owner login "$1"
  expect_owner enrolled false
  expect_owner oauth_secret ''
  expect_owner api_key_secret ''
  expect_owner push_secret ''
}

vars_for() {
  jq -nc --arg name "$1" --arg value "$2" '{($name): $value}'
}

reset_event() {
  EVENT_NAME=pull_request
  PR_HEAD_REF=
  PR_HEAD_SHA=
  PR_BASE_REF=
  PR_NUMBER=
  PR_HEAD_REPO_FULL=acme/app
  PR_ASSOC=OWNER
  PR_AUTHOR=
  REVIEW_USER=
  REVIEW_ID=
  COMMENT_ASSOC=
  COMMENT_BODY=
  ISSUE_NUMBER=
  ISSUE_PR_URL=
  ISSUE_TITLE=
  ISSUE_BODY=
  ISSUE_ASSOC=
  ISSUE_USER=
  WR_CONCLUSION=
  WR_EVENT=
  WR_HEAD_BRANCH=
  WR_HEAD_REPO_FULL=
  WR_HEAD_SHA=
  WR_ID=
  IMPROVEMENT_ENABLED=true
  HEALING_ENABLED=true
  BOTS_ENABLED=true
  COMMENTS_ENABLED=true
  REVIEW_ENABLED=false
  SEVERITIES=critical,high
  OWNER=
  KEY=
  MODEL=claude-opus-5-5
  VARS_JSON='{}'
  HAS_OAUTH=true
  HAS_API_KEY=false
  HAS_PUSH_TOKEN=false
  MOCK_BOT=0
  MOCK_AUTHOR=abnegate
  MOCK_PRS=
  MOCK_GH_FAIL=0
  : > "$mock_log"
}

reset_event
run_plan
expect_output tasks '["improvement"]'
expect_output review false
expect_output severities 'critical, high'
expect_output owner ''
expect_output key ''
expect_output model claude-opus-5-5
expect_output fallback_arguments '--fallback-model claude-sonnet-4-6'

reset_event
REVIEW_ENABLED=true
run_plan
expect_output tasks '["improvement"]'
expect_output review true

reset_event
IMPROVEMENT_ENABLED=false
REVIEW_ENABLED=true
run_plan
expect_output tasks '[]'
expect_output review true
expect_output branch feature/review-mode

reset_event
REVIEW_ENABLED=true
MOCK_BOT=1
run_plan
expect_output tasks '[]'
expect_output review false
grep -q 'skipping improvement and review' /tmp/cpo-plan.out || fail 'bot commit was not skipped'

reset_event
REVIEW_ENABLED=true
PR_ASSOC=CONTRIBUTOR
run_plan
expect_output tasks '[]'
expect_output review false

reset_event
REVIEW_ENABLED=true
PR_HEAD_REPO_FULL=fork/app
run_plan
expect_output tasks '[]'
expect_output review false

reset_event
EVENT_NAME=pull_request_review
REVIEW_USER='coderabbitai[bot]'
REVIEW_ID=9
run_plan
expect_output tasks '["bots"]'
expect_output review false

reset_event
EVENT_NAME=pull_request_review
REVIEW_USER='copilot-pull-request-reviewer[bot]'
REVIEW_ID=9
run_plan
expect_output tasks '["bots"]'

reset_event
EVENT_NAME=pull_request_review
REVIEW_USER='coderabbitaib'
REVIEW_ID=9
run_plan
expect_output tasks '[]'

reset_event
EVENT_NAME=workflow_run
WR_CONCLUSION=failure
WR_EVENT=pull_request
WR_HEAD_REPO_FULL=acme/app
WR_HEAD_BRANCH=feature/review-mode
WR_HEAD_SHA="$run_sha"
WR_ID=77
run_plan
expect_output tasks '["healing"]'
expect_output review false
expect_output pr_number 88
expect_output head_sha "$run_sha"
expect_output branch feature/review-mode
expect_stdout "$mock_log" '--json number,headRefOid,isCrossRepository'

reset_event
EVENT_NAME=workflow_run
WR_CONCLUSION=failure
WR_EVENT=pull_request
WR_HEAD_REPO_FULL=acme/app
WR_HEAD_BRANCH=feature/review-mode
WR_HEAD_SHA="$other_sha"
WR_ID=77
run_plan
expect_output tasks '["healing"]'
expect_output pr_number 87
expect_output head_sha "$other_sha"

for variant in unknown fork; do
  reset_event
  EVENT_NAME=workflow_run
  WR_CONCLUSION=failure
  WR_EVENT=pull_request
  WR_HEAD_REPO_FULL=acme/app
  WR_HEAD_BRANCH=feature/review-mode
  WR_HEAD_SHA="$run_sha"
  WR_ID=77
  case "$variant" in
    unknown) WR_HEAD_SHA="$unknown_sha" ;;
    fork) MOCK_AUTHOR= ;;
  esac
  run_plan || fail "plan failed when no same-repository pull request is at the run's head ($variant)"
  expect_output tasks '[]'
  expect_output pr_number ''
  expect_output head_sha ''
  expect_output failed_run_id ''
done

reset_event
SEVERITIES='high, CRITICAL'
run_plan
expect_output severities 'critical, high'

reset_event
SEVERITIES='low,medium,high,critical'
run_plan
expect_output severities 'critical, high, medium, low'

for bad in '' ',,' 'critical,nit'; do
  reset_event
  SEVERITIES="$bad"
  if run_plan; then
    fail "severities '$bad' should have failed"
  fi
done

reset_event
MODEL=claude-sonnet-4-6
run_plan
expect_output model claude-sonnet-4-6
expect_output owner ''
expect_output fallback_arguments ''

reset_event
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{"improvement":false,"review":true,"model":"claude-sonnet-4-6","severities":"low"}')
run_plan
expect_output tasks '["improvement"]'
expect_output review false
expect_output severities 'critical, high'
expect_output model claude-opus-5-5
expect_output owner ''

reset_event
HAS_OAUTH=false
HAS_API_KEY=false
run_plan || fail 'legacy mode must leave the auth check to the Require an auth secret step'
expect_output tasks '["improvement"]'

reset_event
OWNER=abnegate
HAS_OAUTH=false
run_plan || fail 'an owner who is not enrolled must not fail the plan'
expect_output tasks '[]'
expect_output review false
expect_output branch ''
expect_output pr_number ''
expect_output head_sha ''
expect_output base_ref ''
expect_output owner abnegate
expect_output key ABNEGATE
expect_output model claude-opus-5-5
expect_output fallback_arguments '--fallback-model claude-sonnet-4-6'
expect_stdout /tmp/cpo-plan.out '@abnegate is not enrolled in ureview (no UREVIEW_ABNEGATE variable); skipping.'

reset_event
OWNER=abnegate
VARS_JSON=$(vars_for UREVIEW_OTHER '{"improvement":true}')
run_plan
expect_output tasks '[]'
expect_output branch ''
expect_stdout /tmp/cpo-plan.out 'is not enrolled in ureview'

reset_event
OWNER=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{"review":true,"comments":true,"improvement":false,"healing":false,"bots":false}')
run_plan
expect_output tasks '[]'
expect_output review true
expect_output branch feature/review-mode
expect_output pr_number 42
expect_output head_sha abc123
expect_output base_ref main
expect_output owner abnegate
expect_stdout /tmp/cpo-plan.out 'owner=abnegate model=claude-opus-5-5'

reset_event
OWNER=some-user
VARS_JSON=$(vars_for UREVIEW_SOME_USER '{"improvement":true}')
run_plan
expect_output tasks '["improvement"]'
expect_output review false
expect_output branch feature/review-mode
expect_output owner some-user
expect_output key SOME_USER

reset_event
OWNER=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{"improvement":true,"severities":"low,CRITICAL","model":"claude-sonnet-4-6"}')
run_plan
expect_output tasks '["improvement"]'
expect_output severities 'critical, low'
expect_output model claude-sonnet-4-6
expect_output fallback_arguments ''
expect_stdout /tmp/cpo-plan.out 'owner=abnegate model=claude-sonnet-4-6'

for model in 'claude-opus-4-6[1m]' 'claude-sonnet-4-6[1m]' 'claude-3.5_x[beta2]'; do
  reset_event
  OWNER=abnegate
  VARS_JSON=$(vars_for UREVIEW_ABNEGATE "$(jq -nc --arg model "$model" '{improvement: true, model: $model}')")
  run_plan || fail "model '$model' should have been accepted"
  expect_output model "$model"
  expect_output fallback_arguments '--fallback-model claude-sonnet-4-6'
done

reset_event
OWNER=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{"improvement":true,"severities":"","model":""}')
run_plan
expect_output severities 'critical, high'
expect_output model claude-opus-5-5

reset_event
OWNER=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{"improvement":true}')
HAS_OAUTH=false
HAS_API_KEY=false
if run_plan; then
  fail 'an enrolled owner without a token should fail when a task is planned'
fi
expect_stdout /tmp/cpo-plan.out '::error::@abnegate is enrolled in ureview but neither UREVIEW_OAUTH_TOKEN_ABNEGATE nor UREVIEW_API_KEY_ABNEGATE is set. See https://github.com/abnegate/claude-pr-owner#per-user-mode'

reset_event
OWNER=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{"improvement":true}')
HAS_OAUTH=false
HAS_API_KEY=true
run_plan || fail 'an API key alone should satisfy the owner auth check'
expect_output tasks '["improvement"]'

reset_event
OWNER=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{"improvement":false,"review":false}')
HAS_OAUTH=false
run_plan || fail 'nothing enabled for the event must not fail the plan'
expect_output tasks '[]'
expect_output review false
expect_output branch ''
expect_output pr_number ''
expect_stdout /tmp/cpo-plan.out '@abnegate has no ureview task enabled for this event; skipping.'

reset_event
OWNER=abnegate
EVENT_NAME=push
HAS_OAUTH=false
run_plan || fail 'an event with nothing planned must not fail the plan'
expect_output tasks '[]'
expect_output review false

reset_event
OWNER=abnegate
VARS_JSON=$(vars_for ureview_abnegate '{"improvement":false,"review":true}')
run_plan
expect_output tasks '[]'
expect_output review true

reset_event
OWNER=AbNegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{"improvement":false,"review":true}')
run_plan
expect_output tasks '[]'
expect_output review true
expect_output owner AbNegate
expect_output key ABNEGATE

for bad in '{not json' '[]' '"text"' 'true'; do
  reset_event
  OWNER=abnegate
  VARS_JSON=$(vars_for UREVIEW_ABNEGATE "$bad")
  if run_plan; then
    fail "variable '$bad' should have failed"
  fi
  expect_stdout /tmp/cpo-plan.out '::error::UREVIEW_ABNEGATE must be a JSON object.'
done

for bad in 'claude opus' '-claude' 'claude;rm' '.claude' 'claude[' 'claude[]' 'claude[1m]x' 'claude[1m][2m]' 'claude[1 m]' '[1m]' 'claude[1-m]'; do
  reset_event
  OWNER=abnegate
  VARS_JSON=$(vars_for UREVIEW_ABNEGATE "$(jq -nc --arg model "$bad" '{improvement: true, model: $model}')")
  if run_plan; then
    fail "model '$bad' should have failed"
  fi
  expect_stdout /tmp/cpo-plan.out "::error::UREVIEW_ABNEGATE model '$bad' is not a valid model id."
done

reset_event
OWNER=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE "$(jq -nc '{improvement: true, model: "claude\n::error::injected"}')")
if run_plan; then
  fail 'a model with a newline should have failed'
fi
expect_line /tmp/cpo-plan.out "::error::UREVIEW_ABNEGATE model 'claude ::error::injected' is not a valid model id."
expect_no_line_starting /tmp/cpo-plan.out '::error::injected'

reset_event
OWNER=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{"improvement":true,"severities":"critical,nit"}')
if run_plan; then
  fail 'an invalid owner severities value should have failed'
fi

long_login=$(printf 'a%.0s' {1..40})
for bad in 'bad login!' 'dependabot[bot]' "$long_login"; do
  reset_event
  OWNER="$bad"
  if run_plan; then
    fail "owner '$bad' should have failed"
  fi
  expect_stdout /tmp/cpo-plan.out "::error::owner '$bad' is not a GitHub login."
done

reset_event
OWNER=$'abnegate\n::error::injected'
if run_plan; then
  fail 'an owner with a newline should have failed'
fi
expect_line /tmp/cpo-plan.out "::error::owner 'abnegate ::error::injected' is not a GitHub login."
expect_no_line_starting /tmp/cpo-plan.out '::error::injected'

reset_event
OWNER=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{"review":true}')
IMPROVEMENT_ENABLED=false
run_plan
expect_output tasks '[]'
expect_output review true

reset_event
OWNER=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{"review":true}')
IMPROVEMENT_ENABLED=true
run_plan
expect_output tasks '["improvement"]'
expect_output review true

reset_event
OWNER=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{}')
REVIEW_ENABLED=false
run_plan
expect_output tasks '["improvement"]'
expect_output review false

reset_event
OWNER=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{"improvement":"true"}')
IMPROVEMENT_ENABLED=false
run_plan
expect_output tasks '["improvement"]'

reset_event
OWNER=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{"improvement":"false","review":"true"}')
run_plan
expect_output tasks '[]'
expect_output review true

reset_event
OWNER=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{"improvement":1,"review":true}')
IMPROVEMENT_ENABLED=false
run_plan
expect_output tasks '[]'
expect_output review true

reset_event
OWNER=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{"improvement":true,"review":true}')
MOCK_BOT=1
run_plan
expect_output tasks '[]'
expect_output review false
expect_stdout /tmp/cpo-plan.out 'skipping improvement and review'

reset_event
OWNER=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{"improvement":true,"review":true}')
PR_ASSOC=CONTRIBUTOR
run_plan
expect_output tasks '[]'
expect_output review false

reset_event
OWNER=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{"improvement":true,"review":true}')
PR_HEAD_REPO_FULL=fork/app
run_plan
expect_output tasks '[]'
expect_output review false

reset_event
OWNER=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{"bots":false}')
EVENT_NAME=pull_request_review
REVIEW_USER='coderabbitai[bot]'
REVIEW_ID=9
run_plan
expect_output tasks '[]'
expect_output review_id ''
expect_output reviewer ''

reset_event
OWNER=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{"bots":true}')
BOTS_ENABLED=false
EVENT_NAME=pull_request_review
REVIEW_USER='coderabbitai[bot]'
REVIEW_ID=9
run_plan
expect_output tasks '["bots"]'
expect_output review_id 9
expect_output reviewer 'coderabbitai[bot]'

reset_event
OWNER=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{"bots":true}')
EVENT_NAME=pull_request_review
REVIEW_USER='coderabbitaib'
REVIEW_ID=9
run_plan
expect_output tasks '[]'

for healing in true false; do
  reset_event
  OWNER=abnegate
  VARS_JSON=$(vars_for UREVIEW_ABNEGATE "{\"healing\":$healing}")
  HEALING_ENABLED=false
  EVENT_NAME=workflow_run
  WR_CONCLUSION=failure
  WR_EVENT=pull_request
  WR_HEAD_REPO_FULL=acme/app
  WR_HEAD_BRANCH=feature/review-mode
  WR_HEAD_SHA="$run_sha"
  WR_ID=77
  run_plan
  if [[ "$healing" == "true" ]]; then
    expect_output tasks '["healing"]'
    expect_output pr_number 88
    expect_output head_sha "$run_sha"
    expect_output failed_run_id 77
  else
    expect_output tasks '[]'
    expect_output pr_number ''
    expect_output failed_run_id ''
  fi
done

for comments in true false; do
  reset_event
  OWNER=abnegate
  VARS_JSON=$(vars_for UREVIEW_ABNEGATE "{\"comments\":$comments}")
  COMMENTS_ENABLED=false
  EVENT_NAME=issue_comment
  COMMENT_ASSOC=OWNER
  COMMENT_BODY='@claude please fix this'
  ISSUE_NUMBER=42
  run_plan
  if [[ "$comments" == "true" ]]; then
    expect_output tasks '["comments"]'
    expect_output pr_number 42
  else
    expect_output tasks '[]'
    expect_output pr_number ''
  fi
done

reset_event
OWNER=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{"comments":true}')
EVENT_NAME=issues
ISSUE_ASSOC=OWNER
ISSUE_TITLE='@claude add a changelog'
ISSUE_NUMBER=5
run_plan
expect_output tasks '["comments"]'
expect_output pr_number 5

for owner in '' abnegate; do
  reset_event
  OWNER="$owner"
  VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{"comments":true}')
  EVENT_NAME=pull_request_review_comment
  PR_HEAD_REF=feature/review-mode
  PR_HEAD_SHA=abc123
  PR_BASE_REF=main
  PR_NUMBER=42
  COMMENT_ASSOC=OWNER
  COMMENT_BODY='@claude please fix this'
  run_plan
  expect_output tasks '["comments"]'
  expect_output branch feature/review-mode
  expect_output pr_number 42
  expect_no_gh_calls
done

for event in pull_request pull_request_review pull_request_review_comment; do
  reset_event
  EVENT_NAME="$event"
  PR_AUTHOR=abnegate
  ISSUE_USER=someone-else
  VARS_JSON=$(jq -nc '{UREVIEW_ABNEGATE: "{}", UREVIEW_SOMEONE_ELSE: "{}"}')
  run_owner || fail "owner.yml failed on $event"
  expect_owner login abnegate
  expect_owner enrolled true
  expect_owner oauth_secret UREVIEW_OAUTH_TOKEN_ABNEGATE
  expect_owner api_key_secret UREVIEW_API_KEY_ABNEGATE
  expect_owner push_secret UREVIEW_PUSH_TOKEN_ABNEGATE
  expect_line /tmp/cpo-owner.out '@abnegate is enrolled in ureview.'
  expect_no_gh_calls
done

for event in issue_comment issues; do
  reset_event
  EVENT_NAME="$event"
  ISSUE_USER=abnegate
  PR_AUTHOR=someone-else
  VARS_JSON=$(jq -nc '{UREVIEW_ABNEGATE: "{}", UREVIEW_SOMEONE_ELSE: "{}"}')
  run_owner || fail "owner.yml failed on $event"
  expect_owner login abnegate
  expect_owner enrolled true
  expect_owner oauth_secret UREVIEW_OAUTH_TOKEN_ABNEGATE
  expect_owner api_key_secret UREVIEW_API_KEY_ABNEGATE
  expect_owner push_secret UREVIEW_PUSH_TOKEN_ABNEGATE
  expect_no_gh_calls
done

reset_event
PR_AUTHOR=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{}')
run_owner
[[ "$(cut -d= -f1 <<<"$OWNER_OUT" | paste -sd, -)" == 'login,enrolled,oauth_secret,api_key_secret,push_secret' ]] \
  || fail "owner.yml outputs are not login, enrolled, oauth_secret, api_key_secret, push_secret in order: $OWNER_OUT"

reset_event
PR_AUTHOR=some-user
VARS_JSON=$(vars_for UREVIEW_SOME_USER '{}')
run_owner
expect_owner login some-user
expect_owner enrolled true
expect_owner oauth_secret UREVIEW_OAUTH_TOKEN_SOME_USER
expect_owner api_key_secret UREVIEW_API_KEY_SOME_USER
expect_owner push_secret UREVIEW_PUSH_TOKEN_SOME_USER

reset_event
PR_AUTHOR=AbNegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{}')
run_owner
expect_owner login AbNegate
expect_owner enrolled true
expect_owner oauth_secret UREVIEW_OAUTH_TOKEN_ABNEGATE

reset_event
PR_AUTHOR=abnegate
VARS_JSON=$(vars_for ureview_abnegate '{"review":true}')
run_owner
expect_owner enrolled true
expect_owner oauth_secret UREVIEW_OAUTH_TOKEN_ABNEGATE

reset_event
PR_AUTHOR=abnegate
VARS_JSON=$(vars_for UREVIEW_OTHER '{}')
run_owner || fail 'owner.yml must not fail for an owner who is not enrolled'
expect_not_enrolled_owner abnegate
expect_line /tmp/cpo-owner.out '@abnegate is not enrolled in ureview (no UREVIEW_ABNEGATE variable); skipping.'

reset_event
PR_AUTHOR=abnegate
VARS_JSON=
run_owner || fail 'owner.yml must treat an empty VARS_JSON as no variables'
expect_not_enrolled_owner abnegate

reset_event
EVENT_NAME=workflow_run
WR_CONCLUSION=failure
WR_EVENT=pull_request
WR_HEAD_REPO_FULL=acme/app
WR_HEAD_BRANCH=feature/review-mode
WR_HEAD_SHA="$run_sha"
MOCK_AUTHOR=some-user
VARS_JSON=$(vars_for UREVIEW_SOME_USER '{}')
run_owner
expect_owner login some-user
expect_owner enrolled true
expect_owner oauth_secret UREVIEW_OAUTH_TOKEN_SOME_USER
expect_stdout "$mock_log" 'pr list'
expect_stdout "$mock_log" '--repo acme/app'
expect_stdout "$mock_log" '--head feature/review-mode'
expect_stdout "$mock_log" '--state open'
expect_stdout "$mock_log" '--json author,headRefOid,isCrossRepository'

reset_event
EVENT_NAME=workflow_run
WR_CONCLUSION=failure
WR_EVENT=pull_request
WR_HEAD_REPO_FULL=acme/app
WR_HEAD_BRANCH=feature/review-mode
WR_HEAD_SHA="$other_sha"
VARS_JSON=$(jq -nc '{UREVIEW_ABNEGATE: "{}", UREVIEW_OTHER_USER: "{}", UREVIEW_FORK_USER: "{}"}')
run_owner
expect_owner login other-user
expect_owner enrolled true
expect_owner oauth_secret UREVIEW_OAUTH_TOKEN_OTHER_USER

reset_event
EVENT_NAME=workflow_run
WR_CONCLUSION=failure
WR_EVENT=pull_request
WR_HEAD_REPO_FULL=acme/app
WR_HEAD_BRANCH=feature/review-mode
WR_HEAD_SHA="$unknown_sha"
VARS_JSON=$(jq -nc '{UREVIEW_ABNEGATE: "{}", UREVIEW_OTHER_USER: "{}", UREVIEW_FORK_USER: "{}"}')
run_owner || fail 'owner.yml must not fail when no pull request is at the run head'
expect_not_enrolled_owner ''
expect_line /tmp/cpo-owner.out 'Could not resolve a ureview owner for this event; skipping.'
if grep -q '::warning::' /tmp/cpo-owner.out; then
  fail "owner.yml warned when no pull request is at the run head: $(cat /tmp/cpo-owner.out)"
fi

reset_event
EVENT_NAME=workflow_run
WR_CONCLUSION=failure
WR_EVENT=pull_request
WR_HEAD_REPO_FULL=acme/app
WR_HEAD_BRANCH=feature/review-mode
WR_HEAD_SHA="$run_sha"
MOCK_PRS=$(jq -nc --arg sha "$run_sha" '[
  {number: 88, author: {login: "abnegate"}, headRefOid: $sha, isCrossRepository: false},
  {number: 89, author: {login: "abnegate"}, headRefOid: $sha, isCrossRepository: false}
]')
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{}')
run_owner
expect_owner login abnegate
expect_owner enrolled true

reset_event
EVENT_NAME=workflow_run
WR_CONCLUSION=failure
WR_EVENT=pull_request
WR_HEAD_REPO_FULL=acme/app
WR_HEAD_BRANCH=feature/review-mode
WR_HEAD_SHA="$run_sha"
MOCK_PRS=$(jq -nc --arg sha "$run_sha" '[
  {number: 88, author: {login: "abnegate"}, headRefOid: $sha, isCrossRepository: false},
  {number: 89, author: {login: "other-user"}, headRefOid: $sha, isCrossRepository: false}
]')
VARS_JSON=$(jq -nc '{UREVIEW_ABNEGATE: "{}", UREVIEW_OTHER_USER: "{}"}')
run_owner || fail 'owner.yml must not fail when pull requests at the run head disagree on the author'
expect_not_enrolled_owner ''
expect_line /tmp/cpo-owner.out "::warning::Open pull requests at $run_sha have different authors (abnegate other-user), so the ureview owner is ambiguous."

for variant in success push fork; do
  reset_event
  EVENT_NAME=workflow_run
  WR_CONCLUSION=failure
  WR_EVENT=pull_request
  WR_HEAD_REPO_FULL=acme/app
  WR_HEAD_BRANCH=feature/review-mode
  WR_HEAD_SHA="$run_sha"
  case "$variant" in
    success) WR_CONCLUSION=success ;;
    push) WR_EVENT=push ;;
    fork) WR_HEAD_REPO_FULL=fork/app ;;
  esac
  VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{}')
  run_owner || fail "owner.yml failed on workflow_run $variant"
  expect_not_enrolled_owner ''
  expect_no_gh_calls
  expect_line /tmp/cpo-owner.out 'Could not resolve a ureview owner for this event; skipping.'
done

for variant in failing empty bot; do
  reset_event
  EVENT_NAME=workflow_run
  WR_CONCLUSION=failure
  WR_EVENT=pull_request
  WR_HEAD_REPO_FULL=acme/app
  WR_HEAD_BRANCH=feature/review-mode
  WR_HEAD_SHA="$run_sha"
  case "$variant" in
    failing) MOCK_GH_FAIL=1 ;;
    empty) MOCK_AUTHOR= ;;
    bot) MOCK_AUTHOR='dependabot[bot]' ;;
  esac
  VARS_JSON=$(jq -nc '{UREVIEW_ABNEGATE: "{}", UREVIEW_FORK_USER: "{}", "UREVIEW_DEPENDABOT[BOT]": "{}"}')
  run_owner || fail "owner.yml failed when the workflow_run author is $variant"
  expect_not_enrolled_owner ''
  expect_stdout "$mock_log" '--json author,headRefOid,isCrossRepository'
  if [[ "$variant" == "failing" ]]; then
    expect_line /tmp/cpo-owner.out '::warning::gh pr list failed, so the pull request for this workflow_run is unknown.'
  elif grep -q '::warning::' /tmp/cpo-owner.out; then
    fail "owner.yml warned when the workflow_run author is $variant: $(cat /tmp/cpo-owner.out)"
  fi
done

for author in 'dependabot[bot]' "$long_login" ''; do
  reset_event
  PR_AUTHOR="$author"
  VARS_JSON=$(jq -nc '{UREVIEW_ABNEGATE: "{}", "UREVIEW_DEPENDABOT[BOT]": "{}"}')
  run_owner || fail "owner.yml failed for pull_request author '$author'"
  expect_not_enrolled_owner ''
done

reset_event
EVENT_NAME=push
PR_AUTHOR=abnegate
ISSUE_USER=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{}')
run_owner || fail 'owner.yml must not fail on an unknown event'
expect_not_enrolled_owner ''
expect_no_gh_calls

legacy_warning="::warning::No push_token secret supplied; pushing with GITHUB_TOKEN. Downstream workflows (Tests, CodeQL, etc.) will NOT run on this commit. Set secrets.push_token to a PAT with contents:write to get CI coverage on Claude's pushes."

reset_event
run_push || fail 'push step failed without a push token'
expect_line /tmp/cpo-push.out "$legacy_warning"

reset_event
OWNER=some-user
KEY=SOME_USER
run_push || fail 'push step failed without an owner push token'
expect_line /tmp/cpo-push.out "::warning::No push token for @some-user; pushing with GITHUB_TOKEN. Downstream workflows (Tests, CodeQL, etc.) will NOT run on this commit. Set UREVIEW_PUSH_TOKEN_SOME_USER to a PAT with contents:write, or pass a shared push token, to get CI coverage on Claude's pushes."

for owner in '' some-user; do
  reset_event
  OWNER="$owner"
  HAS_PUSH_TOKEN=true
  run_push || fail "push step failed with a push token for owner '$owner'"
  if grep -q '::warning::' /tmp/cpo-push.out; then
    fail "push step warned although a push token was supplied for owner '$owner'"
  fi
done

compared_fields() {
  awk -F= '
    BEGIN { split("tasks review branch pr_number head_sha base_ref review_id reviewer failed_run_id severities", names, " "); for (i in names) wanted[names[i]] = 1 }
    $1 in wanted { print }
  ' <<<"$PLAN_OUT"
}

differential_event() {
  reset_event
  EVENT_NAME="$1"
  PR_HEAD_REF=feature/review-mode
  PR_HEAD_SHA=abc123
  PR_BASE_REF=main
  PR_NUMBER=42
  case "$1" in
    pull_request_review)
      REVIEW_USER='coderabbitai[bot]'
      REVIEW_ID=9
      ;;
    pull_request_review_comment)
      COMMENT_ASSOC=OWNER
      COMMENT_BODY='@claude please fix this'
      ;;
    issue_comment)
      PR_HEAD_REF=
      PR_HEAD_SHA=
      PR_BASE_REF=
      PR_NUMBER=
      COMMENT_ASSOC=OWNER
      COMMENT_BODY='@claude please fix this'
      ISSUE_NUMBER=42
      ISSUE_PR_URL=https://api.github.com/repos/acme/app/pulls/42
      ;;
    issues)
      PR_HEAD_REF=
      PR_HEAD_SHA=
      PR_BASE_REF=
      PR_NUMBER=
      ISSUE_ASSOC=OWNER
      ISSUE_TITLE='@claude add a changelog'
      ISSUE_NUMBER=5
      ;;
    workflow_run)
      PR_HEAD_REF=
      PR_HEAD_SHA=
      PR_BASE_REF=
      PR_NUMBER=
      WR_CONCLUSION=failure
      WR_EVENT=pull_request
      WR_HEAD_REPO_FULL=acme/app
      WR_HEAD_BRANCH=feature/review-mode
      WR_HEAD_SHA="$run_sha"
      WR_ID=77
      ;;
  esac
}

flag_value() {
  if (( $1 & $2 )); then echo true; else echo false; fi
}

for event in pull_request pull_request_review pull_request_review_comment issue_comment issues workflow_run; do
  planned=0
  for ((mask = 0; mask < 32; mask++)); do
    improvement=$(flag_value "$mask" 1)
    healing=$(flag_value "$mask" 2)
    bots=$(flag_value "$mask" 4)
    comments=$(flag_value "$mask" 8)
    review=$(flag_value "$mask" 16)

    differential_event "$event"
    IMPROVEMENT_ENABLED="$improvement"
    HEALING_ENABLED="$healing"
    BOTS_ENABLED="$bots"
    COMMENTS_ENABLED="$comments"
    REVIEW_ENABLED="$review"
    run_plan || fail "legacy plan failed on $event with mask $mask"
    legacy=$(compared_fields)

    differential_event "$event"
    OWNER=abnegate
    HAS_OAUTH=true
    VARS_JSON=$(printf '{"UREVIEW_ABNEGATE":"{\\"improvement\\":%s,\\"healing\\":%s,\\"bots\\":%s,\\"comments\\":%s,\\"review\\":%s}"}' \
      "$improvement" "$healing" "$bots" "$comments" "$review")
    IMPROVEMENT_ENABLED=true
    HEALING_ENABLED=true
    BOTS_ENABLED=true
    COMMENTS_ENABLED=true
    REVIEW_ENABLED=true
    run_plan || fail "per-user plan failed on $event with mask $mask"
    per_user=$(compared_fields)

    [[ "$(wc -l <<<"$legacy")" -eq 10 ]] || fail "legacy plan on $event with mask $mask is missing compared outputs: $legacy"
    [[ "$legacy" == "$per_user" ]] \
      || fail "$event with improvement=$improvement healing=$healing bots=$bots comments=$comments review=$review: legacy and per-user plans differ"$'\n'"legacy:"$'\n'"$legacy"$'\n'"per-user:"$'\n'"$per_user"
    if ! grep -qxF -e 'tasks=[]' <<<"$legacy" || grep -qxF 'review=true' <<<"$legacy"; then
      planned=$((planned + 1))
    fi
  done
  (( planned > 0 )) || fail "no flag combination planned anything on $event, so the comparison is hollow"
done

prompt_body() {
  local file="$1"
  local delim body
  delim=$(head -n 1 "$file" | sed 's/^prompt<<//')
  body=$(awk -v d="$delim" 'NR>1 && $0==d { exit } NR>1 { print }' "$file")
  printf '%s\n' "$body"
}

outfile=$(mktemp)
env REPO=acme/app PR_NUMBER=7 BASE_REF=main HEAD_BRANCH='feature/review-mode' HEAD_SHA=deadbeef \
  SEVERITIES='critical, high' GITHUB_OUTPUT="$outfile" bash /tmp/cpo-review-prompt.sh
body=$(prompt_body "$outfile")
grep -q 'Only comment on findings at these alert levels: critical, high.' <<<"$body" || fail 'review prompt missing severities'
grep -q '/code-review:code-review --comment acme/app/pull/7' <<<"$body" || fail 'review prompt missing command'
if grep -q '__SEVERITIES__' <<<"$body"; then
  fail 'review prompt left a placeholder'
fi
rm -f "$outfile"

outfile=$(mktemp)
env TASK=improvement REPO=acme/app PR_NUMBER=7 BASE_REF=main HEAD_BRANCH='feature/review-mode' HEAD_SHA=deadbeef \
  SEVERITIES='critical, high' REVIEWER= REVIEW_ID= FAILED_RUN_ID= CR_BODY= IS_BODY= IS_TITLE= \
  GITHUB_OUTPUT="$outfile" bash /tmp/cpo-run-prompt.sh
body=$(prompt_body "$outfile")
grep -q 'fix findings at these alert levels only: critical, high.' <<<"$body" || fail 'improvement prompt missing severities'
if grep -q '__SEVERITIES__' <<<"$body"; then
  fail 'improvement prompt left a placeholder'
fi
rm -f "$outfile"

outfile=$(mktemp)
env TASK=bots REPO=acme/app PR_NUMBER=7 BASE_REF=main HEAD_BRANCH='feature/review-mode' HEAD_SHA=deadbeef \
  SEVERITIES='critical, high' REVIEWER='coderabbitai[bot]' REVIEW_ID=9 FAILED_RUN_ID= \
  CR_BODY= IS_BODY= IS_TITLE= GITHUB_OUTPUT="$outfile" bash /tmp/cpo-run-prompt.sh
body=$(prompt_body "$outfile")
grep -q 'Address only these alert levels: critical, high.' <<<"$body" || fail 'bots prompt missing severities'
rm -f "$outfile"

python3 - << 'PY'
import re
import sys
import yaml
from pathlib import Path

problems = []

def check(condition, message):
    if not condition:
        problems.append(message)

def expression(value):
    text = str(value or "").strip()
    match = re.fullmatch(r"\$\{\{\s*(.*?)\s*\}\}", text)
    return match.group(1) if match else text

legacy_auth = (
    'if [[ "$HAS_OAUTH" != "true" && "$HAS_API_KEY" != "true" ]]; then\n'
    '  echo "::error::claude-pr-owner requires either secrets.oauth_token or secrets.api_key."\n'
    '  exit 1\n'
    'fi\n'
)

orchestrator = yaml.safe_load(Path(".github/workflows/orchestrator.yml").read_text())
inputs = orchestrator[True]["workflow_call"]["inputs"]
owner_input = inputs.get("owner") or {}
check(owner_input.get("type") == "string", "orchestrator owner input is not type: string")
check(owner_input.get("default") == "", "orchestrator owner input does not default to ''")
check("per_user" not in inputs, "orchestrator still declares a per_user input")
names = list(inputs)
if "owner" in names and "severities" in names:
    check(names.index("owner") == names.index("severities") + 1, "orchestrator owner input does not follow severities")

plan_job = orchestrator["jobs"]["plan"]
steps = plan_job["steps"]
auth = next((step for step in steps if step.get("name") == "Require an auth secret"), None)
check(auth is not None, "Require an auth secret step is missing")
if auth is not None:
    check(steps.index(auth) == 0, "Require an auth secret is no longer the first plan step")
    check(expression(auth.get("if")) == "inputs.owner == ''", f"Require an auth secret if is {auth.get('if')!r}, want inputs.owner == ''")
    check(auth.get("run") == legacy_auth, "Require an auth secret body changed")
    check(auth.get("env") == {
        "HAS_OAUTH": "${{ secrets.oauth_token != '' }}",
        "HAS_API_KEY": "${{ secrets.api_key != '' }}",
    }, "Require an auth secret env changed")

plan_step = next(step for step in steps if step.get("id") == "plan")
plan_env = plan_step.get("env") or {}
for key, want in {
    "OWNER": "${{ inputs.owner }}",
    "MODEL": "${{ inputs.model }}",
    "VARS_JSON": "${{ inputs.owner != '' && toJSON(vars) || '{}' }}",
    "HAS_OAUTH": "${{ secrets.oauth_token != '' }}",
    "HAS_API_KEY": "${{ secrets.api_key != '' }}",
}.items():
    check(plan_env.get(key) == want, f"Decide tasks env {key} is {plan_env.get(key)!r}, want {want!r}")
for key in ("owner", "key", "model", "fallback_arguments"):
    got = (plan_job.get("outputs") or {}).get(key)
    check(got == f"${{{{ steps.plan.outputs.{key} }}}}", f"plan job output {key} is {got!r}")

owner_workflow = yaml.safe_load(Path(".github/workflows/owner.yml").read_text())
call = owner_workflow[True]["workflow_call"]
check("secrets" not in call, "owner.yml declares workflow_call secrets")
outputs = call.get("outputs") or {}
output_names = ["login", "enrolled", "oauth_secret", "api_key_secret", "push_secret"]
check(list(outputs) == output_names, f"owner.yml outputs are {list(outputs)}, want {output_names}")
resolve = owner_workflow["jobs"]["resolve"]
check(resolve.get("permissions") == {"pull-requests": "read"},
      f"owner.yml resolve permissions are {resolve.get('permissions')!r}, want pull-requests: read only")
for name in output_names:
    value = (outputs.get(name) or {}).get("value")
    check(value == f"${{{{ jobs.resolve.outputs.{name} }}}}", f"owner.yml output {name} value is {value!r}")
    job_value = (resolve.get("outputs") or {}).get(name)
    check(job_value == f"${{{{ steps.owner.outputs.{name} }}}}", f"owner.yml resolve output {name} is {job_value!r}")
owner_step = next(step for step in resolve["steps"] if step.get("id") == "owner")
check((owner_step.get("env") or {}).get("VARS_JSON") == "${{ toJSON(vars) }}", "owner.yml does not read toJSON(vars)")

readme = Path("README.md").read_text()
blocks = [block for block in re.findall(r"^```ya?ml[^\n]*\n(.*?)^```", readme, re.M | re.S) if "owner.yml@" in block]
check(len(blocks) > 0, "README.md has no yaml block that calls owner.yml@")
for block in blocks:
    caller = yaml.safe_load(block)
    caller_owner = (caller.get("jobs") or {}).get("owner") or {}
    check(caller_owner.get("permissions") == resolve.get("permissions"),
          f"README.md owner job permissions are {caller_owner.get('permissions')!r}, want owner.yml's {resolve.get('permissions')!r}")
    referenced = set(re.findall(r"needs\.owner\.outputs\.([A-Za-z0-9_-]+)", block))
    check(len(referenced) > 0, "README.md caller snippet reads no needs.owner.outputs")
    for name in sorted(referenced - set(outputs)):
        problems.append(f"README.md caller snippet reads needs.owner.outputs.{name}, which owner.yml does not declare")

if problems:
    sys.exit("\n".join(f"FAIL: {problem}" for problem in problems))
PY

count() {
  grep -cF -- "$1" "$2" || true
}

[[ "$(count 'inputs.model' .github/workflows/orchestrator.yml)" == 1 ]] || fail 'inputs.model is read somewhere other than the plan env'
[[ "$(count '--model ${{ needs.plan.outputs.model }}' .github/workflows/orchestrator.yml)" == 2 ]] || fail 'run and review do not pass the planned model to Claude'
[[ "$(count '${{ needs.plan.outputs.fallback_arguments }}' .github/workflows/orchestrator.yml)" == 2 ]] || fail 'run and review do not pass the planned fallback to Claude'
[[ "$(count '--fallback-model' .github/workflows/orchestrator.yml)" == 1 ]] || fail '--fallback-model is hard-coded outside the plan step'
[[ "$(count 'toJSON(vars)' .github/workflows/orchestrator.yml)" == 1 ]] || fail 'orchestrator reads toJSON(vars) outside the owner-gated plan env'
[[ "$(grep -c "CLAUDE_CODE_SUBAGENT_MODEL_FORCE.*needs\.plan\.outputs\.model" .github/workflows/orchestrator.yml || true)" == 2 ]] \
  || fail 'run and review settings do not force agents onto the planned model'
[[ "$(count 'claude_code_oauth_token: ${{ secrets.oauth_token }}' .github/workflows/orchestrator.yml)" == 2 ]] || fail 'oauth token wiring changed'
[[ "$(count 'anthropic_api_key: ${{ secrets.api_key }}' .github/workflows/orchestrator.yml)" == 2 ]] || fail 'api key wiring changed'
[[ "$(count "token: \${{ secrets.push_token != '' && secrets.push_token || github.token }}" .github/workflows/orchestrator.yml)" == 1 ]] \
  || fail 'consolidate checkout token wiring changed'
if grep -qF -e 'toJSON(secrets)' -e 'secrets: inherit' .github/workflows/orchestrator.yml; then
  fail 'orchestrator reads the whole secrets map'
fi
if grep -nE 'secrets\.|toJSON\(secrets' .github/workflows/owner.yml; then
  fail 'owner.yml reads secrets'
fi
grep -q 'default: claude-opus-5-5' .github/workflows/orchestrator.yml || fail 'opus 5.5 is not the default model'
grep -q 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE' .github/workflows/orchestrator.yml || fail 'agents are not forced onto the workflow model'

grep -q 'Bash(git log \*),Bash(git diff \*)' .github/workflows/orchestrator.yml || fail 'review job cannot run git log or git diff'
grep -q $'^permissions:\n  contents: read' .github/workflows/test.yml || fail 'test workflow permissions are not contents: read'
grep -q 'version=v1.7.12' .github/workflows/test.yml || fail 'actionlint version is not pinned'
grep -qE 'actionlint -shellcheck= .*\.github/workflows/owner\.yml' .github/workflows/test.yml || fail 'test workflow does not lint owner.yml'
if grep -q 'releases/latest' .github/workflows/test.yml; then
  fail 'test workflow still fetches the latest actionlint release'
fi

echo "plan tests passed"
