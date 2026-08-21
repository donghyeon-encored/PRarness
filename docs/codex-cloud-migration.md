# Codex Cloud relay runbook

The public-repository boundary is intentionally staged:

```text
GitHub-hosted gate → SHA-bound Cloud request → audit artifact → fail closed
                                           ↘ trusted local relay → Codex Cloud
                                             (return channel not connected)
```

Triage, plan, review, and implementation requests preserve the existing stage
schemas, policy projection, source/subject SHAs, request nonce, one-attempt
limit, and pinned CLI version. The public workflow never runs a
ChatGPT-authenticated process. Until a separately reviewed result mailbox is
available, it archives the request and stops before verification, App-token
minting, or any publisher job.

## Authentication boundary

The relay uses the already-existing ChatGPT login held by the local Codex CLI.
It never starts an interactive login, copies `auth.json` into Actions, uses a
provider API key, or falls back to usage-based API billing. If the cached login
expires, the relay fails closed.

Do not register the credential-bearing host as a self-hosted Actions runner for
this public repository. GitHub Actions steps share the runner account and could
reach its cached login even when the `codex` subprocess receives a sanitized
environment. The bridge therefore rejects Cloud CLI calls when
`GITHUB_ACTIONS` or `ACTIONS_RUNTIME_TOKEN` is present.

The repository-scoped GitHub App remains the only repository writer. Cloud and
the external relay receive no App private key, GitHub token, PAT, or repository
write capability.

## External relay prerequisites

1. Run a dedicated local daemon under the OS account that already owns the
   ChatGPT Codex session; do not register it as an Actions runner.
2. Pin the reviewed bridge and `codex` executable to the versions recorded in
   the request. Launch the CLI from an empty, relay-owned control directory,
   never from an untrusted checkout.
3. Create a repository-specific Cloud environment with no secrets, no GitHub
   credentials, agent internet disabled, and fixed trusted setup/maintenance.
4. Add its non-secret ID as the repository variable `CODEX_CLOUD_ENV_ID` so
   request construction is deterministic.
5. Keep raw requests, task URLs, task status, downloaded diff hashes, and
   validated results in a relay-local append-only ledger.

The CLI cannot create Cloud environments. If no suitable environment already
exists, execution remains blocked and nobody is prompted to log in.

## Request and result contract

Each request binds stage, exact source SHA, exact work/review subject SHA,
repository, Cloud environment, request nonce, one attempt, and exact CLI
version. The prompt is passed on stdin. Cloud writes a nonce-scoped JSON
sentinel. The bridge downloads the raw diff, hashes it, applies those exact
bytes to an isolated Git index, derives changed paths and payload from that
index, removes the sentinel, and regenerates the publication patch with
external diff helpers disabled.

Read-only stages must leave an empty publication patch. Implementation may
change only the current plan's paths and returns a strict summary payload. The
byte-aware query limit is 4 MiB, covering the configured 5,000-file CodeGraph
while bounding unusually large issue bodies and long-line patches.

Submissions use one attempt and are never retried after an ambiguous response.
Unknown status, timeout, identity mismatch, secret-like context, moving SHA,
unexpected file mode/path, or result mismatch fails closed.

## Deliberately deferred return path

This migration does not yet import relay results into the public workflow.
Doing so safely requires a separately reviewed mailbox with signed envelopes,
pending nonces, exact request/diff hashes, replay prevention, bounded payloads,
and deterministic App-token isolation. A private control repository is the
preferred next phase; an unsigned comment, public self-hosted runner, or raw
`repository_dispatch` payload is not an acceptable shortcut.

After that transport exists, the validated implementation patch must still
pass the original fresh-runner line budget, risk, protected-path, validation,
exact-SHA review, and deterministic App publisher checks. The pipeline never
auto-merges.
