import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepareCloudSession, validateCloudSession } from "../cloud-session.mjs";

const exec = promisify(execFile);
const sessionCli = fileURLToPath(new URL("../cloud-session.mjs", import.meta.url));

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "prarness-cloud-session-"));
  const repo = join(directory, "repo");
  await mkdir(repo);
  await exec("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await mkdir(join(repo, ".github"));
  await writeFile(join(repo, ".github/prarness.yml"), `version: 1
repository: owner/repo
runtime:
  contract: 1
dispatch:
  mode: human_pr_mention
  label: agent:run
  auto_on_open_for_trusted: true
publication:
  mode: codex_cloud_direct
  branch_prefix: agent/issue-
validation:
  commands:
    - git diff --quiet HEAD --
ci:
  required: true
  trigger: pull_request
  workflow: ci.yml
  app_slug: github-actions
  required_checks:
    - Test
  timeout_seconds: 300
`);
  await writeFile(join(repo, "app.js"), "export const value = 1;\n");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base"], { cwd: repo });
  const sourceSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  await exec("git", ["switch", "-q", "-c", "agent/issue-1-fix"], { cwd: repo });
  await mkdir(join(repo, ".prarness/requests"), { recursive: true });
  const runtimeRef = "a".repeat(40);
  const manifest = {
    version: 2,
    request_id: "prarness-issue-1",
    repository: "owner/repo",
    issue: 1,
    branch: "agent/issue-1-fix",
    source_sha: sourceSha,
    runtime_ref: runtimeRef,
    dispatch: "human_pr_mention",
  };
  await writeFile(join(repo, ".prarness/requests/issue-1.json"), `${JSON.stringify(manifest)}\n`);
  await exec("git", ["add", ".prarness/requests/issue-1.json"], { cwd: repo });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "bootstrap"], { cwd: repo });
  const bootstrapSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  const state = { version: 2, issue: 1, phase: "WAITING_FOR_CODEX", branch: "agent/issue-1-fix", pr: 7, source_sha: sourceSha, bootstrap_sha: bootstrapSha, runtime_ref: runtimeRef };
  const client = {
    repoPath: (suffix = "") => `/repos/owner/repo${suffix}`,
    paginate: async () => [{
      id: 11,
      user: { login: "github-actions[bot]", type: "Bot" },
      body: `state\n\n<!-- prarness-intake-state:v2 ${JSON.stringify(state)} -->\n<!-- prarness-intake:v2 issue=1 -->`,
    }],
    request: async (_method, path) => {
      if (path.endsWith("/issues/1")) return { data: { number: 1, state: "open" } };
      if (path.endsWith("/pulls/7")) return { data: {
        number: 7,
        state: "open",
        merged: false,
        head: { ref: "agent/issue-1-fix", sha: bootstrapSha, repo: { full_name: "owner/repo" } },
        base: { ref: "main", sha: sourceSha, repo: { full_name: "owner/repo" } },
      } };
      throw new Error(`Unhandled request ${path}`);
    },
  };
  return { bootstrapSha, client, directory, repo, runtimeRef, sourceSha };
}

test("Cloud session binds the checkout to the canonical intake state", async () => {
  const context = await fixture();
  const output = join(context.directory, "session.json");
  const session = await prepareCloudSession({
    repository: "owner/repo",
    issue: 1,
    pr: 7,
    repo: context.repo,
    client: context.client,
    skip_preflight: true,
    output,
  });
  assert.equal(session.source_sha, context.sourceSha);
  assert.equal(session.subject_sha, context.bootstrapSha);
  assert.equal(session.runtime_ref, context.runtimeRef);
  assert.equal(session.iteration, 1);
  assert.equal(session.request_manifest, ".prarness/requests/issue-1.json");
  assert.deepEqual(session.existing_changed_paths, []);
  assert.deepEqual(session.validation_commands, ["git diff --quiet HEAD --"]);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), session);

  const validation = join(context.directory, "validation.json");
  const report = validateCloudSession({ session: output, repo: context.repo, result: validation, quiet: true });
  assert.equal(report.commands[0].passed, true);
  assert.equal(JSON.parse(await readFile(validation, "utf8")).request_id, session.request_id);
});

test("Cloud session rejects a checkout that differs from the live PR head", async () => {
  const context = await fixture();
  context.client.request = async (_method, path) => {
    if (path.endsWith("/issues/1")) return { data: { number: 1, state: "open" } };
    if (path.endsWith("/pulls/7")) return { data: {
      number: 7,
      state: "open",
      merged: false,
      head: { ref: "agent/issue-1-fix", sha: "b".repeat(40), repo: { full_name: "owner/repo" } },
      base: { ref: "main", sha: context.sourceSha, repo: { full_name: "owner/repo" } },
    } };
    throw new Error(`Unhandled request ${path}`);
  };
  await assert.rejects(
    prepareCloudSession({ repository: "owner/repo", issue: 1, pr: 7, repo: context.repo, client: context.client, skip_preflight: true }),
    (error) => error.code === "CHECKOUT_SHA_MISMATCH",
  );
});

test("Cloud session CLI cannot bypass capability preflight", async () => {
  await assert.rejects(
    exec(process.execPath, [sessionCli, "prepare", "--skip-preflight", "true"]),
    (error) => /Unsupported prepare option/.test(error.stderr),
  );
});
