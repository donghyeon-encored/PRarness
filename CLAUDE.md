Before working, read:

- `.github/agent-pipeline/team.yaml`
- `docs/git-ground-rules.md`

Those files are the authoritative team and repository policies. Automated
Issue work starts from the hostless managed branch. The first Cloud prepare
creates or reuses the canonical draft PR with the repository GitHub App; later
tasks reuse that PR. Every task must run the installed `prarness-session
prepare` contract before changing code. It must not modify
protected pipeline, workflow, ownership, policy, or secret-related files. In
interactive maintenance, the user's direct request is the maintenance
authorization described by the ground rules.
