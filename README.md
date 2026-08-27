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
.github/agent-pipeline/cloud-publish.mjs  SHA-bound Cloud branch/PR publisher
.github/agent-pipeline/runtime-manifest.json  immutable runtime file checksums
.github/agent-pipeline/prompts/      model stage contracts
.github/agent-pipeline/schemas/      structured-output and state schemas
.github/agent-pipeline/test/         policy and controller regression tests
.github/agent-pipeline/team.yaml     ownership and risk policy
.github/prarness.yml                 this repository's target adapter contract
.github/workflows/issue-review.yml   trusted default-branch controller
.github/workflows/pr-validation.yml  secret-free pull-request validation
docs/git-ground-rules.md             authoritative repository policy
```

## Before enabling the workflow

The committed workflow contains secret names but no secret values. A human
maintainer must review the protected workflow and ownership files, replace the
remaining placeholder accounts in `.github/agent-pipeline/team.yaml`, install the
repository-scoped GitHub App, and configure the referenced repository variable
and App secret through GitHub and Codex Cloud settings. Configure every target
repository's Cloud setup and maintenance scripts with the same SHA-pinned
installer snippet from the Cloud relay runbook. It installs the central runtime
outside the checkout, detects the target repository, supplies `origin` plus
non-interactive `gh` authentication, and refreshes short-lived App credentials
on cached-container maintenance. Before model work, the runtime requires an
explicit `.github/prarness.yml` opt-in and rejects legacy publication rules.
For code-bearing results, `prarness-publish` is successful only after the live
remote branch and pull-request head both match the local commit.

The public controller still archives SHA-bound Cloud requests and fails closed
at the external relay boundary until a trusted result mailbox is deployed. A
target must not delete its existing trigger/controller merely because the
Cloud runtime installer is available; migrate to the thin adapter only after a
central reusable controller or GitHub App webhook controller is live. See [the
Cloud relay runbook](docs/codex-cloud-migration.md) and [the target adoption
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
