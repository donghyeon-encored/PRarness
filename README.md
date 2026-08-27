# PRarness

PRarness is the reusable core of a deterministic issue-to-pull-request agent
pipeline. It contains the controller, prompts, schemas, tests, workflow, and
repository policy needed to triage an issue, plan and implement a bounded
change, review the exact pull-request head, and hand the result to a human.

This repository intentionally contains no mock product. The runnable recipe
scaler used for end-to-end experiments lives in a separate `PRarness-demo`
repository. Target repositories opt in with a small repository-specific
configuration; Codex Cloud installs a reviewed, checksum-verified PRarness
runtime temporarily instead of committing a copy of this core into the target.

## Validate the core

Requirements: Node.js 20 or newer.

```bash
npm ci --ignore-scripts
npm run lint
npm test
```

## Repository map

```text
.github/agent-pipeline/pipeline.mjs  deterministic controller and GitHub helpers
.github/agent-pipeline/cloud-bridge.mjs  Codex Cloud relay contract
.github/agent-pipeline/cloud-environment-bootstrap.sh  reusable Cloud installer
.github/agent-pipeline/cloud-github-setup.sh  generic Cloud remote/gh bootstrap
.github/agent-pipeline/repository-check.mjs  target opt-in/policy compatibility gate
.github/agent-pipeline/cloud-github.mjs  verified Issue/comment/CI/deployment/reconcile operations
.github/agent-pipeline/cloud-publish.mjs  SHA-bound Cloud branch/PR publisher
.github/agent-pipeline/github-app-controller.mjs  signed webhook ingress and idempotent dispatch spool
.github/agent-pipeline/controller-dispatch.mjs  private repo mapping to ChatGPT-authenticated Cloud submit
.github/agent-pipeline/runtime-manifest.json  immutable runtime file checksums
.github/agent-pipeline/prompts/      model stage contracts
.github/agent-pipeline/schemas/      structured-output and state schemas
.github/agent-pipeline/test/         policy and controller regression tests
.github/agent-pipeline/team.yaml     ownership and risk policy
.github/prarness.yml                 this repository's target adapter contract
.github/workflows/issue-review.yml   trusted default-branch controller
.github/workflows/pr-validation.yml  secret-free pull-request validation
.github/workflows/reusable-validation.yml  secret-free target CI entry point
docs/git-ground-rules.md             authoritative repository policy
```

## Enable the control plane

Install one GitHub App on every managed repository. Its ordinary runtime
permissions are Contents, Issues, Pull requests, Actions, Checks, and
Deployments write; Workflows write is added only to the separately authorized
adapter/workflow maintenance path. Keep the App private key and webhook secret
in the central controller/Cloud environment, never in a target repository.

Run `github-app-controller.mjs serve` behind HTTPS to verify GitHub webhook
signatures and queue Issue, canonical comment, managed PR, check, and workflow
events exactly once. Its `drain` command hands those normalized jobs to the
ChatGPT-authenticated Codex Cloud relay. GitHub is the durable result channel:
the next event is accepted only after the App-authored comment, live PR head,
and required check state exist on GitHub. There is no target Actions secret or
`AGENT_APP_ID`/`CODEX_CLOUD_ENV_ID` repository variable in this path.

Configure each target Cloud environment with the SHA-pinned installer from the
Cloud runbook. It installs the central runtime outside the checkout, repairs
`origin`, configures non-interactive App authentication, records the App and
installation identity, and proves every required write capability. The
publisher verifies the live branch, draft PR, canonical Issue/PR comments, and
all configured CI checks before emitting `verified: true`. Expiring credentials
produce `TOKEN_REFRESH_REQUIRED`; the idempotent controller then starts a fresh
continuation instead of reporting a partial success. See [the Cloud relay
runbook](docs/codex-cloud-migration.md) and [the target adoption
guide](docs/target-adoption.md).

Never commit an App private key, API key, `.env` file, local `.npmrc`, or runner
artifact. See [the publication checklist](docs/publication-checklist.md),
[`.gitignore`](.gitignore), and
[`docs/git-ground-rules.md`](docs/git-ground-rules.md) for the publication and
trust-boundary rules.

Automated Issue work uses `agent/issue-*` branches. Codex Cloud is expected to
update the Issue, comments, branch, commits, and draft PR directly with the
authenticated `gh` CLI. An explicit request in an interactive Codex task may
publish maintenance changes without first creating a synthetic Issue. The
default is a `codex/maintenance-*` draft PR; an explicit instruction to publish
to the default branch permits one validated fast-forward commit. Force-push and
self-approval/self-merge remain forbidden.

## License

MIT
