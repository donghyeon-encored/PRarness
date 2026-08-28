import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { publishCloudRequest } from "../cloud-publish.mjs";

const exec = promisify(execFile);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "prarness-cloud-publish-"));
  const repo = join(directory, "repo");
  const bin = join(directory, "bin");
  await mkdir(repo); await mkdir(bin);
  const realGit = (await exec("which", ["git"])).stdout.trim();
  await exec(realGit, ["init", "-q", "-b", "main"], { cwd: repo });
  await mkdir(join(repo, ".github")); await mkdir(join(repo, "src"));
  await writeFile(join(repo, ".github/prarness.yml"), `version: 1
runtime:
  contract: 1
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
  workflow: pr-validation.yml
  app_slug: github-actions
  required_checks:
    - Test CI
  timeout_seconds: 30
`);
  await writeFile(join(repo, "src/app.js"), "export const value = 1;\n");
  await exec(realGit, ["add", "."], { cwd: repo });
  await exec(realGit, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base"], { cwd: repo });
  const sourceSha = (await exec(realGit, ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  await exec(realGit, ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: repo });
  await exec(realGit, ["switch", "-q", "-c", "agent/issue-1-fix"], { cwd: repo });
  await writeFile(join(repo, "src/app.js"), "export const value = 2;\n");
  await exec(realGit, ["add", "src/app.js"], { cwd: repo });
  await exec(realGit, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fix\n\nRefs #1\nAgent-Iteration: 1"], { cwd: repo });
  const headSha = (await exec(realGit, ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();

  await writeFile(join(bin, "git"), `#!/usr/bin/env bash
if [[ $1 == push ]]; then touch "$TEST_PUSH_MARKER"; exit 0; fi
if [[ $1 == ls-remote && $2 == --heads ]]; then
  if [[ -f "$TEST_PUSH_MARKER" ]]; then remote_sha=$TEST_REMOTE_AFTER; else remote_sha=$TEST_REMOTE_BEFORE; fi
  printf '%s\\trefs/heads/agent/issue-1-fix\\n' "$remote_sha"
  exit 0
fi
exec ${JSON.stringify(realGit)} "$@"
`);
  await writeFile(join(bin, "gh"), `#!/usr/bin/env bash
if [[ $1 == auth && $2 == token ]]; then printf '%s\\n' 'installation-token'; exit 0; fi
exit 2
`);
  await chmod(join(bin, "git"), 0o755); await chmod(join(bin, "gh"), 0o755);

  const request = join(directory, "request.json");
  await writeFile(request, JSON.stringify({
    version: 1,
    runtime_contract: 1,
    request_id: "gh-12345678-implement",
    repository: "owner/repo",
    issue: 1,
    iteration: 1,
    stage: "implement",
    source_sha: sourceSha,
    subject_sha: sourceSha,
    branch: "agent/issue-1-fix",
    allowed_paths: ["src/app.js"],
    plan: {
      issue: 1,
      iteration: 1,
      phase: "plan",
      risk: "low",
      problems: [{
        id: "P-001",
        problem: "The implementation returns the old value",
        risk: "low",
        status: "PLANNED",
        evidence: "src/app.js:1",
        owner: null,
        next_step: "Update the value and verify it",
      }],
      steps: ["Update the value", "Run validation"],
      validation_commands: ["git diff --quiet HEAD --"],
      changed_paths: ["src/app.js"],
      units: [],
    },
    review: { verdict: "pass", reviewed_sha: headSha, findings: [] },
  }));
  const validation = join(directory, "validation.json");
  await writeFile(validation, JSON.stringify({
    version: 1,
    request_id: "gh-12345678-implement",
    commands: [{ command: "git diff --quiet HEAD --", passed: true, exit_code: 0 }],
  }));
  const authMetadata = join(directory, "prarness-auth.json");
  await writeFile(authMetadata, JSON.stringify({
    version: 1,
    repository: "owner/repo",
    host: "github.com",
    auth_kind: "github_app",
    expires_at: "2099-01-01T00:00:00Z",
    app_id: "42",
    installation_id: "123",
    permissions: { contents: "write", issues: "write", pull_requests: "write", actions: "write", checks: "write", deployments: "write" },
  }));
  return { authMetadata, bin, headSha, pushMarker: join(directory, "pushed"), repo, request, sourceSha, validation };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

test("Cloud publisher confirms the pushed SHA and live REST pull request", async () => {
  const context = await fixture();
  const priorPath = process.env.PATH;
  const priorRemoteBefore = process.env.TEST_REMOTE_BEFORE;
  const priorRemoteAfter = process.env.TEST_REMOTE_AFTER;
  const priorPushMarker = process.env.TEST_PUSH_MARKER;
  const priorAppId = process.env.AGENT_APP_ID;
  const priorFetch = globalThis.fetch;
  process.env.PATH = `${context.bin}:${priorPath}`;
  process.env.TEST_REMOTE_BEFORE = context.sourceSha;
  process.env.TEST_REMOTE_AFTER = context.headSha;
  process.env.TEST_PUSH_MARKER = context.pushMarker;
  process.env.AGENT_APP_ID = "42";
  const comments = [];
  const commentById = new Map();
  let pull = {
    number: 7,
    html_url: "https://github.com/owner/repo/pull/7",
    state: "open",
    merged: false,
    draft: true,
    head: { ref: "agent/issue-1-fix", sha: context.headSha, repo: { full_name: "owner/repo" } },
    base: { ref: "main", sha: context.sourceSha, repo: { full_name: "owner/repo" } },
  };
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    const method = options.method ?? "GET";
    if (method === "GET" && path === "/repos/owner/repo") return json({ full_name: "owner/repo", default_branch: "main" });
    if (method === "GET" && path === "/repos/owner/repo/issues/1") return json({
      number: 1,
      state: "open",
      title: "Update application value",
      body: "The application returns the old value.",
      labels: [{ name: "bug" }],
      user: { login: "reporter" },
    });
    if (method === "GET" && path.startsWith("/repos/owner/repo/pulls?")) return json([pull]);
    if (method === "GET" && path === "/repos/owner/repo/commits/main") return json({ sha: context.sourceSha });
    if (method === "GET" && path === "/repos/owner/repo/issues/1/comments?per_page=100&page=1") return json(comments);
    if (method === "GET" && path === `/repos/owner/repo/commits/${context.headSha}/check-runs?per_page=100`) return json({ check_runs: [
      { id: 50, name: "Test CI", status: "completed", conclusion: "success", head_sha: context.headSha, app: { slug: "github-actions" }, details_url: "https://github.com/owner/repo/actions/runs/50" },
    ] });
    if (method === "GET" && path === "/repos/owner/repo/assignees/reviewer") return new Response(null, { status: 204 });
    if (method === "PATCH" && path === "/repos/owner/repo/pulls/7") { pull = { ...pull, ...JSON.parse(options.body) }; return json(pull); }
    if (method === "POST" && path === "/repos/owner/repo/pulls/7/requested_reviewers") return json({ requested_reviewers: [{ login: "reviewer" }] }, 201);
    if (method === "POST" && path === "/repos/owner/repo/issues/7/assignees") return json({ number: 7, assignees: [{ login: "reviewer" }] });
    if (method === "PATCH" && path.startsWith("/repos/owner/repo/issues/comments/")) {
      const id = Number(path.split("/").at(-1));
      const comment = { ...commentById.get(id), body: JSON.parse(options.body).body, updated_at: new Date().toISOString() };
      const index = comments.findIndex((candidate) => candidate.id === id);
      if (index >= 0) comments[index] = comment;
      commentById.set(id, comment);
      return json(comment);
    }
    if (method === "POST" && path === "/repos/owner/repo/issues/1/comments") {
      const body = JSON.parse(options.body).body;
      const id = comments.length === 0 ? 11 : 13;
      const comment = { id, html_url: `https://github.com/owner/repo/issues/1#issuecomment-${id}`, issue_url: "https://api.github.com/repos/owner/repo/issues/1", body, user: { login: "app[bot]", type: "Bot" }, performed_via_github_app: { id: 42 }, updated_at: new Date().toISOString() };
      comments.push(comment);
      commentById.set(comment.id, comment);
      return json(comment, 201);
    }
    if (method === "POST" && path === "/repos/owner/repo/issues/7/comments") {
      const comment = { id: 12, html_url: "https://github.com/owner/repo/pull/7#issuecomment-12", issue_url: "https://api.github.com/repos/owner/repo/issues/7", body: JSON.parse(options.body).body, user: { login: "app[bot]", type: "Bot" }, performed_via_github_app: { id: 42 } };
      commentById.set(comment.id, comment);
      return json(comment, 201);
    }
    if (method === "GET" && path.startsWith("/repos/owner/repo/issues/comments/")) return json(commentById.get(Number(path.split("/").at(-1))));
    if (method === "GET" && path === "/repos/owner/repo/pulls/7") return json(pull);
    return json({ message: `unhandled ${method} ${path}` }, 500);
  };

  try {
    const result = await publishCloudRequest({ repo: context.repo, request: context.request, validation: context.validation, auth_metadata: context.authMetadata, poll_interval_ms: 0 });
    assert.equal(result.verified, true);
    assert.equal(result.remote_sha, context.headSha);
    assert.equal(result.pr_url, "https://github.com/owner/repo/pull/7");
    assert.equal(result.draft, true);
    assert.equal(result.reused, true);
    assert.equal(result.completion_comment, 13);
    assert.equal(result.ownership.issue_assignee, "reviewer");
    assert.equal(result.ownership.reviewer, "reviewer");
    assert.equal(result.risk.risk, "low");
    assert.deepEqual(result.review, { verdict: "pass", phase: "review", human_required: false, findings: 0 });
  } finally {
    process.env.PATH = priorPath;
    if (priorRemoteBefore === undefined) delete process.env.TEST_REMOTE_BEFORE; else process.env.TEST_REMOTE_BEFORE = priorRemoteBefore;
    if (priorRemoteAfter === undefined) delete process.env.TEST_REMOTE_AFTER; else process.env.TEST_REMOTE_AFTER = priorRemoteAfter;
    if (priorPushMarker === undefined) delete process.env.TEST_PUSH_MARKER; else process.env.TEST_PUSH_MARKER = priorPushMarker;
    if (priorAppId === undefined) delete process.env.AGENT_APP_ID; else process.env.AGENT_APP_ID = priorAppId;
    globalThis.fetch = priorFetch;
  }
});

test("Cloud publisher rejects validation evidence that differs from target policy", async () => {
  const context = await fixture();
  await writeFile(context.validation, JSON.stringify({
    version: 1,
    request_id: "gh-12345678-implement",
    commands: [{ command: "npm test", passed: true, exit_code: 0 }],
  }));
  await assert.rejects(
    publishCloudRequest({ repo: context.repo, request: context.request, validation: context.validation }),
    (error) => error.code === "INVALID_VALIDATION_REPORT" && /exactly match/.test(error.message),
  );
});

test("Cloud publisher requires low-risk must-fix findings to be fixed in the same task", async () => {
  const context = await fixture();
  const request = JSON.parse(await readFile(context.request, "utf8"));
  request.review = {
    verdict: "fix_required",
    reviewed_sha: context.headSha,
    findings: [{
      id: "P-002",
      path: "src/app.js",
      line: 1,
      problem: "The low-risk regression still needs a correction",
      risk: "low",
      must_fix: true,
      suggested_fix: "Correct it and rerun the final self-review",
      human_owner: null,
    }],
  };
  await writeFile(context.request, JSON.stringify(request));
  await assert.rejects(
    publishCloudRequest({ repo: context.repo, request: context.request, validation: context.validation }),
    (error) => error.code === "UNRESOLVED_LOW_RISK_REVIEW" && /P-002/.test(error.message),
  );
});

test("Cloud publisher fails closed for a target-defined protected path", async () => {
  const context = await fixture();
  await writeFile(join(context.repo, ".github/prarness.yml"), `version: 1
runtime:
  contract: 1
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
  workflow: pr-validation.yml
  app_slug: github-actions
  required_checks:
    - Test CI
  timeout_seconds: 30
protected_paths:
  additional:
    - src/app.js
`);
  await assert.rejects(
    publishCloudRequest({ repo: context.repo, request: context.request, validation: context.validation }),
    (error) => error.code === "PROTECTED_PATH" && /src\/app\.js/.test(error.message),
  );
});
