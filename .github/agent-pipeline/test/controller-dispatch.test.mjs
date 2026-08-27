import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dispatchControllerJob } from "../controller-dispatch.mjs";

test("controller dispatcher submits one SHA-bound Cloud task with existing ChatGPT auth", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prarness-controller-dispatch-"));
  const codex = join(directory, "codex");
  const jobPath = join(directory, "job.json");
  const configPath = join(directory, "config.json");
  const queryPath = join(directory, "query.txt");
  const countPath = join(directory, "count.txt");
  const listCountPath = join(directory, "list-count.txt");
  const keyPath = join(directory, "app.pem");
  const sha = "a".repeat(40);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await writeFile(codex, `#!/usr/bin/env bash
set -euo pipefail
if [[ $1 == --version ]]; then printf '%s\n' 'codex-cli 0.145.0'; exit 0; fi
if [[ $1 == login && $2 == status ]]; then printf '%s\n' 'Logged in using ChatGPT'; exit 0; fi
if [[ $1 == cloud && $2 == exec ]]; then
  cat > ${JSON.stringify(queryPath)}
  printf '%s\n' run >> ${JSON.stringify(countPath)}
  printf '%s\n' 'https://chatgpt.com/codex/tasks/task_123'
  exit 0
fi
if [[ $1 == cloud && $2 == list ]]; then
  if [[ ! -f ${JSON.stringify(listCountPath)} ]]; then
    : > ${JSON.stringify(listCountPath)}
    printf '%s\n' '{"tasks":[],"cursor":null}'
    exit 0
  fi
  printf '%s\n' '{"tasks":[{"id":"task_123","status":"ready"}],"cursor":null}'
  exit 0
fi
exit 2
`);
  await chmod(codex, 0o700);
  await writeFile(jobPath, JSON.stringify({
    version: 1,
    app_id: 42,
    delivery_id: "delivery-12345678",
    request_id: "gh-request-12345678",
    repository: "owner/repo",
    installation_id: 123,
    operation: "dispatch",
    stage: "triage",
    issue: 1,
    pr: null,
    sha: null,
    received_event: "issues",
    received_action: "opened",
  }));
  await writeFile(configPath, JSON.stringify({
    version: 1,
    app_id: 42,
    github_app_private_key_file: keyPath,
    codex_cli: codex,
    expected_cli_version: "0.145.0",
    repositories: {
      "owner/repo": {
        environment_id: "environment-123",
        runtime_ref: "b".repeat(40),
        default_branch: "main",
      },
    },
  }));
  const env = { ...process.env };
  let tokenRequests = 0;
  const fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === "/app/installations/123/access_tokens") {
      tokenRequests += 1;
      assert.match(options.headers.authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      assert.deepEqual(JSON.parse(options.body).permissions, { contents: "read", issues: "read", pull_requests: "read" });
      return new Response(JSON.stringify({ token: "controller-installation-token", expires_at: "2099-01-01T00:00:00Z" }), { status: 201 });
    }
    assert.equal(options.headers.authorization, "Bearer controller-installation-token");
    if (path.includes("/commits/")) return new Response(JSON.stringify({ sha }));
    if (path.includes("/issues/1/comments")) return new Response(JSON.stringify([{ id: 88, html_url: "https://github.com/owner/repo/issues/1#issuecomment-88", updated_at: "2099-01-01T00:00:00Z", body: "done\n\n<!-- prarness-operation:v1 request_id=gh-request-12345678 -->", performed_via_github_app: { id: 42 } }]));
    return new Response(JSON.stringify({ message: `unexpected GitHub path: ${path}` }), { status: 500 });
  };
  const result = await dispatchControllerJob(jobPath, configPath, { cwd: directory, env, fetch, poll_ms: 0, timeout_ms: 1000, receipt_poll_ms: 0, receipt_timeout_ms: 1000 });
  assert.equal(result.source_sha, sha);
  assert.equal(result.execution.task_id, "task_123");
  assert.equal(result.return_receipt.comment_id, 88);
  assert.match(await readFile(queryPath, "utf8"), /Source Issue: #1/);
  assert.match(await readFile(queryPath, "utf8"), new RegExp(`Required checkout SHA: ${sha}`));
  const second = await dispatchControllerJob(jobPath, configPath, { cwd: directory, env, fetch, poll_ms: 0, timeout_ms: 1000, receipt_poll_ms: 0, receipt_timeout_ms: 1000 });
  assert.equal(second.execution.task_id, "task_123");
  assert.equal((await readFile(countPath, "utf8")).trim().split("\n").length, 1);
  assert.equal(tokenRequests, 2);
});

test("controller dispatcher records observation jobs without starting Cloud", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prarness-controller-observe-"));
  const jobPath = join(directory, "job.json");
  const configPath = join(directory, "missing-config.json");
  await writeFile(jobPath, JSON.stringify({
    version: 1,
    request_id: "gh-observe-12345678",
    repository: "owner/repo",
    installation_id: 123,
    issue: 1,
    operation: "reconcile",
    stage: "review",
    dispatchable: false,
  }));
  const result = await dispatchControllerJob(jobPath, configPath);
  assert.match(result.observed_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.execution, undefined);
});

test("controller dispatcher refuses to expose ChatGPT auth to GitHub Actions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prarness-controller-actions-"));
  const jobPath = join(directory, "job.json");
  const configPath = join(directory, "config.json");
  await writeFile(jobPath, JSON.stringify({ version: 1, request_id: "gh-request-12345678", repository: "owner/repo", installation_id: 123, issue: 1, operation: "dispatch", stage: "triage", sha: "a".repeat(40) }));
  await writeFile(configPath, JSON.stringify({ version: 1, app_id: 42, github_app_private_key_file: "/secure/prarness-app.pem", codex_cli: "/bin/false", expected_cli_version: "0.145.0", repositories: { "owner/repo": { environment_id: "environment-123", runtime_ref: "b".repeat(40), default_branch: "main" } } }));
  await assert.rejects(dispatchControllerJob(jobPath, configPath, { env: { ...process.env, GITHUB_ACTIONS: "true" } }), (error) => error.code === "UNSAFE_ACTIONS_CONTEXT");
});
