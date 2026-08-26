# Public repository checklist

Use this checklist before the first public push and again before every manual
bootstrap or migration.

## Commit these files

- Pipeline source, prompts, schemas, and tests under `.github/agent-pipeline/`
- `package.json` files and their lockfiles
- Documentation, schemas, prompts, and policy files
- The workflow definition after a human security review
- `.gitignore`, `.gitattributes`, and `LICENSE`

The workflow contains names of repository secrets and variables. Those names
are configuration, not credentials, and are safe to publish.

## Never commit these files

- `.env` files or local configuration overrides
- GitHub App private keys, API keys, access tokens, or package-registry auth
- `.npmrc`, `.netrc`, certificate containers, or private-key files
- `node_modules`, coverage, build output, caches, or logs
- Agent event/state payloads, patches, artifacts, nested checkouts, or demo apps
- IDE, assistant, and operating-system metadata such as `.DS_Store`

The matching patterns live in the repository root `.gitignore`. Ignore rules
do not make an already committed secret safe; if a secret ever enters Git
history, rotate it and remove it through a separately reviewed incident
procedure.

## Human review required before activation

- Replace placeholder accounts in `.github/agent-pipeline/team.yaml` with real,
  active, assignable collaborators.
- Confirm branch protection, Actions permissions, and CODEOWNERS coverage meet
  `docs/git-ground-rules.md`.
- Install a repository-scoped GitHub App with only the permissions required by
  the deterministic publisher, including Actions write permission so a
  successful publication can dispatch the next trusted default-branch review
  cycle.
- Add `AGENT_APP_ID` as a repository variable.
- Add `AGENT_APP_PRIVATE_KEY` as a repository secret. Never place its value in
  this checkout or expose it to a Cloud relay job.
- Keep the ChatGPT-authenticated host outside GitHub Actions. For a public
  repository, do not register that account as a self-hosted runner or copy
  `auth.json` into Actions.
- Configure the pinned CLI path only in the external relay's local service
  configuration; never expose that service account to repository jobs.
- Create a secret-free, repository-specific Codex Cloud environment and add its
  ID as the `CODEX_CLOUD_ENV_ID` repository variable. Disable agent internet and
  keep GitHub credentials out of setup and maintenance scripts.
- Run `npm ci --ignore-scripts`, `npm run lint`, and `npm test` on the exact
  source snapshot that will be published.
- Confirm that the secret-free `Pull request validation` check runs on
  `codex/maintenance-*` and `agent/issue-*` pull requests. A green gate-only
  no-op is not sufficient validation.

Automated Issue work that touches protected workflow, pipeline, ownership, or
policy files must follow the Issue approval process in
`docs/git-ground-rules.md`. For interactive maintenance, the user's direct
request authorizes publication without a synthetic Issue. Use a
`codex/maintenance-*` draft PR by default; when the user explicitly requests the
default branch, re-fetch its live SHA and publish one validated fast-forward
commit. The final PR head still requires human review before merge when the PR
path is used. Never force-push either path.
