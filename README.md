# PRarness

PRarness is a reusable Issue-to-draft-PR harness for Codex Cloud. It does not
require an always-on relay, a self-hosted runner, or an OpenAI API key.

The supported hostless flow is deliberately explicit:

1. GitHub Actions accepts an Issue and creates one managed `agent/issue-*`
   branch plus a draft bootstrap PR.
2. A connected human writes the documented `@codex` command on that PR. This
   is the supported ChatGPT-authenticated Cloud dispatch boundary.
3. One Codex Cloud task runs the pinned central runtime, analyzes, plans,
   implements, reviews, validates, commits, pushes, and updates GitHub.
4. Secret-free GitHub Actions CI independently validates the resulting PR.

GitHub is the durable queue and result store. Automation never pretends that a
bot-authored mention started Codex Cloud, and no external process is required
to remember intermediate model stages.

Target repositories keep only a thin adapter: `.github/prarness.yml`, a small
Issue intake workflow, and a CI workflow when they do not already have one.
They do not copy `.github/agent-pipeline/**`, prompts, schemas, or central
policy. The Cloud environment downloads a reviewed full commit SHA into
`$HOME/.local/share/prarness/<sha>/`, verifies every file checksum, and exposes
repository-independent commands under `$HOME/.local/bin`.

## Validate the core

Node.js 20 or newer is required.

```bash
npm ci --ignore-scripts
npm run lint
npm test
```

## Important files

```text
.github/agent-pipeline/hostless-intake.mjs       Issue → bootstrap draft PR
.github/agent-pipeline/cloud-environment-bootstrap.sh
.github/agent-pipeline/cloud-github-setup.sh     remote and GitHub App auth setup
.github/agent-pipeline/cloud-session.mjs         one-session prepare/validate/publish
.github/agent-pipeline/cloud-github.mjs          verified Issue/comment/CI/deploy ops
.github/agent-pipeline/cloud-publish.mjs         SHA-bound commit/branch/PR publisher
.github/agent-pipeline/runtime-manifest.json     pinned runtime checksums
.github/workflows/issue-review.yml               thin repository intake caller
.github/workflows/reusable-intake.yml            central hostless intake workflow
.github/workflows/reusable-validation.yml        secret-free reusable CI
.github/prarness.yml                             repository-specific opt-in
docs/git-ground-rules.md                         authoritative behavior policy
docs/codex-cloud-migration.md                    Cloud environment runbook
docs/target-adoption.md                          cross-repository adapter guide
```

The GitHub App installation used by Cloud needs Contents, Issues, Pull
requests, Actions, Checks, and Deployments write permissions. Credentials live
only in the Codex Cloud environment setup/maintenance phase; target Actions use
their scoped `GITHUB_TOKEN` only for deterministic intake and no target secret.

Automated work never force-pushes, merges, or self-approves. Interactive
maintenance follows the separate publication rules in
[`docs/git-ground-rules.md`](docs/git-ground-rules.md).

## License

MIT
