# Target repository adoption

Each target keeps a thin adapter. Replace every placeholder SHA below with the
same reviewed 40-character PRarness commit.

## 1. Repository configuration

Commit and protect `.github/prarness.yml`:

```yaml
version: 1
repository: OWNER/REPOSITORY

runtime:
  contract: 1

dispatch:
  mode: human_pr_mention
  label: agent:run
  auto_on_open_for_trusted: true

publication:
  mode: codex_cloud_direct
  branch_prefix: agent/issue-

ownership:
  source: codeowners
  fallback: MAINTAINER_LOGIN
  max_issue_assignees: 1
  max_pr_assignees: 3

codegraph:
  max_files: 5000
  blame_lookback_days: 365

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

`repository` prevents a copied adapter from silently writing to the wrong
repository. Keep target-specific development instructions in `AGENTS.md` or
`CLAUDE.md`, but remove copied PRarness policy and any legacy rule that blocks
the Cloud worker's scoped Issue/branch/PR writes.

With `ownership.source: codeowners`, PRarness expands the last matching
`CODEOWNERS` rule into file-level R&R and combines it with Issue text, related
files, recent commits, and blame evidence. The configured fallback is the
catch-all reviewer when no more specific owner is available. Repositories that
need label/domain/keyword routing can use `ownership.source: config` and add a
protected `ownership.people` list. Each person declares `github`, `active`,
`responsibilities` (`domains`, `labels`, `keywords`, `paths`), and `review`
(`can_review`, `high_risk_domains`, `high_risk_paths`). This is repository data,
not a copy of the central runtime.

## 2. Hostless intake workflow

Commit `.github/workflows/prarness-intake.yml`:

```yaml
name: PRarness Issue intake

on:
  issues:
    types: [opened, reopened, labeled]
  issue_comment:
    types: [created]
  workflow_dispatch:
    inputs:
      issue_number:
        description: Existing source Issue number
        required: true
        type: number

permissions: read-all

concurrency:
  group: prarness-intake-${{ github.event.issue.number || inputs.issue_number || github.run_id }}
  cancel-in-progress: false

jobs:
  intake:
    if: github.event_name != 'issue_comment' || !github.event.issue.pull_request
    permissions:
      contents: write
      issues: write
      pull-requests: write
    uses: donghyeon-encored/PRarness/.github/workflows/reusable-intake.yml@REVIEWED_40_CHARACTER_COMMIT_SHA
    with:
      runtime_ref: REVIEWED_40_CHARACTER_COMMIT_SHA
```

This workflow has no repository secret. Its scoped `GITHUB_TOKEN` creates only
the bootstrap branch, draft PR, labels, and canonical intake comment.

## 3. Secret-free CI

Use an existing PR workflow or add `.github/workflows/prarness-ci.yml`:

```yaml
name: PRarness CI

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read

jobs:
  validation:
    uses: donghyeon-encored/PRarness/.github/workflows/reusable-validation.yml@REVIEWED_40_CHARACTER_COMMIT_SHA
```

The configured `required_checks` strings must exactly match the resulting live
check names.

## 4. Cloud environment

Create/select the Codex Cloud environment connected to the target repository.
Use the runbook in `codex-cloud-migration.md` for both setup and maintenance.
Store the GitHub App ID and private key there once. Do not add them to GitHub
Actions secrets or repository files.

## 5. First canary

1. Open a trusted test Issue or apply the configured `agent:run` label.
2. Confirm Actions creates one draft PR and one canonical Issue comment.
3. On the draft PR, a connected human copies the documented `@codex` command.
   The generated command contains the exact repository, Issue, canonical PR,
   setup verification, prepare arguments, and publication receipt requirement;
   do not replace it with a shorter generic prompt.
4. Confirm preparation returns `PREPARED_NOT_PUBLISHED`, assigns one Issue
   owner, and posts the R&R/CodeGraph
   problem-progress comment, starts at the bootstrap head, removes the
   transient request manifest, creates exactly one implementation commit, and
   pushes it.
5. Accept success only when publish returns `PUBLICATION_VERIFIED` with
   `complete=true` and `verified=true`, and the remote branch SHA, live PR head,
   reviewer assignment, canonical review comments, and all configured checks
   agree.

After the canary, remove copied `.github/agent-pipeline/**`, copied prompts,
schemas, tests, and central policy from the target. The thin adapter files above
are the intended steady state.
