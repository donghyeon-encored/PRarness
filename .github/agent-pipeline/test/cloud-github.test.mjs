import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  dispatchAndVerifyCi,
  manageDeployment,
  manageIssue,
  preflightGitHubCapabilities,
  upsertManagedComment,
} from "../cloud-github.mjs";

const exec = promisify(execFile);

async function fixture(trigger = "pull_request") {
  const directory = await mkdtemp(join(tmpdir(), "prarness-cloud-github-"));
  const repo = join(directory, "repo");
  const bin = join(directory, "bin");
  await mkdir(join(repo, ".github"), { recursive: true });
  await mkdir(bin);
  await writeFile(join(repo, ".github/prarness.yml"), `version: 1
runtime:
  contract: 1
publication:
  mode: codex_cloud_direct
  branch_prefix: agent/issue-
ownership:
  source: codeowners
  fallback: maintainer
validation:
  commands:
    - npm test
ci:
  required: true
  trigger: ${trigger}
  workflow: ci.yml
  app_slug: github-actions
  required_checks:
    - Test
  timeout_seconds: 30
`);
  await writeFile(join(repo, "AGENTS.md"), "Cloud workers may perform scoped GitHub writes.\n");
  await exec("git", ["init", "-q"], { cwd: repo });
  await exec("git", ["add", ".github/prarness.yml", "AGENTS.md"], { cwd: repo });
  const authMetadata = join(directory, "auth.json");
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
  await writeFile(join(bin, "gh"), "#!/usr/bin/env bash\n[[ $1 == auth && $2 == token ]] && printf '%s\\n' token && exit 0\nexit 2\n");
  await chmod(join(bin, "gh"), 0o755);
  return { authMetadata, bin, repo };
}

function json(data, status = 200) {
  return new Response(data == null ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

test("preflight proves every managed GitHub write capability", async () => {
  const context = await fixture();
  const priorPath = process.env.PATH;
  process.env.PATH = `${context.bin}:${priorPath}`;
  try {
    const result = await preflightGitHubCapabilities("owner/repo", {
      repo: context.repo,
      auth_metadata: context.authMetadata,
      fetch: async (url) => String(url).endsWith("/repos/owner/repo") ? json({ full_name: "owner/repo" }) : json({}, 500),
    });
    assert.equal(result.verified, true);
    assert.equal(result.permissions.actions, "write");
  } finally {
    process.env.PATH = priorPath;
  }
});

test("managed Issue and comment operations verify live App-authored objects", async () => {
  const context = await fixture();
  const priorPath = process.env.PATH;
  process.env.PATH = `${context.bin}:${priorPath}`;
  const comments = [];
  let createdIssue = null;
  let issueCreations = 0;
  try {
    const fetch = async (url, options = {}) => {
      const path = new URL(url).pathname + new URL(url).search;
      const method = options.method ?? "GET";
      if (method === "GET" && path === "/repos/owner/repo/issues?state=all&sort=created&direction=desc&per_page=100&page=1") return json(createdIssue ? [createdIssue] : []);
      if (method === "POST" && path === "/repos/owner/repo/issues") {
        issueCreations += 1;
        createdIssue = { number: 9, html_url: "https://github.com/owner/repo/issues/9", body: JSON.parse(options.body).body, user: { login: "app[bot]", type: "Bot" }, performed_via_github_app: { id: 42 } };
        return json(createdIssue, 201);
      }
      if (method === "GET" && path === "/repos/owner/repo/issues/9") return json(createdIssue);
      if (method === "GET" && path === "/repos/owner/repo/issues/9/comments?per_page=100&page=1") return json(comments);
      if (method === "POST" && path === "/repos/owner/repo/issues/9/comments") {
        const comment = { id: 77, html_url: "https://github.com/owner/repo/issues/9#issuecomment-77", body: JSON.parse(options.body).body, user: { login: "app[bot]", type: "Bot" }, performed_via_github_app: { id: 42 } };
        comments.push(comment);
        return json(comment, 201);
      }
      if (method === "GET" && path === "/repos/owner/repo/issues/comments/77") return json(comments[0]);
      return json({ message: `unhandled ${method} ${path}` }, 500);
    };
    const shared = { auth_metadata: context.authMetadata, fetch };
    const issue = await manageIssue({ version: 1, request_id: "request-12345678", repository: "owner/repo", operation: "issue", action: "create", title: "Bug" }, shared);
    assert.equal(issue.issue, 9);
    const repeated = await manageIssue({ version: 1, request_id: "request-12345678", repository: "owner/repo", operation: "issue", action: "create", title: "Bug" }, shared);
    assert.equal(repeated.issue, 9);
    assert.equal(issueCreations, 1);
    const comment = await upsertManagedComment({ version: 1, request_id: "request-12345678", repository: "owner/repo", operation: "comment", number: 9, body: "Working" }, shared);
    assert.equal(comment.comment_id, 77);
    assert.match(comments[0].body, /prarness-operation:v1/);
  } finally {
    process.env.PATH = priorPath;
  }
});

test("workflow_dispatch CI is dispatched and bound to the exact successful SHA", async () => {
  const context = await fixture("workflow_dispatch");
  const priorPath = process.env.PATH;
  process.env.PATH = `${context.bin}:${priorPath}`;
  const sha = "a".repeat(40);
  let dispatches = 0;
  let checkQueries = 0;
  try {
    const result = await dispatchAndVerifyCi({ version: 1, request_id: "request-12345678", repository: "owner/repo", operation: "ci", ref: "agent/issue-1-fix", sha }, {
      repo: context.repo,
      auth_metadata: context.authMetadata,
      poll_interval_ms: 0,
      fetch: async (url, options = {}) => {
        const path = new URL(url).pathname + new URL(url).search;
        if ((options.method ?? "GET") === "POST" && path === "/repos/owner/repo/actions/workflows/ci.yml/dispatches") {
          dispatches += 1;
          return json(null, 204);
        }
        if (path === `/repos/owner/repo/commits/${sha}/check-runs?per_page=100`) {
          checkQueries += 1;
          return checkQueries === 1 ? json({ check_runs: [] }) : json({ check_runs: [
            { id: 5, name: "Test", status: "completed", conclusion: "success", head_sha: sha, app: { slug: "github-actions" } },
          ] });
        }
        return json({}, 500);
      },
    });
    assert.equal(dispatches, 1);
    assert.equal(result.verified, true);
    assert.equal(result.checks[0].head_sha, sha);
  } finally {
    process.env.PATH = priorPath;
  }
});

test("deployment creation and status are verified against live GitHub state", async () => {
  const context = await fixture();
  const priorPath = process.env.PATH;
  process.env.PATH = `${context.bin}:${priorPath}`;
  try {
    const fetch = async (url, options = {}) => {
      const path = new URL(url).pathname + new URL(url).search;
      const method = options.method ?? "GET";
      if (method === "GET" && path === `/repos/owner/repo/deployments?ref=${"a".repeat(40)}&environment=staging&per_page=100&page=1`) return json([]);
      if (method === "POST" && path === "/repos/owner/repo/deployments") return json({ id: 91, ref: "a".repeat(40), environment: "staging" }, 201);
      if (method === "GET" && path === "/repos/owner/repo/deployments/91") return json({ id: 91, ref: "a".repeat(40), environment: "staging" });
      if (method === "POST" && path === "/repos/owner/repo/deployments/91/statuses") return json({ id: 92, state: "success" }, 201);
      if (method === "GET" && path === "/repos/owner/repo/deployments/91/statuses?per_page=100") return json([{ id: 92, state: "success" }]);
      return json({}, 500);
    };
    const shared = { auth_metadata: context.authMetadata, fetch };
    const created = await manageDeployment({ version: 1, request_id: "request-12345678", repository: "owner/repo", operation: "deployment", action: "create", ref: "a".repeat(40), environment: "staging" }, shared);
    assert.equal(created.deployment_id, 91);
    const status = await manageDeployment({ version: 1, request_id: "request-12345678", repository: "owner/repo", operation: "deployment", action: "status", deployment_id: 91, state: "success" }, shared);
    assert.equal(status.verified, true);
  } finally {
    process.env.PATH = priorPath;
  }
});
