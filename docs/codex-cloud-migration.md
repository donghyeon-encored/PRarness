# Codex Cloud relay runbook

The public-repository boundary is intentionally staged:

```text
GitHub-hosted gate → SHA-bound Cloud request → audit artifact → fail closed
                                           ↘ trusted local relay → Codex Cloud
                                             ↘ verified REST/git → GitHub
                                             (result return channel not connected)
```

Triage, plan, review, and implementation requests preserve the existing stage
schemas, policy projection, source/subject SHAs, request nonce, one-attempt
limit, and pinned CLI version. The public workflow never runs a
ChatGPT-authenticated process. Until a separately reviewed result mailbox is
available, it archives the request and stops before importing the Cloud result
into the next controller stage.

## Authentication boundary

The relay uses the already-existing ChatGPT login held by the local Codex CLI.
It never starts an interactive login, copies `auth.json` into Actions, uses a
provider API key, or falls back to usage-based API billing. If the cached login
expires, the relay fails closed.

Do not register the credential-bearing host as a self-hosted Actions runner for
this public repository. GitHub Actions steps share the runner account and could
reach its cached login even when the `codex` subprocess receives a sanitized
environment. The bridge therefore rejects Cloud CLI calls when
`GITHUB_ACTIONS` or `ACTIONS_RUNTIME_TOKEN` is present.

The external relay receives no GitHub credential. The Codex Cloud environment
does: its setup/maintenance bootstrap uses either `CODEX_GITHUB_TOKEN` or the
repository GitHub App credentials to configure `origin` and persist
non-interactive `gh` access inside the task container. The Cloud worker uses
that scoped access for the source Issue, canonical comments, managed branch,
commits, draft PR, and review comments. It must not print or extract the
credential, force-push, self-approve, or merge.

Interactive maintenance is a separate user-authorized path. It uses a
`codex/maintenance-*` draft PR by default, but an explicit instruction to
publish to the default branch permits one validated fast-forward commit after
the live head is rechecked.

Codex Cloud checks out the repository before running setup; cached environments
run maintenance instead, and environment secrets are removed before the agent
phase. Configure the same loader in both phases so a resumed container replaces
an expired GitHub App installation token before work starts. See the official
[Codex Cloud environment documentation](https://learn.chatgpt.com/docs/environments/cloud-environment).

## External relay prerequisites

1. Run a dedicated local daemon under the OS account that already owns the
   ChatGPT Codex session; do not register it as an Actions runner.
2. Pin the reviewed bridge and `codex` executable to the versions recorded in
   the request. Launch the CLI from an empty, relay-owned control directory,
   never from an untrusted checkout.
3. In every Cloud environment that runs PRarness, add
   `CODEX_GITHUB_TOKEN`, or add `AGENT_APP_ID` and
   `AGENT_APP_PRIVATE_KEY` plus optional `AGENT_APP_INSTALLATION_ID`. Install
   that App on every repository the environment may operate on. The bootstrap
   discovers a remote-less checkout automatically; set the non-secret
   `CODEX_GITHUB_REPOSITORY=OWNER/REPO` override only when multiple accessible
   repositories contain the same checkout HEAD, as can happen with forks.

   For `AGENT_APP_PRIVATE_KEY`, the preferred secret value is the entire PEM
   downloaded from the GitHub App settings, including its `BEGIN` and `END`
   lines. Store the file contents, not a local `.pem` path. The bootstrap also
   accepts matching outer quotes and literal `\n` line separators for
   environment-editor compatibility. If multiline secrets cannot be preserved,
   base64-encode the complete PEM and store it with an explicit `base64:`
   prefix. The bootstrap validates the RSA key before making any GitHub API
   request and never logs the value.
4. Configure both setup and maintenance scripts with this same generic loader,
   replacing `REVIEWED_PRARNESS_COMMIT_SHA` with a reviewed 40-character
   PRarness commit SHA:

   ```bash
   set -euo pipefail
   prarness_ref=REVIEWED_PRARNESS_COMMIT_SHA
   curl --fail --silent --show-error --location \
     "https://raw.githubusercontent.com/donghyeon-encored/PRarness/${prarness_ref}/.github/agent-pipeline/cloud-environment-bootstrap.sh" \
     | PRARNESS_BOOTSTRAP_REF="$prarness_ref" bash
   ```

   The loader downloads `runtime-manifest.json`, verifies every listed SHA-256,
   and installs the reviewed runtime under
   `$HOME/.local/share/prarness/<commit-sha>/`. It exposes
   `$HOME/.local/bin/prarness-github-setup`,
   `$HOME/.local/bin/prarness-repository-check`, and
   `$HOME/.local/bin/prarness-publish`. It resolves the target from an explicit
   argument, `CODEX_GITHUB_REPOSITORY`,
   `GITHUB_REPOSITORY`, or exactly one parseable GitHub remote, in that order.
   With none of those available, it lists repositories accessible to the
   configured token or GitHub App and selects the only repository containing
   the local checkout HEAD. Zero or multiple matches fail closed without
   logging private repository names. Discovery scans at most 1,000 repositories
   by default; `PRARNESS_GITHUB_DISCOVERY_MAX_REPOSITORIES` may raise that
   safety limit to at most 5,000 for a large installation.

   Every fresh or resumed container repairs `origin`, refreshes authentication,
   and verifies the minted App token's Contents, Issues, and Pull requests
   permissions (or a user token's repository push permission) plus a non-empty
   HTTPS Git credential before the agent phase. It writes the current
   multi-account `gh` host structure and pins the repository-local HTTPS
   username to `x-access-token` for managed App/token credentials, overriding
   checkout-level credential defaults. Pre-existing `gh` authentication uses
   its authenticated login instead.
   Repository
   `permissions.push` describes user-style repository access and is not used to
   classify a GitHub App installation token. `git ls-remote` remains a
   supplemental connectivity check because a public repository can pass it
   anonymously.
   After a successful REST repository check, it records `origin` as the local
   `gh` default without
   invoking `gh repo set-default`; that command performs an additional GraphQL
   repository-network query that can reject an otherwise valid GitHub App
   installation token. Target repositories do not need to copy
   `.github/agent-pipeline/**` from PRarness or define a repository-specific
   setup script.
5. Add its non-secret ID as the repository variable `CODEX_CLOUD_ENV_ID` so
   request construction is deterministic.
6. Keep raw requests, task URLs, task status, downloaded diff hashes, and
   validated results in a relay-local append-only ledger.

Ownership routing and execution are deliberately separate. A person's
`main_agent` remains routing metadata, while `pipeline.execution.backend` fixes
all model stages to `codex_cloud` and disables API-billing fallback.

The CLI cannot create Cloud environments. If no suitable environment already
exists, execution remains blocked and nobody is prompted to log in.

## Target repository contract

Each target explicitly opts in with a protected `.github/prarness.yml`. It
contains only the runtime contract, direct-publication mode, managed branch
prefix, repository validation commands, ownership fallback, and additional
protected paths. It does not copy PRarness prompts, schemas, scripts, tests, or
central ground rules. See `docs/target-adoption.md` for the file shape and
migration sequence.

Before any model work, run:

```bash
prarness-repository-check --repository OWNER/REPO
prarness-github-setup --verify-write OWNER/REPO
```

The first command fails `LEGACY_PUBLICATION_POLICY` when a tracked repository
instruction still says that the Cloud worker cannot perform its scoped GitHub
writes. This is a migration error, not permission for the Cloud prompt to
override repository instructions. The second command fails before source edits
if the repository, App permission, credential helper, or token lifetime is not
safe for publication.

## Request and result contract

Each request binds stage, exact source SHA, exact work/review subject SHA,
repository, Cloud environment, request nonce, one attempt, and exact CLI
version. The prompt is passed on stdin. Cloud writes a nonce-scoped JSON
sentinel. The bridge downloads the raw diff, hashes it, applies those exact
bytes to an isolated Git index, derives changed paths and payload from that
index, removes the sentinel, and regenerates the publication patch with
external diff helpers disabled.

Read-only stages must leave an empty publication patch. Implementation may
change only the current plan's paths and returns a strict summary payload. The
byte-aware query limit is 4 MiB, covering the configured 5,000-file CodeGraph
while bounding unusually large issue bodies and long-line patches.

Submissions use one attempt and are never retried after an ambiguous response.
Unknown status, timeout, identity mismatch, secret-like context, moving SHA,
unexpected file mode/path, or result mismatch fails closed.

Code publication also uses a strict request file. After the implementation has
exactly one commit, the worker runs:

```bash
prarness-publish \
  --request "$REQUEST_JSON" \
  --validation "$VALIDATION_JSON" \
  --result "$RESULT_JSON" \
  --repo "$PWD"
```

The command rechecks target opt-in, origin identity, source ancestry, commit
count, allowed paths, protected paths, the 400-line ceiling, a clean worktree,
and ordered pass evidence for every configured validation command. It does not
execute target validation code while publishing. It pushes only the managed
`agent/issue-*` branch; finds or creates the draft PR through REST; updates
canonical state; and then reads the remote branch and live PR again. Only a
result with `verified: true`, an exact remote SHA, and a GitHub PR URL is a
successful publication. Preparing PR metadata or creating only a local branch
is not success.

Runtime contract 1 deliberately fails closed for every protected path. It does
not yet carry the source-Issue marker and independent human-approval evidence
needed to authorize a non-workflow protected change. Such work remains on the
reviewed controller/human path; interactive maintenance is the supported path
for workflow and `.github/prarness.yml` changes.

The external relay signs a compact result receipt with an Ed25519 key that is
kept outside Actions. The receipt binds the request nonce, stage, source and
subject SHAs, Cloud task, attempt, completion time, and exact diff SHA-256. The
controller stores only the public verification key and rejects receipts older
than one hour or more than five minutes in the future. The separately deployed
mailbox must atomically consume every pending nonce at most once. The bridge
exposes `sign-receipt` and `verify-receipt` for that transport.

## Deliberately deferred return path

This migration does not yet import relay results into the public workflow.
Doing so safely requires a separately reviewed mailbox with signed envelopes,
pending nonces, exact request/diff hashes, replay prevention, bounded payloads,
and deterministic App-token isolation. A private control repository is the
preferred next phase; an unsigned comment, public self-hosted runner, or raw
`repository_dispatch` payload is not an acceptable shortcut.

After that transport exists, the controller must reconcile the Cloud worker's
reported branch/PR/SHA with live GitHub state before dispatching the next stage.
The Cloud worker still applies the line budget, risk, protected-path,
validation, and exact-SHA review checks before its direct GitHub updates. The
pipeline never auto-merges.
