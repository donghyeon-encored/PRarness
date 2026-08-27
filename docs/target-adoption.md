# Target repository adoption

PRarness target repositories use a central runtime and keep only
repository-specific policy. Do not copy `.github/agent-pipeline/**`, its tests,
prompts, schemas, or PRarness ground rules into a target checkout.

## Minimal target configuration

Commit and protect `.github/prarness.yml`:

```yaml
version: 1

runtime:
  contract: 1

publication:
  mode: codex_cloud_direct
  branch_prefix: agent/issue-

ownership:
  source: codeowners
  fallback: your-maintainer-login

validation:
  commands:
    - npm run lint
    - npm test

ci:
  required: true
  trigger: pull_request
  workflow: prarness-ci.yml
  app_slug: github-actions
  required_checks:
    - validation / PRarness validation
  timeout_seconds: 900

protected_paths:
  additional:
    - infra/production/**
```

Keep `AGENTS.md` or `CLAUDE.md` only for the target application's own
development instructions. Remove copied central rules and any legacy statement
that prohibits a Codex Cloud worker from updating its source Issue, canonical
comments, managed branch, or draft PR. The worker remains forbidden to write
outside that scope, force-push, approve, or merge.

## Cloud environment

Configure the SHA-pinned loader from `docs/codex-cloud-migration.md` as both the
setup and maintenance script. Add `AGENT_APP_ID` and `AGENT_APP_PRIVATE_KEY` to
the Cloud environment once; no target Actions secret or repository variable is
needed. The ordinary App installation needs Contents, Issues, Pull requests,
Actions, Checks, and Deployments write permission. The setup discovers a remote-less checkout when unambiguous;
`CODEX_GITHUB_REPOSITORY=OWNER/REPO` is only an ambiguity override.

The loader installs the reviewed runtime outside the Git checkout. Nothing
under `$HOME/.local/share/prarness/` appears in the target diff or commit.

If the target has no existing secret-free CI, keep this thin caller as
`.github/workflows/prarness-ci.yml` and replace the ref with the same reviewed
40-character PRarness commit used by Cloud setup:

```yaml
name: PRarness CI

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  validation:
    uses: donghyeon-encored/PRarness/.github/workflows/reusable-validation.yml@REVIEWED_40_CHARACTER_COMMIT_SHA
```

The reusable workflow checks out the exact caller revision and runs only the
commands protected in `.github/prarness.yml`. It receives no repository secret
and grants only `contents: read`. Repositories with language-specific setup or
deployment logic may point the CI contract at their existing workflow instead.

## Migration order

1. Add and protect `.github/prarness.yml`.
2. Remove conflicting legacy publication instructions.
3. Configure the same pinned loader in Cloud setup and maintenance.
4. Confirm `prarness-repository-check` and
   `prarness-github-setup --verify-write` pass before model work.
5. Run one implementation canary and accept it only when `prarness-publish`
   returns a verified PR URL, matching remote SHA, both App-authored canonical
   comment IDs, and successful required CI checks.
6. Remove the target's copied PRarness runtime only after the new path passes.
7. Start the central `github-app-controller.mjs` webhook receiver and relay
   dispatcher, then remove the target's large Issue controller. Keep only the
   secret-free CI workflow named by `.github/prarness.yml`.

Do not perform step 7 from source availability alone. Confirm the public
webhook health check, a signed GitHub delivery in the spool, successful Cloud
dispatch, and a reconciled canary receipt first. Until then the target's
existing Issue trigger remains the recovery path.

Steps 6 and 7 are intentionally separate. The Cloud runtime installer replaces
vendored execution files; the central controller receives GitHub events and
uses App-authored comments/checks as the return channel. Deleting the existing
workflow before the controller service is listening would silently disable
Issue intake.

## End state

The end state is a protected `.github/prarness.yml` plus a secret-free CI/CD
workflow (or an existing repository workflow selected by that config). GitHub
App webhooks replace the target Issue controller. Central PRarness is the only
source for prompts, schemas, authentication, publication, reconciliation, and
runtime contract versions.
