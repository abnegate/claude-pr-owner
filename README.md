# claude-pr-owner

Opinionated reusable workflow that lets Claude own a pull request end-to-end:

- **improvement** — on every PR push, reviews the diff and fixes findings at the configured alert levels (critical and high by default).
- **review** — on every PR push, posts inline review comments and stops. No commits, no thread resolution, no replies.
- **healing** — on a failed CI run, diagnoses and fixes the failure.
- **bots** — on a bot review (CodeRabbit / Greptile / Copilot / Codex), triages each finding, fixes the legit ones, resolves those threads, and replies on the skipped ones with reasoning.
- **comments** — on `@claude` mentions from trusted collaborators, takes the requested action.

The tasks that commit share a single per-branch push lock, so simultaneous triggers fan out in parallel and only the final push serializes. Review never takes that lock.

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
    # Caller must grant the union of every permission the callee's jobs ask
    # for. Reusable workflows cannot exceed that ceiling.
    permissions:
      contents: write
      pull-requests: write
      issues: write
      actions: read
      id-token: write
    uses: abnegate/claude-pr-owner/.github/workflows/orchestrator.yml@main
    secrets:
      oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      # api_key: ${{ secrets.ANTHROPIC_API_KEY }}  # alternative to oauth_token
    # improvement, healing, bots, and comments default to true.
    # review defaults to false. Set it true, and improvement false, for
    # comments with no commits.
    # with:
    #   review: false
    #   model: claude-opus-5-5
    #   severities: critical,high
    #   improvement: true
    #   healing: true
    #   bots: true
    #   comments: true
    #   bot_allowlist: "coderabbitai[bot],greptile-apps[bot],copilot-*"
    #   trusted_associations: "OWNER,MEMBER,COLLABORATOR"
```

Provide **one** of the two auth secrets:

- `oauth_token` — from `claude setup-token` (recommended; uses your subscription).
- `api_key` — Anthropic API key (pay-per-request).

If both are set, `oauth_token` wins.

## Feature flags

| Input | Type | Default | Effect |
|---|---|---|---|
| `improvement` | boolean | `true` | Run on `pull_request` events. Reviews and fixes. |
| `review` | boolean | `false` | Run on `pull_request` events. Posts inline comments and does nothing else with them. |
| `model` | string | `claude-opus-5-5` | Model for the session and every agent it spawns. |
| `severities` | string | `critical,high` | Alert levels to address: `critical`, `high`, `medium`, `low`. |
| `healing` | boolean | `true` | Run on `workflow_run` CI failures |
| `bots` | boolean | `true` | Run on `pull_request_review` events from known bot reviewers |
| `comments` | boolean | `true` | Run on `@claude` mentions from trusted collaborators |
| `bot_allowlist` | string | CodeRabbit, Greptile, Codex, Copilot variants | Comma-separated. `*` and `?` are wildcards. Brackets are literal. |
| `trusted_associations` | string | `OWNER,MEMBER,COLLABORATOR` | Who can invoke `@claude` and whose PR bodies are safe to feed into prompts |

## How it works

```
plan (resolve event → task list + PR context)
  ↓
review (optional) — posts comments, produces no commits
run (matrix, parallel) — each committing task produces a local commit series as an artifact
  ↓
consolidate (serialized per-branch) — rebases, git am's every artifact, single push
```

`contents: read` on the run matrix means even a compromised prompt cannot push — only the consolidate job has write access, and it applies pre-computed patches deterministically. Review is a separate job, also with `contents: read`, and it uploads no patch. It posts inline comments and does not approve, request changes, or hand anything to consolidate.

## Security

- Fork PRs never run any task (the `head.repo.full_name == repository` gate).
- Untrusted author associations (`NONE`, `CONTRIBUTOR`, `FIRST_TIME*`) cannot invoke `@claude` or trigger the improvement or review tasks.
- Only bots on `bot_allowlist` trigger the bots task; everything else is ignored.
- Log content and file names interpolated into `$GITHUB_OUTPUT` use random per-run heredoc delimiters to defeat output-injection.
