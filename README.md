# PRarness

PRarness is the reusable core of a deterministic issue-to-pull-request agent
pipeline. It contains the controller, prompts, schemas, tests, workflow, and
repository policy needed to triage an issue, plan and implement a bounded
change, review the exact pull-request head, and hand the result to a human.

This repository intentionally contains no mock product. The runnable recipe
scaler used for end-to-end experiments lives in a separate `PRarness-demo`
repository, which vendors a reviewed snapshot of this core.

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
.github/agent-pipeline/cloud-github-setup.sh  Cloud remote/gh bootstrap
.github/agent-pipeline/prompts/      model stage contracts
.github/agent-pipeline/schemas/      structured-output and state schemas
.github/agent-pipeline/test/         policy and controller regression tests
.github/agent-pipeline/team.yaml     ownership and risk policy
.github/workflows/issue-review.yml   trusted default-branch controller
.github/workflows/pr-validation.yml  secret-free pull-request validation
docs/git-ground-rules.md             authoritative repository policy
```

## Before enabling the workflow

The committed workflow contains secret names but no secret values. A human
maintainer must review the protected workflow and ownership files, replace the
remaining placeholder accounts in `.github/agent-pipeline/team.yaml`, install the
repository-scoped GitHub App, and configure the referenced repository variable
and App secret through GitHub and Codex Cloud settings. Configure the Cloud
environment setup and maintenance scripts to run
`bash .github/agent-pipeline/cloud-github-setup.sh OWNER/REPO`; this supplies the
Cloud worker with `origin` and non-interactive `gh` authentication. For this
public repository the workflow still archives SHA-bound Cloud requests and
fails closed until the external relay return channel is connected. See [the
Cloud relay runbook](docs/codex-cloud-migration.md).

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
