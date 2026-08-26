import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  CloudBridgeError, buildCloudQuery, createRelayReceipt, downloadCloudDiff, parseTaskList,
  materializeCloudResult, parseTaskUrl, sanitizedCloudEnvironment, submitCloudTask, validateCloudRequest, validateCloudResult, waitForCloudTask,
  signRelayReceipt, verifyRelayReceipt,
} from "../cloud-bridge.mjs";

const exec = promisify(execFile);

const request = (overrides = {}) => ({
  version: 1,
  request_id: "issue-1-triage-a1b2c3d4",
  stage: "triage",
  source_sha: "a".repeat(40),
  subject_sha: "a".repeat(40),
  repository: "owner/repo",
  environment_id: "env_12345678",
  attempts: 1,
  expected_cli_version: "0.145.0",
  result_path: ".agent-cloud-output/issue-1-triage-a1b2c3d4/triage.json",
  allowed_paths: [],
  instructions: "Return the triage payload.",
  context: { issue: { number: 1, title: "Bug" } },
  payload_schema: { type: "object" },
  ...overrides,
});

test("validates a SHA-bound request and renders Cloud GitHub bootstrap/direct-write guidance", () => {
  assert.equal(validateCloudRequest(request()).stage, "triage");
  const query = buildCloudQuery(request());
  assert.match(query, /cloud-github-setup\.sh owner\/repo/);
  assert.match(query, /Direct GitHub work is an intended part/);
  assert.match(query, /create or update the source Issue's canonical triage/);
  assert.doesNotMatch(query, /Do not use gh|Never commit, push/);
  assert.match(query, new RegExp("a{40}"));
});

test("implementation workers are told to own their branch, commit, draft PR, and comments", () => {
  const implementation = request({
    request_id: "issue-1-implement-a1b2c3d4",
    stage: "implement",
    result_path: ".agent-cloud-output/issue-1-implement-a1b2c3d4/implement.json",
    allowed_paths: ["src/fix.mjs"],
  });
  const query = buildCloudQuery(implementation);
  assert.match(query, /create or reuse the managed agent\/issue-\* branch/);
  assert.match(query, /create or update its draft PR/);
  assert.match(query, /Never force-push, merge or approve your own PR/);
});

test("rejects unsafe request state and secret-like context keys", () => {
  for (const invalid of [
    request({ attempts: 2 }), request({ source_sha: "main" }),
    request({ context: { github_token: "do-not-send" } }), request({ context: { issue: { body: "Bearer sk-secret-value" } } }),
    request({ context: { issue: {}, unexpected: {} } }),
    request({ result_path: "result.json" }),
  ]) assert.throws(() => validateCloudRequest(invalid), CloudBridgeError);
  for (const body of ["const token = response.token;", "password: string", "api_key = undefined"]) {
    assert.doesNotThrow(() => validateCloudRequest(request({ context: { issue: { body } } })));
  }
});

test("accepts the configured 5,000-file CodeGraph within the byte-aware query bound", () => {
  const codegraph = { nodes: Array.from({ length: 5_000 }, (_, index) => ({ id: `file:f${index}`, type: "file", path: `f${index}` })), edges: [] };
  assert.doesNotThrow(() => validateCloudRequest(request({ request_id: "issue-1-plan-a1b2c3d4", stage: "plan",
    result_path: ".agent-cloud-output/issue-1-plan-a1b2c3d4/plan.json", context: { issue: {}, state: {}, triage: {}, codegraph } })));
});

test("parses only an exact task URL and known list statuses", () => {
  assert.equal(parseTaskUrl("https://chatgpt.com/codex/tasks/task_12345678\n").task_id, "task_12345678");
  assert.equal(parseTaskUrl("https://chatgpt.com/codex/tasks/T-1000").task_id, "T-1000");
  assert.throws(() => parseTaskUrl("https://chatgpt.com/codex/cloud/tasks/task_12345678"), /invalid task URL/);
  assert.throws(() => parseTaskUrl("submitted task_12345678"), /one task URL/);
  assert.equal(parseTaskList(JSON.stringify({ tasks: [{ id: "task_12345678", status: "ready" }], cursor: null })).tasks[0].status, "ready");
  assert.throws(() => parseTaskList(JSON.stringify({ tasks: [{ id: "x", status: "done" }], cursor: null })), /unknown shape or status/);
});

test("passes only the local Codex login environment to the Cloud CLI", () => {
  const env = sanitizedCloudEnvironment({ PATH: "/bin", HOME: "/home/test", CODEX_HOME: "/codex", GH_TOKEN: "secret", AGENT_APP_PRIVATE_KEY: "secret" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/home/test", CODEX_HOME: "/codex" });
});

test("refuses ChatGPT-authenticated Cloud CLI execution inside GitHub Actions", async () => {
  await assert.rejects(() => submitCloudTask(request(), { env: { GITHUB_ACTIONS: "true" } }), /outside GitHub Actions/);
});

test("binds sentinel results to stage, SHA, and allowed paths", () => {
  const implementation = request({
    request_id: "issue-1-implement-a1b2c3d4", stage: "implement",
    result_path: ".agent-cloud-output/issue-1-implement-a1b2c3d4/implement.json",
    allowed_paths: ["src/fix.mjs", "test/fix.test.mjs"],
  });
  const result = { version: 1, request_id: implementation.request_id, stage: "implement", source_sha: implementation.source_sha, subject_sha: implementation.subject_sha,
    observed_sha: implementation.source_sha, attempt: 1, payload: { summary: "fixed" } };
  assert.deepEqual(validateCloudResult(implementation, result, [implementation.result_path, "src/fix.mjs"]), { summary: "fixed" });
  assert.throws(() => validateCloudResult(implementation, result, [implementation.result_path, "src/unplanned.mjs"]), /outside its stage contract/);
  assert.throws(() => validateCloudResult(implementation, { ...result, observed_sha: "b".repeat(40) }, [implementation.result_path]), /does not match/);
  assert.throws(() => validateCloudResult(implementation, { ...result, payload: { summary: "fixed", extra: true } }, [implementation.result_path]), /only a non-empty summary/);
});

test("signs a short-lived SHA and diff-bound relay receipt", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const execution = {
    request_id: request().request_id,
    stage: request().stage,
    source_sha: request().source_sha,
    subject_sha: request().subject_sha,
    environment_id: request().environment_id,
    task_id: "task_12345678",
    attempt: 1,
  };
  const diff = "diff --git a/x b/x\n";
  const completed = new Date("2026-08-26T00:00:00.000Z");
  const envelope = signRelayReceipt(
    createRelayReceipt(request(), execution, diff, completed),
    privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  const verified = verifyRelayReceipt(
    request(), execution, diff, envelope,
    publicKey.export({ type: "spki", format: "pem" }),
    { now: new Date("2026-08-26T00:10:00.000Z") },
  );
  assert.equal(verified.diff_sha256, createHash("sha256").update(diff).digest("hex"));
  assert.throws(() => verifyRelayReceipt(request(), execution, `${diff}tampered`, envelope,
    publicKey.export({ type: "spki", format: "pem" }), { now: new Date("2026-08-26T00:10:00.000Z") }), /does not match/);
  assert.throws(() => verifyRelayReceipt(request(), execution, diff, envelope,
    publicKey.export({ type: "spki", format: "pem" }), { now: new Date("2026-08-26T02:00:00.000Z") }), /stale/);
});

test("submits, polls, and downloads through a pinned secret-free CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-bridge-test-"));
  const cli = join(directory, "fake-codex.mjs");
  await writeFile(cli, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (process.env.GH_TOKEN || process.env.AGENT_APP_PRIVATE_KEY) process.exit(9);
if (args[0] === "--version") console.log("codex-cli 0.145.0");
else if (args[0] === "login" && args[1] === "status") console.log("Logged in using ChatGPT");
else if (args[0] === "cloud" && args[1] === "exec") {
  let input = ""; for await (const chunk of process.stdin) input += chunk;
  if (args.at(-1) !== "-" || process.argv.join(" ").includes("Bounded runtime") || !input.includes("Bounded runtime")) process.exit(7);
  console.log("https://chatgpt.com/codex/tasks/task_12345678");
}
else if (args[0] === "cloud" && args[1] === "list") console.log(JSON.stringify({tasks:[{id:"task_12345678",status:"ready",environment_id:null}],cursor:null}));
else if (args[0] === "cloud" && args[1] === "diff") console.log("diff --git a/result b/result\\n--- /dev/null\\n+++ b/result");
else process.exit(8);
`);
  await chmod(cli, 0o755);
  const options = { cli, env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, GH_TOKEN: "secret" } };
  const submitted = await submitCloudTask(request(), options);
  assert.equal(submitted.task_id, "task_12345678");
  assert.equal((await waitForCloudTask(request(), submitted, { ...options, timeoutMs: 1_000, pollMs: 1_000 })).status, "ready");
  assert.match((await downloadCloudDiff(request(), submitted, options)).diff, /diff --git/);
});

test("derives result and publication patch from the exact hashed diff", async () => {
  const repo = await mkdtemp(join(tmpdir(), "cloud-materialize-test-"));
  await mkdir(join(repo, "src")); await exec("git", ["init", "-q"], { cwd: repo });
  await exec("git", ["config", "user.name", "Test"], { cwd: repo }); await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await writeFile(join(repo, "src/fix.mjs"), "old\n"); await exec("git", ["add", "src/fix.mjs"], { cwd: repo }); await exec("git", ["commit", "-qm", "base"], { cwd: repo });
  const sha = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  const bound = request({ request_id: "issue-1-implement-d4c3b2a1", stage: "implement", source_sha: sha, subject_sha: sha,
    result_path: ".agent-cloud-output/issue-1-implement-d4c3b2a1/implement.json", allowed_paths: ["src/fix.mjs"] });
  await writeFile(join(repo, "src/fix.mjs"), "new\n"); await mkdir(join(repo, ".agent-cloud-output/issue-1-implement-d4c3b2a1"), { recursive: true });
  await writeFile(join(repo, bound.result_path), `${JSON.stringify({ version: 1, request_id: bound.request_id, stage: bound.stage, source_sha: sha, subject_sha: sha, observed_sha: sha, attempt: 1, payload: { summary: "fixed" } })}\n`);
  await exec("git", ["add", "-N", "src/fix.mjs", bound.result_path], { cwd: repo });
  const diff = (await exec("git", ["diff", "--binary"], { cwd: repo, maxBuffer: 1024 * 1024 })).stdout;
  const execution = { request_id: bound.request_id, stage: bound.stage, source_sha: sha, subject_sha: sha, environment_id: bound.environment_id,
    attempt: 1, status: "ready", task_id: "task_12345678", diff_sha256: createHash("sha256").update(diff).digest("hex") };
  const result = await materializeCloudResult(bound, execution, diff, { cwd: repo, env: { ...process.env, GIT_EXTERNAL_DIFF: "/usr/bin/false" } });
  assert.deepEqual(result.payload, { summary: "fixed" }); assert.match(result.publication_patch, /src\/fix\.mjs/); assert.doesNotMatch(result.publication_patch, /agent-cloud-output/);
});
