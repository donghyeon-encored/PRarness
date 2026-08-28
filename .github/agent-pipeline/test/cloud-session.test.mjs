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
    runtime_repository: "donghyeon-encored/PRarness",
    dispatch: "human_pr_mention",
  };
  await writeFile(join(repo, ".prarness/requests/issue-1.json"), `${JSON.stringify(manifest)}\n`);
  await exec("git", ["add", ".prarness/requests/issue-1.json"], { cwd: repo });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "bootstrap"], { cwd: repo });
  const bootstrapSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  const remote = join(directory, "remote.git");
  await exec("git", ["init", "-q", "--bare", remote], { cwd: directory });
  await exec("git", ["remote", "add", "origin", remote], { cwd: repo });
  await exec("git", ["push", "-q", "origin", "main", "agent/issue-1-fix"], { cwd: repo });
  const intakeState = { version: 2, issue: 1, phase: "WAITING_FOR_CODEX", branch: "agent/issue-1-fix", pr: 7, base: "main", source_sha: sourceSha, bootstrap_sha: bootstrapSha, runtime_ref: runtimeRef, runtime_repository: "donghyeon-encored/PRarness" };
  const api = {
    calls: [],
    intakeState,
    pull: {
      number: 7,
      html_url: "https://github.com/owner/repo/pull/7",
      body: "managed",
      state: "open",
      merged: false,
      draft: true,
      head: { ref: "agent/issue-1-fix", sha: bootstrapSha, repo: { full_name: "owner/repo" } },
      base: { ref: "main", sha: sourceSha, repo: { full_name: "owner/repo" } },
    },
  };
  const client = {
    botLogin: "app[bot]",
    repoPath: (suffix = "") => `/repos/owner/repo${suffix}`,
    paginate: async () => [{
      id: 11,
      user: { login: "github-actions[bot]", type: "Bot" },
      body: `state\n\n<!-- prarness-intake-state:v2 ${JSON.stringify(api.intakeState)} -->\n<!-- prarness-intake:v2 issue=1 -->`,
    }],
    request: async (method, path, options = {}) => {
      api.calls.push({ method, path, body: options.body });
      if (method === "GET" && path.endsWith("/issues/1")) return { data: {
        number: 1,
        state: "open",
        title: "Mixed fraction scaling",
        body: "The scaling function returns the wrong value",
        labels: [{ name: "bug" }],
        user: { login: "reporter" },
      } };
      if (method === "GET" && path === "/repos/owner/repo") return { data: { default_branch: "main" } };
      if (method === "GET" && path.startsWith("/repos/owner/repo/pulls?")) return { data: api.pull ? [api.pull] : [] };
      if (method === "POST" && path === "/repos/owner/repo/pulls") {
        api.pull = {
          number: 7,
          html_url: "https://github.com/owner/repo/pull/7",
          body: options.body.body,
          state: "open",
          merged: false,
          draft: options.body.draft,
          head: { ref: options.body.head, sha: bootstrapSha, repo: { full_name: "owner/repo" } },
          base: { ref: options.body.base, sha: sourceSha, repo: { full_name: "owner/repo" } },
        };
        return { status: 201, data: api.pull };
      }
      if (method === "PATCH" && path === "/repos/owner/repo/pulls/7") {
        api.pull = { ...api.pull, ...options.body };
        return { status: 200, data: api.pull };
      }
      if (method === "GET" && path === "/repos/owner/repo/pulls/7") {
        if (api.trackLocalPullHead) api.pull.head.sha = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
        return { data: api.pull };
      }
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
  return { api, bootstrapSha, client, directory, remote, repo, runtimeRef, sourceSha };
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
    assert.equal(session.intake_source_sha, context.sourceSha);
    assert.equal(session.base_ref, "main");
    assert.equal(session.base_refreshed, false);
    assert.equal(session.subject_sha, context.bootstrapSha);
    assert.equal(session.runtime_ref, context.runtimeRef);
    assert.equal(session.runtime_repository, "donghyeon-encored/PRarness");
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
    if (path === "/repos/owner/repo") return { data: { default_branch: "main" } };
    if (path.endsWith("/pulls/7")) return { data: {
      number: 7,
      state: "open",
      merged: false,
      draft: true,
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

test("Cloud session creates the canonical draft PR and claims the managed branch", async () => {
  const context = await fixture();
  context.api.intakeState.pr = null;
  context.api.pull = null;
  await exec("git", ["switch", "-q", "main"], { cwd: context.repo });
  const priorBotLogin = process.env.AGENT_APP_BOT_LOGIN;
  process.env.AGENT_APP_BOT_LOGIN = "app[bot]";
  try {
    const session = await prepareCloudSession({
      repository: "owner/repo",
      issue: 1,
      branch: "agent/issue-1-fix",
      repo: context.repo,
      client: context.client,
      skip_preflight: true,
    });
    assert.equal(session.pr, 7);
    assert.equal(session.branch, "agent/issue-1-fix");
    assert.equal(session.subject_sha, context.bootstrapSha);
    assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: context.repo })).stdout.trim(), context.bootstrapSha);
    const create = context.api.calls.find((call) => call.method === "POST" && call.path === "/repos/owner/repo/pulls");
    assert.equal(create.body.draft, true);
    assert.equal(create.body.head, "agent/issue-1-fix");
    const update = context.api.calls.find((call) => call.method === "PATCH" && call.path === "/repos/owner/repo/pulls/7");
    assert.match(update.body.body, new RegExp(`PRARNESS_BOOTSTRAP_REF=${context.runtimeRef}`));
    assert.match(update.body.body, /PRARNESS_BOOTSTRAP_SKIP_GITHUB_SETUP=true/);
    assert.match(update.body.body, /--repository owner\/repo --issue 1 --pr 7/);
    assert.match(update.body.body, /Do not use `make_pr`/);
  } finally {
    if (priorBotLogin === undefined) delete process.env.AGENT_APP_BOT_LOGIN;
    else process.env.AGENT_APP_BOT_LOGIN = priorBotLogin;
  }
});

test("Cloud session fast-forwards a managed PR onto an advanced live base before binding the session", async () => {
  const context = await fixture();
  await exec("git", ["switch", "-q", "main"], { cwd: context.repo });
  await writeFile(join(context.repo, "base-change.js"), "export const baseChange = true;\n");
  await exec("git", ["add", "base-change.js"], { cwd: context.repo });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "advance base"], { cwd: context.repo });
  const liveBaseSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: context.repo })).stdout.trim();
  await exec("git", ["push", "-q", "origin", "main"], { cwd: context.repo });
  await exec("git", ["switch", "-q", "agent/issue-1-fix"], { cwd: context.repo });
  context.api.pull.base.sha = liveBaseSha;
  context.api.trackLocalPullHead = true;

  const session = await prepareCloudSession({
    repository: "owner/repo",
    issue: 1,
    pr: 7,
    repo: context.repo,
    client: context.client,
    skip_preflight: true,
  });

  assert.equal(session.intake_source_sha, context.sourceSha);
  assert.equal(session.source_sha, liveBaseSha);
  assert.equal(session.base_refreshed, true);
  assert.notEqual(session.subject_sha, context.bootstrapSha);
  assert.deepEqual(session.existing_changed_paths, []);
  const parents = (await exec("git", ["rev-list", "--parents", "-n", "1", session.subject_sha], { cwd: context.repo })).stdout.trim().split(" ");
  assert.deepEqual(new Set(parents.slice(1)), new Set([context.bootstrapSha, liveBaseSha]));
  assert.equal((await exec("git", ["ls-remote", context.remote, "refs/heads/agent/issue-1-fix"])).stdout.trim().split(/\s/)[0], session.subject_sha);
});

test("Cloud session refuses a default branch that diverged from the intake source", async () => {
  const context = await fixture();
  const tree = (await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: context.repo })).stdout.trim();
  const divergent = (await exec("git", [
    "-c", "user.name=Test",
    "-c", "user.email=test@example.com",
    "commit-tree", tree,
    "-m", "divergent base",
  ], { cwd: context.repo })).stdout.trim();
  await exec("git", ["push", "-q", "--force", "origin", `${divergent}:refs/heads/main`], { cwd: context.repo });
  context.api.pull.base.sha = divergent;

  await assert.rejects(
    prepareCloudSession({ repository: "owner/repo", issue: 1, pr: 7, repo: context.repo, client: context.client, skip_preflight: true }),
    (error) => error.code === "DIVERGED_BASE",
  );
  assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: context.repo })).stdout.trim(), context.bootstrapSha);
});

test("Cloud session aborts a conflicting base refresh without moving the managed branch", async () => {
  const context = await fixture();
  await writeFile(join(context.repo, "app.js"), "export const value = 'branch';\n");
  await exec("git", ["add", "app.js"], { cwd: context.repo });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "branch change"], { cwd: context.repo });
  const branchSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: context.repo })).stdout.trim();
  await exec("git", ["push", "-q", "origin", "agent/issue-1-fix"], { cwd: context.repo });
  context.api.pull.head.sha = branchSha;

  await exec("git", ["switch", "-q", "main"], { cwd: context.repo });
  await writeFile(join(context.repo, "app.js"), "export const value = 'base';\n");
  await exec("git", ["add", "app.js"], { cwd: context.repo });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base conflict"], { cwd: context.repo });
  const liveBaseSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: context.repo })).stdout.trim();
  await exec("git", ["push", "-q", "origin", "main"], { cwd: context.repo });
  await exec("git", ["switch", "-q", "agent/issue-1-fix"], { cwd: context.repo });
  context.api.pull.base.sha = liveBaseSha;

  await assert.rejects(
    prepareCloudSession({ repository: "owner/repo", issue: 1, pr: 7, repo: context.repo, client: context.client, skip_preflight: true }),
    (error) => error.code === "BASE_REFRESH_CONFLICT",
  );
  assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: context.repo })).stdout.trim(), branchSha);
  assert.equal((await exec("git", ["status", "--porcelain"], { cwd: context.repo })).stdout, "");
  assert.equal((await exec("git", ["ls-remote", context.remote, "refs/heads/agent/issue-1-fix"])).stdout.trim().split(/\s/)[0], branchSha);
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
