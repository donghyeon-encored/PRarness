# Codex Cloud relay runbook

The control plane uses GitHub itself as the durable return channel:

```text
GitHub App webhook → signed/idempotent spool → ChatGPT-authenticated relay
                                                ↓
                                            Codex Cloud
                                                ↓
Issue/comment + branch/PR + checks/deployment on GitHub
                                                ↓ webhook
                                      reconcile the next stage
```

Triage, plan, review, and implementation requests preserve the existing stage
schemas, policy projection, source/subject SHAs, request nonce, one-attempt
limit, and pinned CLI version. GitHub Actions never runs a
ChatGPT-authenticated process. The central webhook controller observes the
App-authored GitHub results and enqueues the next reconcile/Cloud stage.

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

The relay and Codex Cloud use the same GitHub App through different
least-privilege installation tokens. The relay reads a mode-0600 App private
key from its private controller configuration and automatically mints a
repository-scoped, read-only token only to pin the source SHA and verify the
App-authored return receipt. It does not use `gh auth login` or a person's
GitHub credential. Cloud setup/maintenance mints a separate repository-scoped
write token to configure `origin` and non-interactive `gh` access inside the
task container. The Cloud worker uses that access for the source Issue,
canonical comments, managed branch, commits, draft PR, checks, and deployments.
Neither process may print or extract the credential, force-push, self-approve,
or merge.

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
3. Store the App PEM as a mode-0600 file on the relay host and reference only
   its absolute path from the private controller config. In every Cloud
   environment that runs PRarness, add
   `AGENT_APP_ID` and `AGENT_APP_PRIVATE_KEY` plus optional
   `AGENT_APP_INSTALLATION_ID`. Install
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
   `$HOME/.local/bin/prarness-github`, and
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
   and verifies the minted App token's Contents, Issues, Pull requests,
   Actions, Checks, and Deployments write permissions plus a non-empty
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
5. Store each repository-to-Cloud-environment mapping in the controller's
   private configuration/ledger. Do not copy it into a target Actions variable.
6. Keep raw requests, task URLs, task status, pinned source SHAs, App-authored
   return receipts, and reconciliation results in the relay-local spool/ledger.

Ownership routing and execution are deliberately separate. A person's
`main_agent` remains routing metadata, while `pipeline.execution.backend` fixes
all model stages to `codex_cloud` and disables API-billing fallback.

The CLI cannot create Cloud environments. If no suitable environment already
exists, execution remains blocked and nobody is prompted to log in.

## Target repository contract

Each target explicitly opts in with a protected `.github/prarness.yml`. It
contains only the runtime contract, direct-publication mode, managed branch
prefix, repository validation commands, required CI workflow/check identity,
ownership fallback, and additional protected paths. It does not copy PRarness
prompts, schemas, scripts, tests, or central ground rules. See
`docs/target-adoption.md` for the file shape and migration sequence.

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
canonical state; waits for required checks from the configured trusted Check
App; and then reads the remote branch, live PR, App-authored Issue/PR comments,
and checks again. Only a result with `verified: true`, an exact remote SHA,
GitHub PR URL, both comment IDs, and successful required checks is a successful
publication. Preparing PR metadata or creating only a local branch is not
success.

Runtime contract 1 deliberately fails closed for every protected path. It does
not yet carry the source-Issue marker and independent human-approval evidence
needed to authorize a non-workflow protected change. Such work remains on the
reviewed controller/human path; interactive maintenance is the supported path
for workflow and `.github/prarness.yml` changes.

The relay may additionally sign its compact Cloud receipt with Ed25519, but the
authoritative completion evidence is the live GitHub receipt produced by
`prarness-publish`: repository, request nonce, Issue, branch, exact commit,
draft PR, canonical comment IDs, and trusted CI checks.

## GitHub App webhook controller

Run the central ingress behind HTTPS:

```bash
node .github/agent-pipeline/github-app-controller.mjs serve \
  --secret-file /secure/prarness-webhook-secret \
  --app-id 123456 \
  --spool /var/lib/prarness/webhooks \
  --host 127.0.0.1 \
  --port 8787
```

Configure the GitHub App webhook URL to end in `/github/webhook` and subscribe
to Issues, Issue comments, Pull requests, Check runs, and Workflow runs. The
receiver validates `X-Hub-Signature-256`, caps bodies at 1 MiB, ignores
unrelated events, trusts canonical comments only from the configured App ID,
and stores each `X-GitHub-Delivery` once.
Use the credential-free `GET /healthz` endpoint for deployment health checks;
it returns no repository, task, or authentication data.

The relay host drains normalized jobs with an absolute dispatcher executable:

```bash
node .github/agent-pipeline/github-app-controller.mjs drain \
  --spool /var/lib/prarness/webhooks \
  --dispatcher /opt/prarness/bin/dispatch-cloud-job
```

`controller-dispatch.mjs` is the provided dispatcher. It reads the normalized
job file, looks up the repository's Cloud environment in a private JSON config,
resolves the exact GitHub source SHA, verifies the pinned Codex CLI and existing
ChatGPT login, submits one attempt, and records the returned task URL back into
the job before returning success. Its config shape is:

```json
{
  "version": 1,
  "app_id": 123456,
  "github_app_private_key_file": "/secure/prarness-app.pem",
  "codex_cli": "/absolute/path/to/codex",
  "expected_cli_version": "0.145.0",
  "repositories": {
    "OWNER/REPOSITORY": {
      "environment_id": "CODEX_CLOUD_ENVIRONMENT_ID",
      "runtime_ref": "REVIEWED_40_CHARACTER_PRARNESS_SHA",
      "default_branch": "main"
    }
  }
}
```

Set `PRARNESS_CONTROLLER_CONFIG` to that private file and use the absolute
executable path to `controller-dispatch.mjs` as `--dispatcher`.
Dispatchers use exit code 75 only for a definitely retryable pre-submit
failure; those jobs return to the pending spool up to five times. Ambiguous or
terminal failures go to the failed spool without submitting again. Delivery
and request IDs make repeated GitHub effects idempotent. Reconciliation always reads the
live App comment, PR head, and checks before advancing. The pipeline never
auto-merges.

Source code availability is not deployment. Keep an existing target Issue
controller until the webhook endpoint is reachable from GitHub and one canary
delivery has completed the full dispatch → Cloud → GitHub receipt → reconcile
loop. Remove the old controller only in that verified cutover.
