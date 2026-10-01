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
review_context = next(step["run"] for step in data["jobs"]["review"]["steps"] if step.get("id") == "context")
push = next(step["run"] for step in data["jobs"]["consolidate"]["steps"] if step.get("name") == "Push")
publish = next(step["run"] for step in data["jobs"]["lessons"]["steps"] if step.get("name") == "Publish lessons")
package = next(step["run"] for step in data["jobs"]["run"]["steps"] if step.get("id") == "pkg")
owner = yaml.safe_load(Path(".github/workflows/owner.yml").read_text())
resolve = next(step["run"] for step in owner["jobs"]["resolve"]["steps"] if step.get("id") == "owner")
Path("/tmp/cpo-plan.sh").write_text(plan)
Path("/tmp/cpo-run-prompt.sh").write_text(run_prompt)
Path("/tmp/cpo-review-prompt.sh").write_text(review_prompt)
Path("/tmp/cpo-review-context.sh").write_text(review_context)
Path("/tmp/cpo-push.sh").write_text(push)
Path("/tmp/cpo-publish.sh").write_text(publish)
Path("/tmp/cpo-package.sh").write_text(package)
Path("/tmp/cpo-owner.sh").write_text(resolve)
PY

bash -n /tmp/cpo-plan.sh
bash -n /tmp/cpo-run-prompt.sh
bash -n /tmp/cpo-review-prompt.sh
bash -n /tmp/cpo-review-context.sh
bash -n /tmp/cpo-push.sh
bash -n /tmp/cpo-publish.sh
bash -n /tmp/cpo-package.sh
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
if [[ "$1" == "pr" && ( "$2" == "edit" || "$2" == "create" ) ]]; then
  exit "${MOCK_CREATE_FAIL:-0}"
fi
if [[ "$1" == "api" && "$2" == "repos/acme/app" ]]; then
  printf '%s\n' "${MOCK_DEFAULT_BRANCH:-main}"
  exit 0
fi
if [[ "$1" == "api" && "$2" == "graphql" ]]; then
  cat "${MOCK_THREADS:?}"
  exit 0
fi
if [[ "$1" == "api" && "$2" == "--paginate" ]]; then
  cat "${MOCK_COMMENTS:?}"
  exit 0
fi
if [[ "$1" == "api" && "$2" == "-X" ]]; then
  cat > "${MOCK_PAYLOAD:?}"
  exit 0
fi
echo "unexpected gh: $*" >&2
exit 1
EOF
chmod +x "$mock/gh"

cat > "$mock/git" << 'EOF'
#!/usr/bin/env bash
if [[ -n "${MOCK_GIT_LOG:-}" ]]; then
  printf '%s\n' "$*" >> "$MOCK_GIT_LOG"
fi
case "$1" in
  cat-file)
    [[ -n "${MOCK_LESSONS:-}" ]]
    exit
    ;;
  show)
    printf '%s\n' "$MOCK_LESSONS"
    exit 0
    ;;
  checkout)
    exit 0
    ;;
  am)
    exit "${MOCK_AM_FAIL:-0}"
    ;;
  diff)
    [[ -n "${MOCK_CHANGED:-}" ]] && printf '%s\n' "$MOCK_CHANGED"
    exit 0
    ;;
  log)
    [[ -n "${MOCK_COMMITS:-}" ]] && printf '%s\n' "$MOCK_COMMITS"
    exit 0
    ;;
  format-patch)
    exit 0
    ;;
esac
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
    LEARNING_ENABLED="${LEARNING_ENABLED:-true}" \
    LEARNING_PULL_REQUESTS="${LEARNING_PULL_REQUESTS-50}" \
    MOCK_DEFAULT_BRANCH="${MOCK_DEFAULT_BRANCH:-main}" \
    BOT_ALLOWLIST="${BOT_ALLOWLIST:-coderabbitai[bot],greptile-apps[bot],greptileai[bot],codex[bot],copilot-*,github-copilot*}" \
    TRUSTED_ASSOCS="${TRUSTED_ASSOCS:-OWNER,MEMBER,COLLABORATOR}" \
    SEVERITIES="${SEVERITIES-critical,high}" \
    OWNER="${OWNER:-}" \
    MODEL="${MODEL:-claude-opus-5-5}" \
    EFFORT="${EFFORT-high}" \
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
    LEARNER="${LEARNER:-}" \
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
  LEARNING_ENABLED=true
  LEARNING_PULL_REQUESTS=50
  LEARNER=
  MOCK_DEFAULT_BRANCH=main
  SEVERITIES=critical,high
  OWNER=
  KEY=
  MODEL=claude-opus-5-5
  EFFORT=high
  VARS_JSON='{}'
  HAS_OAUTH=true
  HAS_API_KEY=false
  HAS_PUSH_TOKEN=false
  MOCK_BOT=0
  MOCK_AUTHOR=abnegate
  MOCK_PRS=
  MOCK_GH_FAIL=0
  MOCK_LESSONS=
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
expect_output effort high
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

for level in low medium high xhigh max; do
  reset_event
  EFFORT="$level"
  run_plan || fail "effort '$level' should have been accepted"
  expect_output effort "$level"
done

reset_event
unset EFFORT
run_plan
expect_output effort high

reset_event
EFFORT=
run_plan
expect_output effort high

for bad in bogus High ' high' 'high ' minimal 'low,high' 3; do
  reset_event
  EFFORT="$bad"
  if run_plan; then
    fail "effort '$bad' should have failed"
  fi
  expect_line /tmp/cpo-plan.out "::error::effort '$bad' is not an effort level. Use low, medium, high, xhigh, or max."
done

reset_event
EFFORT=$'high\n::error::injected'
if run_plan; then
  fail 'an effort with a newline should have failed'
fi
expect_line /tmp/cpo-plan.out "::error::effort 'high ::error::injected' is not an effort level. Use low, medium, high, xhigh, or max."
expect_no_line_starting /tmp/cpo-plan.out '::error::injected'

reset_event
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{"improvement":false,"review":true,"model":"claude-sonnet-4-6","severities":"low","effort":"low"}')
run_plan
expect_output tasks '["improvement"]'
expect_output review false
expect_output severities 'critical, high'
expect_output model claude-opus-5-5
expect_output effort high
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
expect_output effort high
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
expect_stdout /tmp/cpo-plan.out 'owner=abnegate model=claude-opus-5-5 effort=high'

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
expect_stdout /tmp/cpo-plan.out 'owner=abnegate model=claude-sonnet-4-6 effort=high'

for level in low medium high xhigh max; do
  reset_event
  OWNER=abnegate
  EFFORT=medium
  VARS_JSON=$(vars_for UREVIEW_ABNEGATE "$(jq -nc --arg effort "$level" '{improvement: true, effort: $effort}')")
  run_plan || fail "owner effort '$level' should have been accepted"
  expect_output effort "$level"
  expect_stdout /tmp/cpo-plan.out "owner=abnegate model=claude-opus-5-5 effort=$level"
done

for settings in '{"improvement":true}' '{"improvement":true,"effort":""}' '{"improvement":true,"effort":null}'; do
  reset_event
  OWNER=abnegate
  EFFORT=xhigh
  VARS_JSON=$(vars_for UREVIEW_ABNEGATE "$settings")
  run_plan || fail "owner settings $settings should keep the effort input"
  expect_output effort xhigh
done

reset_event
OWNER=abnegate
EFFORT=low
run_plan
expect_output tasks '[]'
expect_output effort low

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

for bad in '"bogus"' '"HIGH"' '"high "' '3' 'true' '["high"]' '{"level":"high"}'; do
  reset_event
  OWNER=abnegate
  VARS_JSON=$(vars_for UREVIEW_ABNEGATE "{\"improvement\":true,\"effort\":$bad}")
  if run_plan; then
    fail "owner effort $bad should have failed"
  fi
  shown=$(jq -r 'if type == "string" then . else tojson end' <<<"$bad")
  expect_line /tmp/cpo-plan.out "::error::UREVIEW_ABNEGATE effort '$shown' is not an effort level. Use low, medium, high, xhigh, or max."
done

reset_event
OWNER=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE "$(jq -nc '{improvement: true, effort: "high\n::error::injected"}')")
if run_plan; then
  fail 'an owner effort with a newline should have failed'
fi
expect_line /tmp/cpo-plan.out "::error::UREVIEW_ABNEGATE effort 'high ::error::injected' is not an effort level. Use low, medium, high, xhigh, or max."
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

for event in schedule workflow_dispatch; do
  reset_event
  EVENT_NAME="$event"
  MOCK_DEFAULT_BRANCH=trunk
  run_plan || fail "plan failed on $event"
  expect_output tasks '["learning"]'
  expect_output review false
  expect_output base_ref trunk
  expect_output branch ''
  expect_output pr_number ''
  expect_output head_sha ''
  expect_output learning_pull_requests 50
  expect_stdout "$mock_log" 'api repos/acme/app --jq .default_branch'

  reset_event
  EVENT_NAME="$event"
  LEARNING_ENABLED=false
  run_plan || fail "plan failed on $event with learning off"
  expect_output tasks '[]'
  expect_output base_ref ''
  expect_no_gh_calls
done

reset_event
EVENT_NAME=schedule
LEARNING_PULL_REQUESTS=7
run_plan
expect_output learning_pull_requests 7

reset_event
EVENT_NAME=schedule
LEARNING_PULL_REQUESTS=
run_plan
expect_output learning_pull_requests 50

for bad in 0 -1 abc 1.5 ' 5' '05' $'5\n::error::injected'; do
  reset_event
  LEARNING_PULL_REQUESTS="$bad"
  if run_plan; then
    fail "learning_pull_requests '$bad' should have failed"
  fi
  expect_line /tmp/cpo-plan.out "::error::learning_pull_requests '${bad//$'\n'/ }' is not a positive whole number."
  expect_no_line_starting /tmp/cpo-plan.out '::error::injected'
done

for event in pull_request issue_comment; do
  reset_event
  EVENT_NAME="$event"
  COMMENT_ASSOC=OWNER
  COMMENT_BODY='@claude please fix this'
  ISSUE_NUMBER=42
  run_plan
  if grep -qF 'learning' <<<"$(awk -F= '$1 == "tasks"' <<<"$PLAN_OUT")"; then
    fail "$event planned the learning task"
  fi
done

for settings in '{}' '{"learning":true}' '{"learning":"true"}'; do
  reset_event
  EVENT_NAME=schedule
  OWNER=abnegate
  LEARNING_ENABLED=false
  [[ "$settings" == '{}' ]] && LEARNING_ENABLED=true
  VARS_JSON=$(vars_for UREVIEW_ABNEGATE "$settings")
  run_plan || fail "owner learning with $settings failed"
  expect_output tasks '["learning"]'
  expect_output base_ref main
  expect_output owner abnegate
done

for settings in '{"learning":false}' '{"learning":"false"}'; do
  reset_event
  EVENT_NAME=workflow_dispatch
  OWNER=abnegate
  VARS_JSON=$(vars_for UREVIEW_ABNEGATE "$settings")
  run_plan || fail "owner learning with $settings failed"
  expect_output tasks '[]'
  expect_output base_ref ''
  expect_stdout /tmp/cpo-plan.out '@abnegate has no ureview task enabled for this event; skipping.'
done

reset_event
EVENT_NAME=schedule
OWNER=abnegate
LEARNING_ENABLED=false
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{}')
run_plan
expect_output tasks '[]'

reset_event
EVENT_NAME=schedule
OWNER=abnegate
VARS_JSON=$(vars_for UREVIEW_ABNEGATE '{}')
HAS_OAUTH=false
if run_plan; then
  fail 'an enrolled learner without a token should fail the learning run'
fi
expect_stdout /tmp/cpo-plan.out '::error::@abnegate is enrolled in ureview but neither UREVIEW_OAUTH_TOKEN_ABNEGATE nor UREVIEW_API_KEY_ABNEGATE is set.'

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

for event in schedule workflow_dispatch; do
  reset_event
  EVENT_NAME="$event"
  LEARNER=some-user
  PR_AUTHOR=abnegate
  ISSUE_USER=abnegate
  VARS_JSON=$(jq -nc '{UREVIEW_SOME_USER: "{}", UREVIEW_ABNEGATE: "{}"}')
  run_owner || fail "owner.yml failed on $event with a learner"
  expect_owner login some-user
  expect_owner enrolled true
  expect_owner oauth_secret UREVIEW_OAUTH_TOKEN_SOME_USER
  expect_owner api_key_secret UREVIEW_API_KEY_SOME_USER
  expect_owner push_secret UREVIEW_PUSH_TOKEN_SOME_USER
  expect_no_gh_calls

  for learner in '' 'bad login!' 'dependabot[bot]'; do
    reset_event
    EVENT_NAME="$event"
    LEARNER="$learner"
    VARS_JSON=$(jq -nc '{UREVIEW_ABNEGATE: "{}", "UREVIEW_DEPENDABOT[BOT]": "{}"}')
    run_owner || fail "owner.yml failed on $event with learner '$learner'"
    expect_not_enrolled_owner ''
    expect_line /tmp/cpo-owner.out 'Could not resolve a ureview owner for this event; skipping.'
  done

  reset_event
  EVENT_NAME="$event"
  LEARNER=some-user
  VARS_JSON=$(vars_for UREVIEW_OTHER '{}')
  run_owner
  expect_not_enrolled_owner some-user
done

for event in pull_request issues; do
  reset_event
  EVENT_NAME="$event"
  LEARNER=some-user
  PR_AUTHOR=abnegate
  ISSUE_USER=abnegate
  VARS_JSON=$(jq -nc '{UREVIEW_SOME_USER: "{}", UREVIEW_ABNEGATE: "{}"}')
  run_owner
  expect_owner login abnegate
done

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
    BEGIN { split("tasks review branch pr_number head_sha base_ref review_id reviewer failed_run_id severities effort learning_pull_requests", names, " "); for (i in names) wanted[names[i]] = 1 }
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
    schedule|workflow_dispatch)
      PR_HEAD_REF=
      PR_HEAD_SHA=
      PR_BASE_REF=
      PR_NUMBER=
      ;;
  esac
}

flag_value() {
  if (( $1 & $2 )); then echo true; else echo false; fi
}

for event in pull_request pull_request_review pull_request_review_comment issue_comment issues workflow_run schedule workflow_dispatch; do
  planned=0
  for ((mask = 0; mask < 64; mask++)); do
    improvement=$(flag_value "$mask" 1)
    healing=$(flag_value "$mask" 2)
    bots=$(flag_value "$mask" 4)
    comments=$(flag_value "$mask" 8)
    review=$(flag_value "$mask" 16)
    learning=$(flag_value "$mask" 32)

    differential_event "$event"
    IMPROVEMENT_ENABLED="$improvement"
    HEALING_ENABLED="$healing"
    BOTS_ENABLED="$bots"
    COMMENTS_ENABLED="$comments"
    REVIEW_ENABLED="$review"
    LEARNING_ENABLED="$learning"
    run_plan || fail "legacy plan failed on $event with mask $mask"
    legacy=$(compared_fields)

    differential_event "$event"
    OWNER=abnegate
    HAS_OAUTH=true
    VARS_JSON=$(printf '{"UREVIEW_ABNEGATE":"{\\"improvement\\":%s,\\"healing\\":%s,\\"bots\\":%s,\\"comments\\":%s,\\"review\\":%s,\\"learning\\":%s}"}' \
      "$improvement" "$healing" "$bots" "$comments" "$review" "$learning")
    IMPROVEMENT_ENABLED=true
    HEALING_ENABLED=true
    BOTS_ENABLED=true
    COMMENTS_ENABLED=true
    REVIEW_ENABLED=true
    LEARNING_ENABLED=true
    run_plan || fail "per-user plan failed on $event with mask $mask"
    per_user=$(compared_fields)

    [[ "$(wc -l <<<"$legacy")" -eq 12 ]] || fail "legacy plan on $event with mask $mask is missing compared outputs: $legacy"
    [[ "$legacy" == "$per_user" ]] \
      || fail "$event with improvement=$improvement healing=$healing bots=$bots comments=$comments review=$review learning=$learning: legacy and per-user plans differ"$'\n'"legacy:"$'\n'"$legacy"$'\n'"per-user:"$'\n'"$per_user"
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

expect_text() {
  local label="$1" text="$2" want
  shift 2
  for want in "$@"; do
    grep -qF -- "$want" <<<"$text" || fail "$label is missing '$want'"
  done
}

expect_no_placeholders() {
  local label="$1" text="$2" left
  left=$(grep -oE '__[A-Z_]+__' <<<"$text" | sort -u | paste -sd' ' - || true)
  [[ -z "$left" ]] || fail "$label left placeholders: $left"
}

marker='<!-- ureview:summary -->'
lessons_path=.github/ureview/lessons.md
lessons_branch=ureview/lessons

outfile=$(mktemp)
env REPO=acme/app PR_NUMBER=7 BASE_REF=develop HEAD_BRANCH='feature/review-mode' HEAD_SHA=deadbeef \
  SEVERITIES='critical, high' CONTEXT=/tmp/ureview DEFAULT_BRANCH=main MARKER="$marker" \
  GITHUB_OUTPUT="$outfile" bash /tmp/cpo-review-prompt.sh
body=$(prompt_body "$outfile")
rm -f "$outfile"
expect_no_placeholders 'review prompt' "$body"
expect_text 'review prompt' "$body" \
  'You are reviewing PR #7 in acme/app.' \
  'Head: feature/review-mode at commit deadbeef. Base: develop.' \
  'Report only findings at these levels: critical, high.' \
  'Never use other reviewers'"'"' comments as input.' \
  'whether a bot or a' \
  'git diff origin/develop...deadbeef > /tmp/ureview/diff.patch' \
  'Every CLAUDE.md and AGENTS.md' \
  '/tmp/ureview/lessons.md, if it exists' \
  'distilled from its history on main' \
  '## 2. Trace impact' \
  'find its callers and references with rg or grep' \
  'check every call' \
  '/tmp/ureview/impact.md' \
  'Launch these seven passes as parallel subagents with the Agent tool' \
  'against every lesson relevant to it' \
  '1. Correctness and logic' \
  '2. State, concurrency, and idempotency' \
  '3. Error handling and failure modes' \
  '4. Security' \
  '5. Contracts and compatibility' \
  '6. Tests' \
  '7. Repository conventions' \
  '## 4. Verify' \
  'skeptical verifier subagent' \
  'CONFIRMED' 'PLAUSIBLE' 'REFUTED' \
  'PLAUSIBLE findings at 80 or above' \
  '🔴 Critical' '🟠 High' '🟡 Medium' '🔵 Low' \
  'When torn between two' \
  'Style is never above Low.' \
  'Drop findings below critical, high' \
  '/tmp/ureview/threads.json' \
  'unresolved thread at the same path and the same' \
  '✅ Fixed' \
  'commit_id deadbeef' \
  'confirmed: true' \
  'Record the html_url each call returns.' \
  '**Failure scenario:**' \
  '**Suggested fix:**' \
  '```suggestion' \
  '## Code review' \
  '**Confidence: N/10**' \
  '| # | Priority | File:line | Finding |' \
  '[path/to/file.ts:42](<html_url>)' \
  '<summary>What I checked</summary>' \
  '"No issues found at critical, high."' \
  'lower-priority findings not shown' \
  'bash /tmp/ureview/post-summary.sh /tmp/ureview/review.md' \
  "It adds the hidden marker \`$marker\`" \
  'Do not edit files, commit, push, approve, request changes, resolve' \
  'Do not add "Fix this" links.'
if grep -qF '/code-review:code-review' <<<"$body"; then
  fail 'review prompt still delegates to /code-review:code-review'
fi

outfile=$(mktemp)
env TASK=improvement REPO=acme/app PR_NUMBER=7 BASE_REF=main HEAD_BRANCH='feature/review-mode' HEAD_SHA=deadbeef \
  SEVERITIES='critical, high' REVIEWER= REVIEW_ID= FAILED_RUN_ID= CR_BODY= IS_BODY= IS_TITLE= \
  GITHUB_OUTPUT="$outfile" bash /tmp/cpo-run-prompt.sh
body=$(prompt_body "$outfile")
grep -q 'fix findings at these alert levels only: critical, high.' <<<"$body" || fail 'improvement prompt missing severities'
expect_no_placeholders 'improvement prompt' "$body"
expect_text 'improvement prompt' "$body" \
  'You are running as task "improvement" on PR #7 in acme/app.' \
  'Branch: feature/review-mode at commit deadbeef.'
rm -f "$outfile"

outfile=$(mktemp)
env PATH="$mock:$PATH" TASK=learning REPO=acme/app PR_NUMBER= BASE_REF=trunk HEAD_BRANCH= HEAD_SHA= \
  SEVERITIES='critical, high' REVIEWER= REVIEW_ID= FAILED_RUN_ID= CR_BODY= IS_BODY= IS_TITLE= \
  LEARNING_PULL_REQUESTS=25 LESSONS_PATH="$lessons_path" LESSONS_BRANCH="$lessons_branch" \
  GITHUB_OUTPUT="$outfile" bash /tmp/cpo-run-prompt.sh
body=$(prompt_body "$outfile")
rm -f "$outfile"
expect_no_placeholders 'learning prompt' "$body"
expect_text 'learning prompt' "$body" \
  'You are running as task "learning" in acme/app on trunk at commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.' \
  'DO NOT push.' \
  'record' \
  'them in .github/ureview/lessons.md.' \
  'Change only .github/ureview/lessons.md.' \
  'force-pushes your commit to ureview/lessons' \
  'Collect evidence from the last 25 merged pull requests' \
  'gh pr list --repo acme/app --state merged --limit 25' \
  'parallel subagents with the Agent tool' \
  'Fix commits.' \
  'Review threads that were resolved and then fixed.' \
  'Reverts.' \
  '--label bug' \
  'closedByPullRequestsReferences' \
  'Group the records by root cause' \
  'git show origin/ureview/lessons:.github/ureview/lessons.md' \
  'Do not rewrite the' \
  'under about 300 lines' \
  '- **Root cause:**' \
  '- **Where:**' \
  '- **Detect in review:**' \
  '- **Examples:**' \
  'git commit -m "chore: update ureview lessons"' \
  'If nothing changed, exit without committing.'
if grep -qF 'PR #' <<<"$body"; then
  fail 'learning prompt names a pull request it does not run on'
fi

run_context() {
  local rc
  set +e
  env PATH="$mock:$PATH" GH_TOKEN=test-token REPO=acme/app PR_NUMBER=7 HEAD_SHA=deadbeef \
    DEFAULT_BRANCH=main LESSONS_PATH="$lessons_path" CONTEXT="$context" LOGIN='claude[bot]' \
    MARKER="$marker" GITHUB_SERVER_URL=https://github.com \
    MOCK_THREADS="$threads" MOCK_COMMENTS="$comments" MOCK_LESSONS="${MOCK_LESSONS:-}" \
    MOCK_LOG="$mock_log" bash /tmp/cpo-review-context.sh > /tmp/cpo-context.out 2>&1
  rc=$?
  set -e
  return "$rc"
}

run_summary() {
  local rc
  set +e
  env PATH="$mock:$PATH" MOCK_COMMENTS="$comments" MOCK_PAYLOAD="$payload" MOCK_LOG="$mock_log" \
    bash "$context/post-summary.sh" "$@" > /tmp/cpo-summary.out 2>&1
  rc=$?
  set -e
  return "$rc"
}

context=$(mktemp -d)
threads="$context/threads-pages.json"
comments="$context/comments-pages.json"
payload="$context/payload.json"
jq -nc '
  def thread($login; $body; $line):
    {isResolved: false, isOutdated: false, path: "src/pay.js", line: $line, originalLine: 9,
     comments: {nodes: [{author: (if $login == null then null else {login: $login} end), body: $body, url: "https://github.com/acme/app/pull/7#discussion_r1"}]}};
  {data: {repository: {pullRequest: {reviewThreads: {pageInfo: {hasNextPage: true, endCursor: "x"}, nodes: [
    (thread("claude"; "**🟠 High: Retry repeats the charge**\n\nbody"; 12)
      | .comments.nodes += [{author: {login: "jake"}, body: "intended", url: "u2"}, {author: {login: "claude"}, body: "still there", url: "u3"}]),
    thread("coderabbitai"; "**Potential issue** rabbit"; 3)
  ]}}}}},
  {data: {repository: {pullRequest: {reviewThreads: {pageInfo: {hasNextPage: false, endCursor: null}, nodes: [
    (thread("claude[bot]"; "**🔵 Low: Name the constant**"; null) | .isResolved = true),
    thread(null; "ghost"; 4)
  ]}}}}}' > "$threads"
jq -nc --arg marker "$marker" '
  [{id: 1, user: {login: "mallory"}, body: ($marker + "\nfake")}],
  [{id: 5, user: {login: "claude[bot]"}, body: ($marker + "\n## Code review\nold")}, {id: 6, user: {login: "claude[bot]"}, body: "unrelated"}]' > "$comments"

reset_event
MOCK_LESSONS=$'# ureview lessons\n\n## Retries repeat side effects'
run_context || fail "review context failed: $(cat /tmp/cpo-context.out)"
[[ "$(cat "$context/lessons.md")" == "$MOCK_LESSONS" ]] || fail "lessons.md is not the default branch's file: $(cat "$context/lessons.md")"
expect_stdout "$mock_log" 'api graphql --paginate'
expect_stdout "$mock_log" '-f owner=acme -f name=app -F number=7'
expect_stdout "$mock_log" 'api --paginate repos/acme/app/issues/7/comments'
[[ "$(jq length "$context/threads.json")" == 2 ]] || fail "threads.json kept threads by other authors: $(cat "$context/threads.json")"
[[ "$(jq -r '.[0].title' "$context/threads.json")" == '**🟠 High: Retry repeats the charge**' ]] || fail 'threads.json title is not the first line'
[[ "$(jq -c '.[0].replies' "$context/threads.json")" == '["still there"]' ]] || fail "threads.json kept replies by others: $(jq -c '.[0].replies' "$context/threads.json")"
[[ "$(jq -c '.[1] | [.line, .resolved]' "$context/threads.json")" == '[9,true]' ]] || fail 'threads.json lost the original line or resolution'
if grep -qF -e rabbit -e intended -e ghost "$context/threads.json"; then
  fail 'threads.json contains other reviewers'"'"' comments'
fi
[[ "$(cat "$context/summary.md")" == "$marker"$'\n## Code review\nold' ]] || fail "summary.md is not the earlier claude[bot] summary: $(cat "$context/summary.md")"
[[ -x "$context/post-summary.sh" ]] || fail 'post-summary.sh was not written'
bash -n "$context/post-summary.sh"

printf '%s\n%s\n\nBody.\n' "$marker" '## Code review' > "$context/review.md"
: > "$mock_log"
run_summary "$context/review.md" || fail "post-summary.sh failed: $(cat /tmp/cpo-summary.out)"
expect_stdout "$mock_log" '-X PATCH repos/acme/app/issues/comments/5 --input -'
expect_line /tmp/cpo-summary.out 'Updated summary comment 5.'
posted=$(jq -r .body "$payload")
[[ "$(grep -cF -- "$marker" <<<"$posted")" == 1 ]] || fail "summary does not hold the marker exactly once: $posted"
[[ "$(head -n 1 <<<"$posted")" == "$marker" ]] || fail 'summary does not start with the marker'
[[ "$(tail -n 1 <<<"$posted")" == '<sub>Reviewed commit [`deadbeef`](https://github.com/acme/app/commit/deadbeef)</sub>' ]] \
  || fail "summary footer is not the reviewed commit: $(tail -n 1 <<<"$posted")"
expect_text 'summary' "$posted" '## Code review' 'Body.'

jq -nc --arg marker "$marker" '[{id: 1, user: {login: "mallory"}, body: ($marker + "\nfake")}], []' > "$comments"
: > "$mock_log"
run_summary "$context/review.md" || fail "post-summary.sh failed: $(cat /tmp/cpo-summary.out)"
expect_stdout "$mock_log" '-X POST repos/acme/app/issues/7/comments --input -'
if grep -qF PATCH "$mock_log"; then
  fail 'post-summary.sh edited a comment another user wrote'
fi

: > "$mock_log"
: > "$context/empty.md"
for missing in "$context/empty.md" "$context/absent.md"; do
  if run_summary "$missing"; then
    fail "post-summary.sh posted $missing"
  fi
done
if grep -qF -- '-X' "$mock_log"; then
  fail 'post-summary.sh posted an empty summary'
fi

rm -rf "$context"
context=$(mktemp -d)
threads="$context/threads-pages.json"
comments="$context/comments-pages.json"
jq -nc '{data: {repository: {pullRequest: {reviewThreads: {pageInfo: {hasNextPage: false, endCursor: null}, nodes: []}}}}}' > "$threads"
echo '[]' > "$comments"
reset_event
run_context || fail "review context failed without history: $(cat /tmp/cpo-context.out)"
[[ ! -e "$context/lessons.md" ]] || fail 'lessons.md was written although the default branch has none'
[[ ! -e "$context/summary.md" ]] || fail 'summary.md was written although there is no earlier summary'
[[ "$(cat "$context/threads.json")" == '[]' ]] || fail 'threads.json is not empty'
rm -rf "$context"

run_package() {
  local outfile
  outfile=$(mktemp)
  env PATH="$mock:$PATH" GITHUB_OUTPUT="$outfile" GITHUB_WORKSPACE="$(mktemp -d)" TASK="$1" \
    HEAD_BRANCH="$2" BASE_REF="$3" MOCK_COMMITS="$4" MOCK_GIT_LOG="$git_log" \
    bash /tmp/cpo-package.sh > /tmp/cpo-package.out 2>&1 || fail "packaging failed: $(cat /tmp/cpo-package.out)"
  PACKAGE_OUT=$(cat "$outfile")
  rm -f "$outfile"
}

git_log=$(mktemp)
run_package learning '' trunk 'abc1234 chore: update ureview lessons'
expect_line "$git_log" 'log origin/trunk..HEAD --oneline'
expect_line "$git_log" 'format-patch origin/trunk..HEAD -o /tmp/patch'
expect_in package "$PACKAGE_OUT" has_changes true

: > "$git_log"
run_package improvement feature/review-mode main 'abc1234 (fix): something'
expect_line "$git_log" 'format-patch origin/feature/review-mode..HEAD -o /tmp/patch'

: > "$git_log"
run_package learning '' trunk ''
expect_in package "$PACKAGE_OUT" has_changes false
if grep -q '^format-patch' "$git_log"; then
  fail 'packaging made a patch from no commits'
fi
rm -f "$git_log"

run_publish() {
  local rc
  set +e
  env PATH="$mock:$PATH" GH_TOKEN=test-token REPO=acme/app BASE_REF="$publish_base" LEARNING_PULL_REQUESTS=50 \
    TITLE='chore: update ureview lessons' LESSONS_PATH="$lessons_path" LESSONS_BRANCH="$lessons_branch" \
    PATCHES="$patches" MOCK_CHANGED="${MOCK_CHANGED-$lessons_path}" MOCK_PRS="${MOCK_PRS:-[]}" \
    MOCK_CREATE_FAIL="${MOCK_CREATE_FAIL:-0}" MOCK_LOG="$mock_log" MOCK_GIT_LOG="$git_log" \
    bash /tmp/cpo-publish.sh > /tmp/cpo-publish.out 2>&1
  rc=$?
  set -e
  return "$rc"
}

reset_publish() {
  reset_event
  publish_base=main
  patches=$(mktemp -d)
  touch "$patches/0001-chore-update-ureview-lessons.patch"
  git_log=$(mktemp)
  unset MOCK_CHANGED MOCK_CREATE_FAIL
}

expect_no_push() {
  if grep -q '^push' "$git_log"; then
    fail "lessons publish pushed: $(cat "$git_log")"
  fi
}

reset_publish
run_publish || fail "lessons publish failed: $(cat /tmp/cpo-publish.out)"
expect_line "$git_log" 'checkout -B ureview/lessons origin/main'
expect_line "$git_log" 'push --force origin HEAD:refs/heads/ureview/lessons'
[[ "$(grep -c '^push' "$git_log")" == 1 ]] || fail "lessons publish pushed more than once: $(cat "$git_log")"
expect_stdout "$mock_log" 'pr list --repo acme/app --head ureview/lessons --base main --state open'
expect_stdout "$mock_log" 'pr create --repo acme/app --base main --head ureview/lessons --title chore: update ureview lessons'
expect_line /tmp/cpo-publish.out 'Opened the lessons pull request.'

reset_publish
MOCK_PRS='[{"number":12}]'
run_publish || fail "lessons publish failed with an open pull request: $(cat /tmp/cpo-publish.out)"
expect_stdout "$mock_log" 'pr edit 12 --repo acme/app --title chore: update ureview lessons'
if grep -qF 'pr create' "$mock_log"; then
  fail 'lessons publish opened a second pull request'
fi

reset_publish
rmdir "$patches" 2>/dev/null || rm -rf "$patches"
run_publish || fail 'lessons publish failed without a patch'
expect_line /tmp/cpo-publish.out 'The learning task changed no lessons.'
expect_no_push
expect_no_gh_calls

reset_publish
MOCK_CHANGED=
run_publish || fail 'lessons publish failed when nothing changed'
expect_line /tmp/cpo-publish.out 'The lessons match main already.'
expect_no_push

reset_publish
MOCK_CHANGED=$'.github/ureview/lessons.md\nsrc/app.js'
if run_publish; then
  fail 'lessons publish accepted a commit that touches other files'
fi
expect_line /tmp/cpo-publish.out '::error::The learning task changed files other than .github/ureview/lessons.md: .github/ureview/lessons.md src/app.js'
expect_no_push

for base in ureview/lessons ''; do
  reset_publish
  publish_base="$base"
  if run_publish; then
    fail "lessons publish ran with default branch '$base'"
  fi
  expect_line /tmp/cpo-publish.out "::error::Refusing to publish lessons: the default branch is '$base'."
  expect_no_push
done

reset_publish
MOCK_CREATE_FAIL=1
if run_publish; then
  fail 'lessons publish hid a failed pull request creation'
fi
expect_line /tmp/cpo-publish.out '::error::Pushed ureview/lessons but could not open its pull request. Pass a push_token, or allow GitHub Actions to create pull requests in the repository settings.'

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
effort_input = inputs.get("effort") or {}
check(effort_input.get("type") == "string", "orchestrator effort input is not type: string")
check(effort_input.get("default") == "high", "orchestrator effort input does not default to high")
severities_input = inputs.get("severities") or {}
check(severities_input.get("default") == "critical,high",
      "severities default changed, which would change improvement and bots too")
learning_input = inputs.get("learning") or {}
check(learning_input.get("type") == "boolean" and learning_input.get("default") is True,
      "orchestrator learning input is not a boolean defaulting to true")
count_input = inputs.get("learning_pull_requests") or {}
check(count_input.get("type") == "number" and count_input.get("default") == 50,
      "orchestrator learning_pull_requests input is not a number defaulting to 50")
check(orchestrator.get("env") == {"LESSONS_PATH": ".github/ureview/lessons.md", "LESSONS_BRANCH": "ureview/lessons"},
      f"orchestrator env is {orchestrator.get('env')!r}")
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
    "EFFORT": "${{ inputs.effort }}",
    "VARS_JSON": "${{ inputs.owner != '' && toJSON(vars) || '{}' }}",
    "HAS_OAUTH": "${{ secrets.oauth_token != '' }}",
    "HAS_API_KEY": "${{ secrets.api_key != '' }}",
}.items():
    check(plan_env.get(key) == want, f"Decide tasks env {key} is {plan_env.get(key)!r}, want {want!r}")
for key in ("owner", "key", "model", "effort", "fallback_arguments"):
    got = (plan_job.get("outputs") or {}).get(key)
    check(got == f"${{{{ steps.plan.outputs.{key} }}}}", f"plan job output {key} is {got!r}")

jobs = orchestrator["jobs"]
plan_outputs = plan_job.get("outputs") or {}
check(plan_outputs.get("learning_pull_requests") == "${{ steps.plan.outputs.learning_pull_requests }}",
      "plan job does not output learning_pull_requests")
check(plan_env.get("LEARNING_ENABLED") == "${{ inputs.learning }}", "Decide tasks does not read inputs.learning")
check(plan_env.get("LEARNING_PULL_REQUESTS") == "${{ inputs.learning_pull_requests }}",
      "Decide tasks does not read inputs.learning_pull_requests")

run_checkout = next(step for step in jobs["run"]["steps"] if step.get("name") == "Checkout consumer PR branch")
check(run_checkout["with"]["ref"] == "${{ needs.plan.outputs.branch || needs.plan.outputs.base_ref || github.ref }}",
      f"run checkout ref is {run_checkout['with']['ref']!r}")

consolidate_if = " ".join(str(jobs["consolidate"]["if"]).split())
check("needs.plan.outputs.branch != ''" in consolidate_if,
      "consolidate no longer requires a branch, so learning could push to the default branch")

review_job = jobs["review"]
review_steps = [step.get("name") for step in review_job["steps"]]
check(review_steps.index("Gather review context") < review_steps.index("Run Claude review"),
      "review context is not gathered before Claude runs")
gather = next(step for step in review_job["steps"] if step.get("name") == "Gather review context")
check((gather.get("env") or {}).get("GH_TOKEN") == "${{ github.token }}", "review context is not gathered with the job token")
review_run = next(step for step in review_job["steps"] if step.get("name") == "Run Claude review")
check("plugins" not in review_run["with"], "review job still installs the code-review plugin it no longer runs")
review_checkout = next(step for step in review_job["steps"] if step.get("name") == "Checkout consumer PR head")
check(review_checkout["with"]["ref"] == "${{ needs.plan.outputs.head_sha }}", "review does not check out the reviewed commit")
check(review_job["env"].get("MARKER") == "<!-- ureview:summary -->", "review marker changed")
check(review_job["env"].get("LOGIN") == "claude[bot]", "review login changed")

lessons = jobs.get("lessons") or {}
check(lessons.get("needs") == ["plan", "run"], f"lessons job needs {lessons.get('needs')!r}")
lessons_if = " ".join(str(lessons.get("if")).split())
check("contains(needs.plan.outputs.tasks, '\"learning\"')" in lessons_if and "always()" in lessons_if,
      f"lessons job if is {lessons_if!r}")
check(lessons.get("permissions") == {"contents": "write", "pull-requests": "write"},
      f"lessons job permissions are {lessons.get('permissions')!r}")
check((lessons.get("env") or {}).get("TITLE") == "chore: update ureview lessons", "lessons pull request title changed")
lessons_checkout = next(step for step in lessons["steps"] if step.get("name") == "Checkout default branch")
check(lessons_checkout["with"]["ref"] == "${{ needs.plan.outputs.base_ref }}", "lessons job does not start from the default branch")
publish = next(step for step in lessons["steps"] if step.get("name") == "Publish lessons")
check(publish["env"]["GH_TOKEN"] == "${{ secrets.push_token != '' && secrets.push_token || github.token }}",
      "lessons pull request token wiring changed")
download = next(step for step in lessons["steps"] if step.get("name") == "Download lessons patch")
check(download["with"].get("pattern") == "patch-learning", "lessons job downloads other tasks' patches")

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
learner = (call.get("inputs") or {}).get("learner") or {}
check(learner.get("type") == "string" and learner.get("default") == "", "owner.yml learner input is not an optional string")
check((owner_step.get("env") or {}).get("LEARNER") == "${{ inputs.learner }}", "owner.yml does not read inputs.learner")

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
[[ "$(count 'inputs.effort' .github/workflows/orchestrator.yml)" == 1 ]] || fail 'inputs.effort is read somewhere other than the plan env'
[[ "$(count '--effort ${{ needs.plan.outputs.effort }}' .github/workflows/orchestrator.yml)" == 2 ]] || fail 'run and review do not pass the planned effort to Claude'
[[ "$(grep -c '"CLAUDE_CODE_EFFORT_LEVEL":"{1}"}}}}'"'"', needs\.plan\.outputs\.model, needs\.plan\.outputs\.effort)' .github/workflows/orchestrator.yml || true)" == 2 ]] \
  || fail 'run and review settings do not hold agents at the planned effort'
[[ "$(count '${{ needs.plan.outputs.fallback_arguments }}' .github/workflows/orchestrator.yml)" == 2 ]] || fail 'run and review do not pass the planned fallback to Claude'
[[ "$(count '--fallback-model' .github/workflows/orchestrator.yml)" == 1 ]] || fail '--fallback-model is hard-coded outside the plan step'
[[ "$(count 'toJSON(vars)' .github/workflows/orchestrator.yml)" == 1 ]] || fail 'orchestrator reads toJSON(vars) outside the owner-gated plan env'
[[ "$(grep -c "CLAUDE_CODE_SUBAGENT_MODEL_FORCE.*needs\.plan\.outputs\.model" .github/workflows/orchestrator.yml || true)" == 2 ]] \
  || fail 'run and review settings do not force agents onto the planned model'
[[ "$(count 'claude_code_oauth_token: ${{ secrets.oauth_token }}' .github/workflows/orchestrator.yml)" == 2 ]] || fail 'oauth token wiring changed'
[[ "$(count 'anthropic_api_key: ${{ secrets.api_key }}' .github/workflows/orchestrator.yml)" == 2 ]] || fail 'api key wiring changed'
[[ "$(count "token: \${{ secrets.push_token != '' && secrets.push_token || github.token }}" .github/workflows/orchestrator.yml)" == 2 ]] \
  || fail 'consolidate and lessons checkout token wiring changed'
if grep -qF -e 'toJSON(secrets)' -e 'secrets: inherit' .github/workflows/orchestrator.yml; then
  fail 'orchestrator reads the whole secrets map'
fi
if grep -nE 'secrets\.|toJSON\(secrets' .github/workflows/owner.yml; then
  fail 'owner.yml reads secrets'
fi
grep -q 'default: claude-opus-5-5' .github/workflows/orchestrator.yml || fail 'opus 5.5 is not the default model'
grep -q 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE' .github/workflows/orchestrator.yml || fail 'agents are not forced onto the workflow model'

review_arguments=$(python3 -c '
import yaml
data = yaml.safe_load(open(".github/workflows/orchestrator.yml"))
step = next(s for s in data["jobs"]["review"]["steps"] if s.get("name") == "Run Claude review")
print(step["with"]["claude_args"])
')
grep -q -- '--dangerously-skip-permissions' <<<"$review_arguments" || fail 'review job cannot run its subagents or gh, so its summary is never posted'
grep -q -- '--allowedTools "mcp__github_inline_comment__create_inline_comment"' <<<"$review_arguments" || fail 'review job does not install the inline comment server'
review_job=$(python3 -c '
import yaml
data = yaml.safe_load(open(".github/workflows/orchestrator.yml"))
print(data["jobs"]["review"]["permissions"]["contents"])
')
[[ "$review_job" == read ]] || fail 'review job can write repository contents'
if python3 -c '
import sys, yaml
data = yaml.safe_load(open(".github/workflows/orchestrator.yml"))
step = next(s for s in data["jobs"]["review"]["steps"] if s.get("name") == "Run Claude review")
sys.exit(0 if "github_token" in step["with"] else 1)
'; then
  fail 'review job overrides the GitHub token, so reviews post as github-actions[bot] instead of claude[bot]'
fi
grep -q $'^permissions:\n  contents: read' .github/workflows/test.yml || fail 'test workflow permissions are not contents: read'
grep -q 'version=v1.7.12' .github/workflows/test.yml || fail 'actionlint version is not pinned'
grep -qE 'actionlint -shellcheck= .*\.github/workflows/owner\.yml' .github/workflows/test.yml || fail 'test workflow does not lint owner.yml'
if grep -q 'releases/latest' .github/workflows/test.yml; then
  fail 'test workflow still fetches the latest actionlint release'
fi

echo "plan tests passed"
