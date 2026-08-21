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
.github/agent-pipeline/pipeline.mjs  deterministic controller and publisher
.github/agent-pipeline/cloud-bridge.mjs  Codex Cloud relay contract
.github/agent-pipeline/prompts/      model stage contracts
.github/agent-pipeline/schemas/      structured-output and state schemas
.github/agent-pipeline/test/         policy and controller regression tests
.github/agent-pipeline/team.yaml     ownership and risk policy
.github/workflows/issue-review.yml   GitHub Actions orchestration
docs/git-ground-rules.md             authoritative repository policy
```

## Before enabling the workflow

The committed workflow contains secret names but no secret values. A human
maintainer must review the protected workflow and ownership files, replace the
placeholder accounts in `.github/agent-pipeline/team.yaml`, install the
repository-scoped GitHub App, and configure the referenced repository variable
and App secret through GitHub settings. For this public repository the workflow
only archives SHA-bound Cloud requests and fails closed; authenticated execution
belongs to an external, non-Actions relay. See [the Cloud relay runbook](docs/codex-cloud-migration.md).

Never commit an App private key, API key, `.env` file, local `.npmrc`, or runner
artifact. See [the publication checklist](docs/publication-checklist.md),
[`.gitignore`](.gitignore), and
[`docs/git-ground-rules.md`](docs/git-ground-rules.md) for the publication and
trust-boundary rules.

## License

MIT
