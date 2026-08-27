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
- Install a repository-scoped GitHub App with Contents, Issues, Pull requests,
  Actions, and Workflows write permission, or create an equivalently scoped
  fine-grained token for the Codex Cloud worker.
- Add `AGENT_APP_ID` as a repository variable.
- Add `AGENT_APP_PRIVATE_KEY` as a repository secret. Never place its value in
  this checkout or expose it to the external relay. Its value must be the full
  downloaded PEM contents, including the `BEGIN` and `END` lines, rather than a
  path to the `.pem` file. When a secret editor cannot retain multiline values,
  use a base64 encoding of the complete PEM with the literal `base64:` prefix;
  the bootstrap also accepts literal `\n` separators and matching outer quotes.
- Keep the ChatGPT-authenticated host outside GitHub Actions. For a public
  repository, do not register that account as a self-hosted runner or copy
  `auth.json` into Actions.
- Configure the pinned CLI path only in the external relay's local service
  configuration; never expose that service account to repository jobs.
- Create or select a Codex Cloud environment for the target repository and add
  its ID as the `CODEX_CLOUD_ENV_ID` repository variable. In that environment, add
  either `CODEX_GITHUB_TOKEN` or `AGENT_APP_ID` plus
  `AGENT_APP_PRIVATE_KEY` (and optionally `AGENT_APP_INSTALLATION_ID`) as setup
  credentials. Never put their values in repository files.
- Install the configured GitHub App on every intended target repository. A
  checkout without a GitHub remote is matched automatically against accessible
  repositories by its HEAD commit. Set `CODEX_GITHUB_REPOSITORY=OWNER/REPO`
  only to resolve multiple matches, such as forks sharing the same commit;
  never hard-code a target repository in the setup script.
- Configure both the Cloud setup script and maintenance script with the same
  SHA-pinned, repository-independent installer from
  `docs/codex-cloud-migration.md`. It installs
  `$HOME/.local/bin/prarness-github-setup`, detects the target repository,
  repairs `origin`, mints or loads the repository-scoped credential, selects
  the default repo, and verifies Git/API access without an interactive login.
- Run `npm ci --ignore-scripts`, `npm run lint`, and `npm test` on the exact
  source snapshot that will be published.
- Confirm that the credential-isolated `Pull request validation` check runs on
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
