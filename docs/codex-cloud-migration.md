# Codex Cloud hostless runbook

PRarness uses ChatGPT-authenticated Codex Cloud. It does not use
`OPENAI_API_KEY`, a self-hosted runner, an external webhook service, or a relay
daemon. The unavoidable dispatch boundary is one human `@codex` comment on the
source Issue for the first run, then on the canonical draft PR for any later
continuation.

## GitHub App

Create one GitHub App and install it on every managed repository. Grant:

- Contents: read and write
- Issues: read and write
- Pull requests: read and write
- Actions: read and write
- Checks: read and write
- Deployments: read and write
- Metadata: read

Do not grant Workflows write to ordinary automated Issue work. Workflow and
policy maintenance uses an interactive maintenance task and separate human
review.

In each target Codex Cloud environment, add these setup secrets:

```text
AGENT_APP_ID
AGENT_APP_PRIVATE_KEY
```

`AGENT_APP_INSTALLATION_ID` is optional. The private key may be full multiline
PEM, `base64:<encoded complete PEM>`, or matching literal `\n` text. Never put
these values in a repository, GitHub Actions variable, job output, or log.

## Setup and maintenance script

Use the same compatible bootstrap SHA in both Cloud setup and maintenance. It
mints a fresh repository App token before every task. Routine runtime releases
do not require editing this environment script because each canonical human
command self-installs its exact intake runtime SHA during the agent phase:

```bash
set -euo pipefail
set +x

prarness_ref=COMPATIBLE_REVIEWED_40_CHARACTER_BOOTSTRAP_SHA
installer_path=/tmp/prarness-cloud-environment-bootstrap.sh

curl --fail --silent --show-error --location \
  "https://raw.githubusercontent.com/donghyeon-encored/PRarness/${prarness_ref}/.github/agent-pipeline/cloud-environment-bootstrap.sh" \
  --output "$installer_path"

PRARNESS_BOOTSTRAP_REF="$prarness_ref" bash "$installer_path"
```

The environment installer downloads `runtime-manifest.json`, verifies every
SHA-256, installs the compatible runtime, and configures GitHub under:

```text
$HOME/.local/share/prarness/<commit-sha>/
$HOME/.local/bin/prarness-github-setup
$HOME/.local/bin/prarness-repository-check
$HOME/.local/bin/prarness-github
$HOME/.local/bin/prarness-publish
$HOME/.local/bin/prarness-session
```

It then discovers the target from the checkout remote, the Cloud repository
context, or the App installations and checkout HEAD. Set
`CODEX_GITHUB_REPOSITORY=OWNER/REPOSITORY` only when discovery is genuinely
ambiguous, such as two forks containing the same commit.

Maintenance must run because Cloud containers may be cached longer than the
roughly one-hour GitHub App installation token. Each maintenance run mints and
verifies a fresh token before the agent starts. Secrets are unavailable during
the later agent phase by design; the repository-scoped token and credential
helper created during setup are what the task uses.

The canonical Issue/PR command downloads the immutable intake runtime's
installer and runs it with
`PRARNESS_BOOTSTRAP_SKIP_GITHUB_SETUP=true`. This verifies and switches the
runtime without downgrading, replacing, or exposing the credential created by
setup/maintenance. It then runs `prarness-github-setup --verify` before
preparation.

## Cloud task contract

The canonical intake Issue comment renders an exact
repository/Issue/branch-bound command. It has this shape, with real values
already substituted:

```text
@codex Run one complete managed PRarness session for OWNER/REPOSITORY, source Issue #ISSUE, and managed branch BRANCH.

Before inspecting or editing code, run the exact intake-SHA bootstrap, prarness-github-setup --verify, and branch-bound prarness-session prepare commands printed here. Prepare creates or reuses the canonical draft PR with the verified repository App. Read the returned instructions path and continue through plan, implementation, self-review, validate, and publish in this same task. Do not use make_pr or create a replacement branch/PR. Completion requires status=PUBLICATION_VERIFIED, complete=true, and verified=true.
```

The task must run `prarness-session prepare` before code inspection. The first
branch-bound prepare uses the App credential to create or reuse the canonical
same-repository draft PR, fetches its managed branch, and checks out its exact
head. Every prepare verifies the live Issue, canonical Actions-authored intake
state, PR, source/bootstrap/runtime SHAs, checkout HEAD, repository policy, and
GitHub capabilities. It also builds the CodeGraph, performs R&R-based minimal
Issue assignment, and publishes the initial progress table. The new PR body
contains the exact PR-bound `@codex` command used for later continuations.
The pinned `prompts/cloud-session.md` then defines the one-commit
analysis/plan/implement/review/validate/publish contract. Publication rebuilds
the CodeGraph from the actual diff, selects PR assignees and a reviewer,
recomputes deterministic risk, posts low-risk review comments, and tags the
selected human for high-risk findings.

`prepare` and `validate` deliberately return `complete=false` and
`verified=false`; this prevents an intermediate CLI success from being
mistaken for lifecycle completion. Only `publish` may return the verified
completion receipt. A regular Codex Summary is not a PRarness receipt.

Publication fails closed when:

- the token is missing, expired, incomplete, or lacks required App permissions;
- `origin`, repository config, branch, Issue, PR, or any bound SHA differs;
- the remote branch moved after preparation;
- paths exceed the declared plan or touch protected files;
- validation evidence differs from repository policy;
- the plan/review artifacts do not match the Issue, iteration, policy commands,
  allowed paths, or exact implementation SHA;
- R&R cannot produce an assignable Issue owner or PR assignee;
- a low-risk must-fix finding remains after the same-task self-review;
- the implementation has zero/multiple commits, missing trailers, binary
  changes, renames, or more than 400 changed lines;
- the live PR, canonical comments, or required CI checks do not reconcile.

## Operational recovery

The workflow is idempotent. Re-running intake reuses the managed branch and
canonical comment and recovers the App-created open draft PR after Cloud has
claimed the branch. If the Cloud token expires or publication fails, allow
maintenance to refresh the credential and start a new human `@codex`
continuation on the same PR. Never create an untracked replacement PR,
force-push, or claim success from local state alone.
