#!/usr/bin/env bash
# Usage: run.sh <provider> <model> <prompt> <schema> <output>
# Model output only ever goes to <output>: job logs of public repositories are public.
set -uo pipefail

provider=$1
model=$2
prompt=$3
schema=$4
output=$5

tools='Read,Grep,Glob,Agent,Bash(git log:*),Bash(git diff:*),Bash(git show:*),Bash(git blame:*)'

case "$provider" in
  anthropic)
    arguments=(
      -p
      --model "$model"
      --effort "$EFFORT"
      --permission-mode dontAsk
      --allowedTools "$tools"
      --add-dir "$WORK"
      --output-format json
      --json-schema "$(cat "$schema")"
    )
    if [[ -n "${BUDGET:-}" ]]; then
      arguments+=(--max-budget-usd "$BUDGET")
    fi
    claude "${arguments[@]}" < "$prompt" > "$output" 2> /dev/null
    ;;
  openai)
    codex exec \
      --model "$model" \
      --config "model_reasoning_effort=\"$EFFORT\"" \
      --sandbox read-only \
      --ephemeral \
      --color never \
      --output-schema "$schema" \
      --output-last-message "$output" \
      - < "$prompt" > /dev/null 2>&1
    ;;
  *)
    echo "::error::Unknown provider '$provider'."
    exit 1
    ;;
esac

status=$?
if [[ $status -ne 0 ]]; then
  echo "::warning::$model exited with status $status."
fi
exit 0
