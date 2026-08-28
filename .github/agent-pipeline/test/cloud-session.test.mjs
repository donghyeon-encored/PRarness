import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { commandReceipt, prepareCloudSession, validateCloudSession } from "../cloud-session.mjs";

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
ownership:
  source: codeowners
  fallback: reviewer
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
    botLogin: "app[bot]",
    repoPath: (suffix = "") => `/repos/owner/repo${suffix}`,
    paginate: async () => [{
      id: 11,
      user: { login: "github-actions[bot]", type: "Bot" },
      body: `state\n\n<!-- prarness-intake-state:v2 ${JSON.stringify(state)} -->\n<!-- prarness-intake:v2 issue=1 -->`,
    }],
    request: async (method, path, options = {}) => {
      if (method === "GET" && path.endsWith("/issues/1")) return { data: {
        number: 1,
        state: "open",
        title: "Mixed fraction scaling",
        body: "The scaling function returns the wrong value",
        labels: [{ name: "bug" }],
        user: { login: "reporter" },
      } };
      if (path.endsWith("/pulls/7")) return { data: {
        number: 7,
        state: "open",
        merged: false,
        head: { ref: "agent/issue-1-fix", sha: bootstrapSha, repo: { full_name: "owner/repo" } },
        base: { ref: "main", sha: sourceSha, repo: { full_name: "owner/repo" } },
      } };
      if (method === "GET" && path.endsWith("/assignees/reviewer")) return { status: 204, data: null };
      if (method === "POST" && path.endsWith("/issues/1/assignees")) return { status: 201, data: { assignees: options.body.assignees } };
      if (method === "POST" && path.endsWith("/issues/1/comments")) return { status: 201, data: {
        id: 21,
        html_url: "https://github.com/owner/repo/issues/1#issuecomment-21",
        body: options.body.body,
      } };
      throw new Error(`Unhandled request ${path}`);
    },
  };
  return { bootstrapSha, client, directory, repo, runtimeRef, sourceSha };
}

test("Cloud session binds the checkout to the canonical intake state", async () => {
  const context = await fixture();
  const priorBotLogin = process.env.AGENT_APP_BOT_LOGIN;
  process.env.AGENT_APP_BOT_LOGIN = "app[bot]";
  const output = join(context.directory, "session.json");
  try {
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
    assert.equal(session.ownership.assignee, "reviewer");
    assert.equal(session.codegraph_summary.file_count >= 2, true);
    assert.equal(session.analysis_comment_id, 21);
    assert.equal(JSON.parse(await readFile(session.codegraph_path, "utf8")).version, 1);
    assert.deepEqual(session.validation_commands, ["git diff --quiet HEAD --"]);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), session);

    const validation = join(context.directory, "validation.json");
    const report = validateCloudSession({ session: output, repo: context.repo, result: validation, quiet: true });
    assert.equal(report.commands[0].passed, true);
    assert.equal(JSON.parse(await readFile(validation, "utf8")).request_id, session.request_id);
  } finally {
    if (priorBotLogin === undefined) delete process.env.AGENT_APP_BOT_LOGIN;
    else process.env.AGENT_APP_BOT_LOGIN = priorBotLogin;
  }
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

test("only publish can return a verified completion receipt", () => {
  const prepared = commandReceipt("prepare", {
    request_id: "prarness-issue-1-iteration-1",
    instructions_path: "/runtime/prompts/cloud-session.md",
  });
  assert.equal(prepared.status, "PREPARED_NOT_PUBLISHED");
  assert.equal(prepared.complete, false);
  assert.equal(prepared.verified, false);
  assert.match(prepared.next_action, /prarness-session publish/);

  const validated = commandReceipt("validate", { request_id: "prarness-issue-1-iteration-1" });
  assert.equal(validated.status, "VALIDATED_NOT_PUBLISHED");
  assert.equal(validated.complete, false);
  assert.equal(validated.verified, false);

  assert.throws(
    () => commandReceipt("publish", { request_id: "prarness-issue-1-iteration-1", verified: false }),
    (error) => error.code === "UNVERIFIED_PUBLICATION",
  );
  const published = commandReceipt("publish", {
    request_id: "prarness-issue-1-iteration-1",
    verified: true,
    pr: 7,
    pr_url: "https://github.com/owner/repo/pull/7",
    remote_sha: "a".repeat(40),
    ownership: { reviewer: "reviewer" },
    review: { phase: "review" },
  });
  assert.equal(published.status, "PUBLICATION_VERIFIED");
  assert.equal(published.complete, true);
  assert.equal(published.verified, true);
  assert.equal(published.reviewer, "reviewer");
});
