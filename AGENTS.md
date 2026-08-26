Before working, read:

- `.github/agent-pipeline/team.yaml`
- `docs/git-ground-rules.md`

Those files are the authoritative team and repository policies.

Automated Issue-driven runs must not modify protected pipeline, workflow,
ownership, or secret-related files unless the source Issue explicitly requests
the exact change and the protected-path policy passes.

In an interactive Codex maintenance task, an explicit user request to maintain
those files authorizes editing them. No separate GitHub Issue is required. The
default publication path is a `codex/maintenance-*` branch and draft pull
request. If the user explicitly directs publication to the default branch, the
agent may instead publish one validated fast-forward commit after rechecking
the live default-branch SHA. The agent must not force-push, approve or merge its
own pull request, run untrusted code with secrets, or expose or change secrets
without a separate explicit request. A human must review the final
pull-request head before merge when the draft-PR path is used.
