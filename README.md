# claude-pr-owner

Opinionated reusable workflow that lets Claude own a pull request end-to-end:

- **improvement** — on every PR push, reviews the diff and fixes CRITICAL / HIGH / MEDIUM findings.
- **healing** — on a failed CI run, diagnoses and fixes the failure.
- **bots** — on a bot review (CodeRabbit / Greptile / Copilot / Codex), triages each finding, fixes the legit ones, resolves those threads, and replies on the skipped ones with reasoning.
- **comments** — on `@claude` mentions from trusted collaborators, takes the requested action.

All four tasks share a single per-branch push lock, so simultaneous triggers fan out in parallel and only the final push serializes.

## Consumer setup

Add one workflow to your repo (`.github/workflows/claude.yml`):

```yaml
name: Claude

on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]
  pull_request_review:
    types: [submitted]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened, assigned]
  workflow_run:
    workflows: [Tests]     # your CI workflow's name
    types: [completed]

jobs:
  claude:
    uses: abnegate/claude-pr-owner/.github/workflows/orchestrator.yml@main
    secrets:
      claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    # All task flags default to true; set any to false to disable.
    # with:
    #   improvement: true
    #   healing: true
    #   bots: true
    #   comments: true
    #   bot_allowlist: "coderabbitai[bot],greptile-apps[bot],copilot-*"
    #   trusted_associations: "OWNER,MEMBER,COLLABORATOR"
```

Only the OAuth token is required. Get one with `claude setup-token` and add it as a repo secret named `CLAUDE_CODE_OAUTH_TOKEN`.

## Feature flags

| Input | Type | Default | Effect |
|---|---|---|---|
| `improvement` | boolean | `true` | Run on `pull_request` events |
| `healing` | boolean | `true` | Run on `workflow_run` CI failures |
| `bots` | boolean | `true` | Run on `pull_request_review` events from known bot reviewers |
| `comments` | boolean | `true` | Run on `@claude` mentions from trusted collaborators |
| `bot_allowlist` | string | CodeRabbit, Greptile, Codex, Copilot variants | Comma-separated; supports shell-style wildcards |
| `trusted_associations` | string | `OWNER,MEMBER,COLLABORATOR` | Who can invoke `@claude` and whose PR bodies are safe to feed into prompts |

## How it works

```
plan (resolve event → task list + PR context)
  ↓
run (matrix, parallel) — each task produces a local commit series as an artifact
  ↓
consolidate (serialized per-branch) — rebases, git am's every artifact, single push
```

`contents: read` on the run matrix means even a compromised prompt cannot push — only the consolidate job has write access, and it applies pre-computed patches deterministically.

## Security

- Fork PRs never run any task (the `head.repo.full_name == repository` gate).
- Untrusted author associations (`NONE`, `CONTRIBUTOR`, `FIRST_TIME*`) cannot invoke `@claude` or trigger the improvement task.
- Only bots on `bot_allowlist` trigger the bots task; everything else is ignored.
- Log content and file names interpolated into `$GITHUB_OUTPUT` use random per-run heredoc delimiters to defeat output-injection.
