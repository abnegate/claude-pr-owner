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
Path("/tmp/cpo-plan.sh").write_text(plan)
Path("/tmp/cpo-run-prompt.sh").write_text(run_prompt)
Path("/tmp/cpo-review-prompt.sh").write_text(review_prompt)
PY

bash -n /tmp/cpo-plan.sh
bash -n /tmp/cpo-run-prompt.sh
bash -n /tmp/cpo-review-prompt.sh

mock=$(mktemp -d)
cat > "$mock/gh" << 'EOF'
#!/usr/bin/env bash
joined="$*"
if [[ "$joined" == *"/commits/"* ]]; then
  if [[ "${MOCK_BOT:-}" == "1" ]]; then
    printf '%s\n' 'claude-bot@users.noreply.github.com'
  else
    printf '%s\n' 'dev@example.com'
  fi
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "list" ]]; then
  printf '%s\n' '88'
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "view" ]]; then
  printf '%s\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  exit 0
fi
echo "unexpected gh: $*" >&2
exit 1
EOF
chmod +x "$mock/gh"

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
    WR_ID="${WR_ID:-}" \
    IMPROVEMENT_ENABLED="${IMPROVEMENT_ENABLED:-true}" \
    HEALING_ENABLED="${HEALING_ENABLED:-true}" \
    BOTS_ENABLED="${BOTS_ENABLED:-true}" \
    COMMENTS_ENABLED="${COMMENTS_ENABLED:-true}" \
    REVIEW_ENABLED="${REVIEW_ENABLED:-false}" \
    BOT_ALLOWLIST="${BOT_ALLOWLIST:-coderabbitai[bot],greptile-apps[bot],greptileai[bot],codex[bot],copilot-*,github-copilot*}" \
    TRUSTED_ASSOCS="${TRUSTED_ASSOCS:-OWNER,MEMBER,COLLABORATOR}" \
    SEVERITIES="${SEVERITIES-critical,high}" \
    MOCK_BOT="${MOCK_BOT:-0}" \
    bash /tmp/cpo-plan.sh > /tmp/cpo-plan.out
  rc=$?
  set -e
  PLAN_OUT=$(cat "$outfile" 2>/dev/null || true)
  rm -f "$outfile"
  return "$rc"
}

expect_output() {
  local key="$1" want="$2"
  local got
  got=$(printf '%s\n' "$PLAN_OUT" | awk -F= -v k="$key" '$1==k { sub(/^[^=]*=/,""); print; exit }')
  [[ "$got" == "$want" ]] || fail "$key: got '$got' want '$want'"
}

reset_event() {
  EVENT_NAME=pull_request
  PR_HEAD_REPO_FULL=acme/app
  PR_ASSOC=OWNER
  REVIEW_USER=
  REVIEW_ID=
  IMPROVEMENT_ENABLED=true
  REVIEW_ENABLED=false
  SEVERITIES=critical,high
  MOCK_BOT=0
  WR_CONCLUSION=
  WR_EVENT=
  WR_HEAD_BRANCH=
  WR_HEAD_REPO_FULL=
  WR_ID=
}

reset_event
run_plan
expect_output tasks '["improvement"]'
expect_output review false
expect_output severities 'critical, high'

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
WR_ID=77
run_plan
expect_output tasks '["healing"]'
expect_output review false
expect_output pr_number 88

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

# The model input is an action argument, not part of the prompt script.
grep -q 'default: claude-opus-5-5' .github/workflows/orchestrator.yml || fail 'opus 5.5 is not the default model'
grep -q 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE' .github/workflows/orchestrator.yml || fail 'agents are not forced onto the workflow model'
grep -q -- '--model ${{ inputs.model }}' .github/workflows/orchestrator.yml || fail 'model input is not passed to Claude'

echo "plan tests passed"
