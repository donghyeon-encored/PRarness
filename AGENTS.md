Before working, read:

- `.github/agent-pipeline/team.yaml`
- `docs/git-ground-rules.md`

Those files are the authoritative team and repository policies.

Automated Issue-driven runs must not modify protected pipeline, workflow,
ownership, policy, or secret-related files. Those changes use interactive
maintenance after an explicit user request.

Codex Cloud workers are expected to manage the source Issue, canonical
comments, `agent/issue-*` branch, commit, draft pull request, and configured CI
directly. The Cloud environment installs the pinned repository-independent
bootstrap and refreshes the repository App credential before the agent phase.
The exact human Issue/PR command then self-installs the canonical intake
runtime SHA without rewriting that credential. Run its
`$HOME/.local/bin/prarness-github-setup --verify OWNER/REPO`, then run
`$HOME/.local/bin/prarness-session prepare` with the repository, source Issue,
and the exact managed branch from the first Issue task or canonical PR from a
later task. On the first run, prepare uses the verified repository GitHub App
to create or reuse the draft PR and check out its branch. Follow the returned pinned
`prompts/cloud-session.md` contract through validation and publication. Use
`prarness-github` for separately verified Issue, comment, CI, deployment, and
reconcile operations instead of asking a person to log in. Keep writes scoped
to the source Issue and its managed branch/PR, never force-push or merge, and
never print or extract the configured credential.

In an interactive Codex maintenance task, an explicit user request to maintain
those files authorizes editing them. No separate GitHub Issue is required. The
default publication path is a `codex/maintenance-*` branch and draft pull
request. If the user explicitly directs publication to the default branch, the
agent may instead publish one validated fast-forward commit after rechecking
the live default-branch SHA. The agent must not force-push, approve or merge its
own pull request, run untrusted code with secrets, or expose or change secrets
without a separate explicit request. A human must review the final
pull-request head before merge when the draft-PR path is used.
