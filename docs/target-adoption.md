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
setup and maintenance script. Add either `CODEX_GITHUB_TOKEN`, or
`AGENT_APP_ID` and `AGENT_APP_PRIVATE_KEY`, to the Cloud environment once. The
ordinary App installation needs Contents, Issues, and Pull requests write
permission. The setup discovers a remote-less checkout when unambiguous;
`CODEX_GITHUB_REPOSITORY=OWNER/REPO` is only an ambiguity override.

The loader installs the reviewed runtime outside the Git checkout. Nothing
under `$HOME/.local/share/prarness/` appears in the target diff or commit.

## Migration order

1. Add and protect `.github/prarness.yml`.
2. Remove conflicting legacy publication instructions.
3. Configure the same pinned loader in Cloud setup and maintenance.
4. Confirm `prarness-repository-check` and
   `prarness-github-setup --verify-write` pass before model work.
5. Run one implementation canary and accept it only when `prarness-publish`
   returns a verified PR URL and matching remote SHA.
6. Remove the target's copied PRarness runtime only after the new path passes.
7. Replace the target's large workflow with a minimal trigger only after the
   central reusable controller or GitHub App webhook controller and signed
   result mailbox are deployed.

Steps 6 and 7 are intentionally separate. The Cloud runtime installer replaces
vendored execution files; it does not itself receive GitHub Issue events or
return Cloud stage results to the controller. Deleting the existing workflow
before that controller exists would silently disable automation.

## End state

The near-term end state is a protected `.github/prarness.yml` plus one thin
trigger that calls a pinned central reusable controller. The long-term
zero-footprint option is a GitHub App webhook controller, after which even the
target workflow can be removed. In both cases, central PRarness is the only
source for prompts, schemas, authentication, publication logic, and runtime
contract versions.
