# claude-pr-owner

Opinionated reusable workflow that lets Claude own a pull request end-to-end:

- **improvement** — on every PR push, reviews the diff and fixes findings at the configured alert levels (critical and high by default).
- **review** — on every PR push, traces the code the change affects, runs parallel review passes, verifies each finding, and posts one summary comment (edited in place on later pushes) plus an inline comment per finding. No commits, no thread resolution, no replies. See [Review](#review).
- **healing** — on a failed CI run, diagnoses and fixes the failure.
- **bots** — on a bot review (CodeRabbit / Greptile / Copilot / Codex), triages each finding, fixes the legit ones, resolves those threads, and replies on the skipped ones with reasoning.
- **comments** — on `@claude` mentions from trusted collaborators, takes the requested action.
- **learning** — on a weekly schedule or a manual dispatch, mines recently merged PRs for recurring bugs and opens a PR updating `.github/ureview/lessons.md`, which every review then checks against. See [Learning](#learning).

The tasks that commit share a single per-branch push lock, so simultaneous triggers fan out in parallel and only the final push serializes. Review never takes that lock. Learning pushes only to its own `ureview/lessons` branch.

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
  schedule:
    - cron: '17 3 * * 1'   # learning, weekly
  workflow_dispatch:       # learning, on demand

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
    # improvement, healing, bots, comments, and learning default to true.
    # review defaults to false. Set it true, and improvement false, for
    # comments with no commits.
    # with:
    #   review: false
    #   learning: true
    #   learning_pull_requests: 50
    #   model: claude-opus-5-5
    #   effort: high
    #   severities: critical,high   # critical,high,medium,low for a review that reports every level
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

Optionally set `push_token`, a PAT with `contents: write`. Without it, consolidate pushes with `GITHUB_TOKEN`, and downstream workflows (Tests, CodeQL, etc.) do not run on Claude's commits.

To have each PR author pay with their own Claude subscription instead of one shared token, see [Per-user mode](#per-user-mode).

## Feature flags

| Input | Type | Default | Effect |
|---|---|---|---|
| `improvement` | boolean | `true` | Run on `pull_request` events. Reviews and fixes. |
| `review` | boolean | `false` | Run on `pull_request` events. Posts a summary comment and inline comments and does nothing else with them. See [Review](#review). |
| `learning` | boolean | `true` | Run on `schedule` and `workflow_dispatch` events. Opens or updates a PR that edits `.github/ureview/lessons.md`. See [Learning](#learning). Callers that already subscribe to `workflow_dispatch` start learning on each dispatch unless they set it `false`. |
| `learning_pull_requests` | number | `50` | How many of the most recently merged PRs learning mines. Must be a positive whole number. |
| `model` | string | `claude-opus-5-5` | Model for the session and every agent it spawns. Falls back to `claude-sonnet-4-6` when unavailable, unless it is `claude-sonnet-4-6`. |
| `effort` | string | `high` | Effort level for the session and every agent it spawns: `low`, `medium`, `high`, `xhigh`, `max`. Empty means `high`. Any other value fails the plan job. Callers that set no `effort` run at `high`, where they previously ran at Claude Code's default for the model. |
| `severities` | string | `critical,high` | Alert levels to address: `critical`, `high`, `medium`, `low`. One list serves improvement, review, and bots, so the default stays `critical,high`. Set `critical,high,medium,low` (or the owner's `severities` key) for a review that reports every level. |
| `healing` | boolean | `true` | Run on `workflow_run` CI failures |
| `bots` | boolean | `true` | Run on `pull_request_review` events from known bot reviewers |
| `comments` | boolean | `true` | Run on `@claude` mentions from trusted collaborators |
| `bot_allowlist` | string | CodeRabbit, Greptile, Codex, Copilot variants | Comma-separated. `*` and `?` are wildcards. Brackets are literal. |
| `trusted_associations` | string | `OWNER,MEMBER,COLLABORATOR` | Who can invoke `@claude` and whose PR bodies are safe to feed into prompts |
| `owner` | string | `''` | GitHub login whose `UREVIEW_<LOGIN>` variable sets the task flags, severities, model, and effort. Pass `needs.owner.outputs.login`. Empty keeps the inputs as given. See [Per-user mode](#per-user-mode). |

## Review

### Output

Each run posts, as `claude[bot]`, one summary comment and one inline comment per new finding.

The summary is found by a hidden `<!-- ureview:summary -->` marker and edited in place on every later push, so a PR never has more than one. It holds:

- a `## Code review` header and one paragraph on what the PR does and the verdict;
- `**Confidence: N/10**`: how sure the reviewer is that the PR is correct and safe to merge, with a one-line reason;
- a table of every finding at the configured `severities`, each linked to its inline comment, with earlier findings that no longer reproduce marked `✅ Fixed`;
- a collapsed "What I checked" list of the files and call paths traced, the passes run, and the lessons applied;
- the reviewed commit in a footer.

With nothing found, the table becomes "No issues found at <severities>" and the "What I checked" list stays. For example:

```markdown
<!-- ureview:summary -->
## Code review

Adds retry with exponential backoff to `PaymentClient.charge()` and moves the timeout into config. The retry wraps a non-idempotent call, so a slow success is charged twice; that needs fixing before merge.

**Confidence: 3/10** The double charge is reachable on every timeout; the rest of the retry path traced clean.

| # | Priority | File:line | Finding |
|---|---|---|---|
| 1 | 🔴 Critical | [src/payments/client.ts:88](https://github.com/acme/app/pull/42#discussion_r1001) | Retry repeats a charge that already succeeded |
| 2 | 🟡 Medium | [src/payments/client.ts:61](https://github.com/acme/app/pull/42#discussion_r1002) | Backoff ignores the `Retry-After` header |
| 3 | 🔵 Low | [src/config/payments.ts:12](https://github.com/acme/app/pull/42#discussion_r1003) | Timeout read as a magic string key |
| 4 | ✅ Fixed | [src/payments/client.ts:40](https://github.com/acme/app/pull/42#discussion_r0990) | ~~Timeout not applied to the first attempt~~ |

<details>
<summary>What I checked</summary>

- `PaymentClient.charge` (src/payments/client.ts:70) → `CheckoutService.complete` (src/checkout/service.ts:132), `RefundJob.run` (src/jobs/refund.ts:41)
- `paymentsConfig.timeout` (src/config/payments.ts:12) → every reader (3 files)
- Tests: test/payments/client.test.ts, test/checkout/service.test.ts
- Passes: correctness 2 candidates / 1 confirmed; state 1 / 1; errors 1 / 0; security 0; contracts 0; tests 1 / 1; conventions 1 / 1
- Lessons applied: "Retries repeat side effects" (#311, #356)

</details>

<sub>Reviewed commit [`3f9c2e1a7b4d5c6e8f90a1b2c3d4e5f6a7b8c9d0`](https://github.com/acme/app/commit/3f9c2e1a7b4d5c6e8f90a1b2c3d4e5f6a7b8c9d0)</sub>
```

Each inline comment opens with a bold priority badge and title (`**🔴 Critical: Retry repeats a charge that already succeeded**`), then the problem, a concrete failure scenario, and a suggested fix, as a GitHub suggestion block when the fix is small and certain.

On a later push the review reads its own earlier inline threads and summary, and nothing else. It does not repost a finding that has an unresolved thread at the same path with the same title; it lists that finding in the table, linked to the existing thread. A finding whose thread was resolved but which still reproduces is posted again. An earlier finding that no longer reproduces is marked `✅ Fixed`.

Priorities: 🔴 Critical (data loss, a reachable security hole, an outage, damage that cannot be undone), 🟠 High (wrong behaviour on a realistic path, fix before merge), 🟡 Medium (edge cases, slow leaks, missing regression tests), 🔵 Low (conventions, naming, dead code). Findings below `severities` are dropped and counted in the summary, so a reader knows to widen the list.

### Depth

The review never reads other reviewers' comments, bot or human. It finds everything from the code:

1. **Context:** the PR title and body, the full diff against the base, every `CLAUDE.md` and `AGENTS.md` that applies, and `.github/ureview/lessons.md` from the default branch when it exists.
2. **Impact:** for every changed function, class, config key, route, or migration, it finds the callers and callees, reads them and their tests and contracts, and checks every call site against changed behaviour.
3. **Passes:** seven parallel subagents, each scoped to the diff plus the traced code and checking the lessons: correctness and logic; state, concurrency, and idempotency; error handling and failure modes; security; contracts and compatibility; tests; repository conventions.
4. **Verify:** a skeptical verifier tries to refute each candidate. Only confirmed findings, and plausible ones at high confidence, survive, and a written rubric sets each priority.
5. **Post:** the inline comments, then the summary.

## Learning

Learning runs on `schedule` and `workflow_dispatch`, and only when `learning` is true. Subscribe to both in the caller, as [Consumer setup](#consumer-setup) shows; a weekly cron is enough.

It mines the last `learning_pull_requests` merged PRs (50 by default) for evidence of bugs: commits whose message starts with `fix` and what they changed, review threads that were resolved and then fixed, reverts, and issues labelled `bug`. It groups the evidence by root cause and writes `.github/ureview/lessons.md`, under about 300 lines:

```markdown
## Retries repeat side effects

- **Root cause:** a retry wraps a call that is not idempotent.
- **Where:** `src/payments/`, `src/jobs/`
- **Detect in review:** a retry or requeue around a write with no idempotency key.
- **Examples:** [#311](https://github.com/acme/app/pull/311), [#356](https://github.com/acme/app/pull/356)
```

Each run merges with the file on the default branch, and with the open lessons PR when there is one, keeping human edits. It does not rewrite the file from scratch.

Claude commits in the read-only run job. The `lessons` job then applies that commit to a fresh `ureview/lessons` branch cut from the default branch, refuses it if it touches any file other than the lessons file, force-pushes `ureview/lessons`, and opens or updates the PR "chore: update ureview lessons". It never pushes to the default branch. Merge that PR, and every review from then on checks PRs against the lessons.

The lessons job pushes and opens the PR with `push_token` when one is set, and with `GITHUB_TOKEN` otherwise. With `GITHUB_TOKEN`, enable "Allow GitHub Actions to create and approve pull requests" in the repository's Actions settings, or the push lands and the PR is not opened.

In per-user mode, schedules and dispatches have no PR author, so the caller names who pays: see [Learner](#learner).

## Per-user mode

Claude runs only on PRs whose author enrolled, with that author's own token and settings. Everyone else's PRs run nothing.

### Names

`<LOGIN>` is the author's GitHub login, upper-cased, with `-` turned into `_`: `some-user` becomes `SOME_USER`.

| Name | Kind | Holds |
|---|---|---|
| `UREVIEW_<LOGIN>` | variable | JSON settings. Its presence is the enrolment. |
| `UREVIEW_OAUTH_TOKEN_<LOGIN>` | secret | Output of `claude setup-token` |
| `UREVIEW_API_KEY_<LOGIN>` | secret | Anthropic API key, the alternative to the OAuth token |
| `UREVIEW_PUSH_TOKEN_<LOGIN>` | secret | PAT with `contents: write` for Claude's pushes (optional) |

Each name can live at repository or organization level. A repository value overrides an organization value of the same name, as GitHub resolves it. Variable names match case-insensitively.

Enrolment is keyed by login, so a GitHub rename orphans it: the old `UREVIEW_*_<OLD>` names stay behind and the new login is not enrolled. Unenrol before renaming, or delete the old names afterwards and enrol again.

### Settings

`UREVIEW_<LOGIN>` is a JSON object. Every key is optional. A missing key falls back to the caller's `with:` input, then to that input's default.

| Key | Type | Effect |
|---|---|---|
| `improvement`, `review`, `healing`, `bots`, `comments`, `learning` | boolean (or `"true"` / `"false"`) | Same as the input of that name |
| `severities` | string | Same as the `severities` input |
| `model` | string | Same as the `model` input |
| `effort` | string | Same as the `effort` input. Absent, `null`, or `""` keeps the input. |

```json
{"review":true,"comments":true,"improvement":false,"severities":"critical,high","model":"claude-opus-5-5","effort":"high"}
```

`{}` enrols with the inputs unchanged. Invalid JSON, a non-object, an invalid model, or an invalid effort fails the plan job.

### Owner

The owner is always the PR (or issue) author, never the commenter or reviewer. Their token pays for every task on their PR.

| Event | Owner |
|---|---|
| `pull_request`, `pull_request_review`, `pull_request_review_comment` | PR author |
| `issue_comment`, `issues` | Author of the issue or PR |
| `workflow_run` | Author of the open same-repository PR whose head commit is the run's head commit. Only for failed runs triggered by `pull_request` from the same repository. None when no PR is at that commit, or when PRs at it have different authors. |
| `schedule`, `workflow_dispatch` | The `learner` input. None when it is empty. See [Learner](#learner). |
| Anything else | None. Skipped. |

Logins that are not plain GitHub logins, such as `dependabot[bot]`, never resolve.

### Caller

Keep the `on:` block from [Consumer setup](#consumer-setup) and replace `jobs:` with:

```yaml
jobs:
  owner:
    permissions:
      pull-requests: read
    uses: abnegate/claude-pr-owner/.github/workflows/owner.yml@<sha> # v0.10.0
    with:
      learner: ${{ vars.CLAUDE_LEARNER }}
  claude:
    needs: owner
    if: needs.owner.outputs.enrolled == 'true'
    permissions:
      contents: write
      pull-requests: write
      issues: write
      actions: read
      id-token: write
    uses: abnegate/claude-pr-owner/.github/workflows/orchestrator.yml@<sha> # v0.10.0
    secrets:
      oauth_token: ${{ secrets[needs.owner.outputs.oauth_secret] }}
      api_key: ${{ secrets[needs.owner.outputs.api_key_secret] }}
      push_token: ${{ secrets[needs.owner.outputs.push_secret] }}
    with:
      owner: ${{ needs.owner.outputs.login }}
```

Pin both `uses:` to the same commit. `with:` takes the other inputs too, as the per-user defaults.

`owner.yml` reads only `vars`. It resolves the owner and outputs the owner's secret *names*. The caller indexes its own `secrets` with those names and passes the three values explicitly, because inherited secrets do not reach a reusable workflow in another organization.

| Output | Value |
|---|---|
| `login` | Resolved owner, or empty |
| `enrolled` | `'true'` when `UREVIEW_<LOGIN>` exists |
| `oauth_secret` | `UREVIEW_OAUTH_TOKEN_<LOGIN>` when enrolled |
| `api_key_secret` | `UREVIEW_API_KEY_<LOGIN>` when enrolled |
| `push_secret` | `UREVIEW_PUSH_TOKEN_<LOGIN>` when enrolled |

`owner.yml` adds one small `ubuntu-latest` job per subscribed event, enrolled or not. The `claude` job is skipped when the owner is not enrolled.

`owner.yml` and the orchestrator's plan step each receive every variable visible to the calling repository, repository and organization alike, as one JSON environment string. Linux caps a single environment string at 128 KiB, so keep all visible variables together well under that, or both jobs fail before their script runs. Callers without `owner` do not pay this: the plan step then gets `{}`.

Push token: `UREVIEW_PUSH_TOKEN_<LOGIN>`, then `GITHUB_TOKEN` (with a warning, and no downstream CI).

The v0.8.0 example also fell back to a shared `UREVIEW_PUSH_TOKEN`. To keep a shared push PAT for authors without their own, write the caller's `push_token` line as `${{ secrets[needs.owner.outputs.push_secret] || secrets.UREVIEW_PUSH_TOKEN }}`. Authors without a personal push token then use the shared PAT; authors with one keep using their own.

An enrolled owner with neither `UREVIEW_OAUTH_TOKEN_<LOGIN>` nor `UREVIEW_API_KEY_<LOGIN>` fails the plan job when a task applies to the event. Events with no task enabled skip quietly.

### Learner

`schedule` and `workflow_dispatch` have no PR author, so `owner.yml` takes an optional `learner` input, a GitHub login, and uses it as the owner of those two events only. Set a repository or organization variable `CLAUDE_LEARNER` to the login of an enrolled user, and the caller above passes it. Learning then runs with that user's token and settings, and their `learning` key can turn it off. With `CLAUDE_LEARNER` unset, the learner is empty and learning is skipped.

The variable is deliberately not named `UREVIEW_…`: every `UREVIEW_<LOGIN>` name is someone's enrolment, and `UREVIEW_LEARNER` would be the enrolment of a user called `learner`.

### Enrolling

Self-serve at https://ureview.fra.appwrite.run:

1. Sign in with GitHub.
2. Pick a repository you can push to, or an organization you administer. [Install ureview](https://github.com/apps/ureview-code-reviewer/installations/new) there first if it is not listed.
3. Set the flags, severities, model, and effort.
4. Run `claude setup-token` in a terminal, paste the token, and save.

ureview writes only your own `UREVIEW_*_<LOGIN>` names.

Admins can do the same with `gh`:

```sh
gh variable set UREVIEW_<LOGIN> [--org O --visibility all | -R o/r] --body '{"review":true,"improvement":false}'
gh secret set UREVIEW_OAUTH_TOKEN_<LOGIN> [--org O --visibility all | -R o/r]
gh secret set UREVIEW_PUSH_TOKEN_<LOGIN> [--org O --visibility all | -R o/r]
```

`gh secret set` without `--body` prompts for the value, which keeps it out of shell history.

ureview does not log in to Claude for you. `claude setup-token` is the sanctioned way to mint a long-lived token for CI, and it runs on your machine under your account. ureview encrypts the pasted token to GitHub's public key in memory and writes the secret. It has no database, keeps no copy, and never logs it.

### Exposure

- Anyone who can push a workflow to a repository can read that repository's secrets, per-user tokens included.
- Organization secrets with `visibility: all` reach every repository in the organization, and everyone who can push to any of them.
- Where teammates do not trust each other with their tokens, prefer repository-level secrets, or `--visibility selected --repos …`.
- Whether organization secrets and variables reach private repositories depends on the organization's GitHub plan. Set them per repository where they do not.

## Hosting ureview

ureview is an Appwrite Function (`ureview/`) backed by a public GitHub App, Ureview Code Reviewer. Its slug is `ureview-code-reviewer` because `ureview` was taken.

| Variable | Secret | Value |
|---|---|---|
| `GITHUB_APP_ID` | no | App id |
| `GITHUB_APP_SLUG` | no | App slug. Default `ureview`. |
| `GITHUB_CLIENT_ID` | no | App client id |
| `GITHUB_CLIENT_SECRET` | yes | App client secret |
| `GITHUB_APP_PRIVATE_KEY` | yes | App private key PEM. A literal `\n` becomes a newline. |
| `SESSION_KEY` | yes | Base64 of 32 random bytes: `openssl rand -base64 32` |
| `PUBLIC_URL` | no | The function's public origin, such as `https://ureview.fra.appwrite.run`. A trailing `/` is dropped. Used for the OAuth redirect and the Origin check. |

Until all seven are valid, only `/`, `/setup`, and `/setup/complete` answer, and everything else returns 503. Once they are, `/setup` and `/setup/complete` return 404.

1. Deploy from `ureview/`, then route the domain to the function with a proxy rule. The project has no function endpoint, so `appwrite push` fails with a `previewDomainLabel` in `appwrite.config.json`.

   ```sh
   cd ureview
   appwrite push functions --function-id ureview
   appwrite proxy create-function-rule --domain ureview.fra.appwrite.run --function-id ureview
   ```

2. Set the first three variables:

   ```sh
   appwrite functions create-variable --function-id ureview --key PUBLIC_URL --value https://ureview.fra.appwrite.run
   appwrite functions create-variable --function-id ureview --key GITHUB_APP_SLUG --value ureview-code-reviewer
   appwrite functions create-variable --function-id ureview --key SESSION_KEY --value "$(openssl rand -base64 32)" --secret
   ```

3. Open `<PUBLIC_URL>/setup`, review the manifest, and create the App. It asks for repository Secrets and Variables (write), Metadata (read), and organization Secrets and Variables (write), with no webhook and no events.
4. GitHub redirects to `/setup/complete?code=…`. The page never reads `code`. Copy it from the address bar and exchange it right away. It is single-use and expires in an hour, and the full URL, `code` included, may be kept in the function's Appwrite execution records, so an unexchanged code there is still live.
5. Exchange it locally. The credentials go straight into secret variables and are never printed.

   ```sh
   umask 077
   gh api -X POST "/app-manifests/$code/conversions" > conversion.json
   appwrite functions create-variable --function-id ureview --key GITHUB_APP_ID --value "$(jq -r .id conversion.json)"
   appwrite functions create-variable --function-id ureview --key GITHUB_CLIENT_ID --value "$(jq -r .client_id conversion.json)"
   appwrite functions create-variable --function-id ureview --key GITHUB_CLIENT_SECRET --value "$(jq -r .client_secret conversion.json)" --secret
   appwrite functions create-variable --function-id ureview --key GITHUB_APP_PRIVATE_KEY --value "$(jq -r .pem conversion.json)" --secret
   rm conversion.json
   ```

   The manifest exchange runs on your machine, not in the function, so the private key and client secret never pass through the public endpoint.

6. Redeploy (`appwrite push functions --function-id ureview`) so the variables take effect, then check `/setup` returns 404.
7. Install the App on each organization or repository at `https://github.com/apps/ureview-code-reviewer/installations/new`.

## How it works

```
plan (resolve event → task list + PR context)
  ↓
review (optional) — posts comments, produces no commits
run (matrix, parallel) — each committing task produces a local commit series as an artifact
  ↓
consolidate (serialized per-branch) — rebases, git am's every artifact, single push
lessons (learning only) — applies the learning commit to ureview/lessons, opens or updates its PR
```

`contents: read` on the run matrix means even a compromised prompt cannot push — only the consolidate job has write access, and it applies pre-computed patches deterministically. Review is a separate job, also with `contents: read`, and it uploads no patch. It posts inline comments and does not approve, request changes, or hand anything to consolidate.

## Security

- Fork PRs never run any task (the `head.repo.full_name == repository` gate).
- Learning never pushes to the default branch. The `lessons` job pushes only `ureview/lessons`, and only a commit that changes `.github/ureview/lessons.md` and nothing else. Reviews read the lessons from the default branch, so a PR cannot edit the lessons its own review uses.
- Review gathers its own earlier threads and summary with the job token before Claude starts, filtered to `claude[bot]`, and tells Claude not to read anyone else's review comments.
- Untrusted author associations (`NONE`, `CONTRIBUTOR`, `FIRST_TIME*`) cannot invoke `@claude` or trigger the improvement or review tasks.
- Only bots on `bot_allowlist` trigger the bots task; everything else is ignored.
- Log content and file names interpolated into `$GITHUB_OUTPUT` use random per-run heredoc delimiters to defeat output-injection.
- Owner resolution handles names only. `owner.yml` reads `vars` and outputs secret names; the orchestrator receives only its three declared secrets, never the caller's secrets map.
- Secret names derive from the author's login, validated against `^[A-Za-z0-9-]{1,39}$`. An author cannot point Claude at another user's token.
- Enrolment is an extra gate. The fork, association, and bot gates above still apply, and unenrolled authors run nothing.
- ureview's repository writes require push access, checked with the signed-in user's own token before it mints an installation token scoped to that one repository. Organization writes use the user's own token, so GitHub enforces organization admin.
- ureview derives every secret and variable name from the signed-in login. Request bodies cannot name one.
- ureview keeps one `__Host-ureview_session` cookie (AES-256-GCM sealed, `HttpOnly`, `Secure`, `SameSite=Lax`, 8 hours). Every non-GET request must carry an `Origin` equal to `PUBLIC_URL`.
