# Publication checklist

## Before publishing PRarness

- Read `docs/git-ground-rules.md` and `.github/agent-pipeline/team.yaml`.
- Review every workflow permission and every pinned third-party action SHA.
- Run `npm ci --ignore-scripts`, `npm run lint`, and `npm test` on the exact
  commit being published.
- Confirm `runtime-manifest.json` contains every installed runtime file and its
  exact SHA-256.
- Confirm no relay/controller service, `OPENAI_API_KEY`, mutable runtime ref,
  self-hosted runner, or bot-authored `@codex` dispatch is required.
- Confirm default-branch publication is a rechecked fast-forward when the user
  explicitly selected it; otherwise use a `codex/maintenance-*` draft PR.

## Before adopting a target

- Install the GitHub App with Contents, Issues, Pull requests, Actions, Checks,
  and Deployments write permissions on that repository.
- Store `AGENT_APP_ID` and the complete `AGENT_APP_PRIVATE_KEY` only in the
  target Codex Cloud environment setup secrets.
- Configure the identical SHA-pinned installer for Cloud setup and maintenance.
- Commit protected `.github/prarness.yml` with the exact `owner/repository`,
  validation commands, CI identity/check names, and extra protected paths.
- Commit the thin hostless intake caller and a secret-free PR validation
  workflow; never use `pull_request_target`.
- Remove vendored PRarness runtime/policy and legacy rules that prohibit the
  Cloud worker's scoped GitHub writes.
- Run one Issue canary through the Actions bootstrap branch, human Issue
  `@codex`, App-created draft PR, Cloud publication, and independent CI
  reconciliation.

## Never publish

- GitHub App private keys, installation tokens, API keys, environment exports,
  `.env*`, `.npmrc`, `.netrc`, PEM/P12 files, or captured credential-helper
  output.
- Cloud task payloads, local auth metadata, logs containing headers, temporary
  request/session files, nested checkouts, caches, build output, or demo data.
- A mutable `main`, tag, or abbreviated SHA as the downloaded runtime identity.

If a credential ever enters Git history, rotate it and use a separately
reviewed incident procedure. Ignore rules do not make committed secrets safe.
