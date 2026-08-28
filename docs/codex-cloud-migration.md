# Codex Cloud hostless runbook

PRarness uses ChatGPT-authenticated Codex Cloud. It does not use
`OPENAI_API_KEY`, a self-hosted runner, an external webhook service, or a relay
daemon. The unavoidable dispatch boundary is one human `@codex` comment on the
bootstrap draft PR.

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

Use the same script in both Cloud setup and maintenance, replacing the SHA only
after the reviewed PRarness commit is published:

```bash
set -euo pipefail
set +x

prarness_ref=REVIEWED_40_CHARACTER_COMMIT_SHA
installer_path=/tmp/prarness-cloud-environment-bootstrap.sh

curl --fail --silent --show-error --location \
  "https://raw.githubusercontent.com/donghyeon-encored/PRarness/${prarness_ref}/.github/agent-pipeline/cloud-environment-bootstrap.sh" \
  --output "$installer_path"

PRARNESS_BOOTSTRAP_REF="$prarness_ref" bash "$installer_path"
```

The installer downloads `runtime-manifest.json`, verifies every SHA-256, and
installs the runtime under:

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

## Cloud task contract

The bootstrap PR tells the human to post:

```text
@codex Execute the PRarness request in this pull request. Run the installed prarness-session command first and complete the linked Issue in one Cloud task.
```

The task must run `prarness-session prepare` before code inspection. That
command verifies the live Issue, canonical Actions-authored intake state,
same-repository PR, source/bootstrap/runtime SHAs, checkout HEAD, repository
policy, and GitHub capabilities. It also builds the CodeGraph, performs
R&R-based minimal Issue assignment, and publishes the initial progress table.
The pinned `prompts/cloud-session.md` then defines the one-commit
analysis/plan/implement/review/validate/publish contract. Publication rebuilds
the CodeGraph from the actual diff, selects PR assignees and a reviewer,
recomputes deterministic risk, posts low-risk review comments, and tags the
selected human for high-risk findings.

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

The workflow is idempotent. Re-running intake reuses the open managed branch,
draft PR, and canonical comment. If the Cloud token expires or publication
fails, allow maintenance to refresh the credential and start a new human
`@codex` continuation on the same PR. Never create an untracked replacement PR,
force-push, or claim success from local state alone.
