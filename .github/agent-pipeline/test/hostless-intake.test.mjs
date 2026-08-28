import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { cloudDispatchComment, executeHostlessIntake } from "../hostless-intake.mjs";

const exec = promisify(execFile);
const sourceSha = "1".repeat(40);
const treeSha = "2".repeat(40);
const blobSha = "3".repeat(40);
const requestTreeSha = "4".repeat(40);
const bootstrapSha = "5".repeat(40);
const runtimeRef = "6".repeat(40);

async function targetRepository() {
  const repo = await mkdtemp(join(tmpdir(), "prarness-hostless-intake-"));
  await exec("git", ["init", "-q"], { cwd: repo });
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
  fallback: maintainer
validation:
  commands:
    - npm test
ci:
  required: true
  trigger: pull_request
  workflow: ci.yml
  app_slug: github-actions
  required_checks:
    - Test
  timeout_seconds: 300
`);
  await exec("git", ["add", ".github/prarness.yml"], { cwd: repo });
  return repo;
}

function fakeClient({ association = "OWNER" } = {}) {
  const state = { branchSha: null, defaultSha: sourceSha, recoveryManifest: null, pull: null, comments: [], labels: new Set(), calls: [] };
  const client = {
    repository: "owner/repo",
    repoPath: (suffix = "") => `/repos/owner/repo${suffix}`,
    paginate: async (path) => {
      assert.equal(path, "/repos/owner/repo/issues/1/comments");
      return state.comments;
    },
    request: async (method, path, options = {}) => {
      state.calls.push({ method, path, body: options.body });
      if (method === "GET" && path === "/repos/owner/repo/issues/1") return { status: 200, data: { number: 1, title: "Mixed fraction scaling", state: "open", author_association: association } };
      if (method === "GET" && path === "/repos/owner/repo") return { status: 200, data: { default_branch: "main" } };
      if (method === "GET" && path === "/repos/owner/repo/commits/main") return { status: 200, data: { sha: state.defaultSha, commit: { tree: { sha: treeSha } } } };
      if (method === "GET" && path.startsWith("/repos/owner/repo/git/ref/heads/")) return state.branchSha
        ? { status: 200, data: { object: { sha: state.branchSha } } }
        : { status: 404, data: { message: "Not Found" } };
      if (method === "GET" && path.startsWith("/repos/owner/repo/contents/.prarness/requests/issue-1.json?")) return state.recoveryManifest
        ? { status: 200, data: { encoding: "base64", content: Buffer.from(JSON.stringify(state.recoveryManifest)).toString("base64") } }
        : { status: 404, data: { message: "Not Found" } };
      if (method === "POST" && path === "/repos/owner/repo/git/blobs") return { status: 201, data: { sha: blobSha } };
      if (method === "POST" && path === "/repos/owner/repo/git/trees") return { status: 201, data: { sha: requestTreeSha } };
      if (method === "POST" && path === "/repos/owner/repo/git/commits") return { status: 201, data: { sha: bootstrapSha } };
      if (method === "POST" && path === "/repos/owner/repo/git/refs") { state.branchSha = options.body.sha; return { status: 201, data: { ref: options.body.ref } }; }
      if (method === "GET" && path.startsWith("/repos/owner/repo/pulls?")) return { status: 200, data: state.pull ? [state.pull] : [] };
      if (method === "POST" && path === "/repos/owner/repo/pulls") {
        state.pull = {
          number: 7,
          html_url: "https://github.com/owner/repo/pull/7",
          body: options.body.body,
          state: "open",
          merged: false,
          head: { ref: options.body.head, sha: state.branchSha, repo: { full_name: "owner/repo" } },
          base: { ref: options.body.base, repo: { full_name: "owner/repo" } },
        };
        return { status: 201, data: state.pull };
      }
      if (method === "PATCH" && path === "/repos/owner/repo/pulls/7") {
        state.pull = { ...state.pull, ...options.body };
        return { status: 200, data: state.pull };
      }
      if (method === "GET" && path === "/repos/owner/repo/pulls/7") return { status: 200, data: state.pull };
      if (method === "POST" && path === "/repos/owner/repo/labels") return { status: 201, data: options.body };
      if (method === "POST" && path === "/repos/owner/repo/issues/1/labels") { for (const label of options.body.labels) state.labels.add(label); return { status: 200, data: [] }; }
      if (method === "DELETE" && path.startsWith("/repos/owner/repo/issues/1/labels/")) { state.labels.delete(decodeURIComponent(path.split("/").at(-1))); return { status: 200, data: null }; }
      if (method === "POST" && path === "/repos/owner/repo/issues/1/comments") {
        const comment = { id: 11, body: options.body.body, user: { login: "github-actions[bot]", type: "Bot" } };
        state.comments.push(comment);
        return { status: 201, data: comment };
      }
      if (method === "PATCH" && path === "/repos/owner/repo/issues/comments/11") {
        state.comments[0].body = options.body.body;
        return { status: 200, data: state.comments[0] };
      }
      throw new Error(`Unhandled fake request: ${method} ${path}`);
    },
  };
  return { client, state };
}

function issueEvent(association = "OWNER") {
  return { action: "opened", issue: { number: 1, author_association: association } };
}

test("trusted Issue intake creates one bootstrap branch, draft PR, and canonical state", async () => {
  const repo = await targetRepository();
  const { client, state } = fakeClient();
  const result = await executeHostlessIntake({ repository: "owner/repo", runtime_ref: runtimeRef, repo, client, event_name: "issues", event: issueEvent() });
  assert.equal(result.operation, "bootstrap_pr");
  assert.equal(result.branch, "agent/issue-1-mixed-fraction-scaling");
  assert.equal(result.bootstrap_sha, bootstrapSha);
  assert.equal(result.pr, 7);
  assert.equal(result.requires_human_dispatch, true);
  assert.equal(state.labels.has("agent:waiting-for-codex"), true);
  assert.match(state.comments[0].body, /prarness-intake-state:v2/);
  assert.match(state.comments[0].body, /직접 댓글/);
  const pullCall = state.calls.find((call) => call.method === "POST" && call.path.endsWith("/pulls"));
  assert.equal(pullCall.body.draft, true);
  assert.match(state.pull.body, /@codex Run one complete managed PRarness session/);
  assert.match(state.pull.body, /--repository owner\/repo --issue 1 --pr 7/);
  assert.match(state.pull.body, /Do not use `make_pr`/);
  assert.match(state.pull.body, /status=PUBLICATION_VERIFIED/);

  state.defaultSha = "7".repeat(40);
  state.pull.body = "legacy generic dispatch prompt";
  const repeated = await executeHostlessIntake({ repository: "owner/repo", runtime_ref: runtimeRef, repo, client, event_name: "issues", event: issueEvent() });
  assert.equal(repeated.branch_created, false);
  assert.equal(repeated.pr_created, false);
  assert.equal(repeated.state.source_sha, sourceSha);
  assert.equal(state.comments.length, 1);
  assert.equal(state.calls.filter((call) => call.method === "POST" && call.path.endsWith("/git/refs")).length, 1);
  assert.equal(state.calls.filter((call) => call.method === "POST" && call.path.endsWith("/pulls")).length, 1);
  assert.match(state.pull.body, /--repository owner\/repo --issue 1 --pr 7/);
  assert.equal(state.calls.filter((call) => call.method === "PATCH" && call.path.endsWith("/pulls/7")).length, 2);
});

test("intake refuses to reuse a queue pinned to a different runtime", async () => {
  const repo = await targetRepository();
  const { client } = fakeClient();
  await executeHostlessIntake({ repository: "owner/repo", runtime_ref: runtimeRef, repo, client, event_name: "issues", event: issueEvent() });
  await assert.rejects(
    executeHostlessIntake({ repository: "owner/repo", runtime_ref: "8".repeat(40), repo, client, event_name: "issues", event: issueEvent() }),
    (error) => error.code === "STALE_RUNTIME_REF",
  );
});

test("Cloud dispatch comment binds exact identifiers and verified publication", () => {
  const comment = cloudDispatchComment("owner/repo", 12, 34);
  assert.match(comment, /^@codex Run one complete managed PRarness session/);
  assert.match(comment, /prarness-github-setup --verify owner\/repo/);
  assert.match(comment, /prarness-session prepare --repository owner\/repo --issue 12 --pr 34/);
  assert.match(comment, /Read the `instructions` path/);
  assert.match(comment, /prarness-session publish/);
  assert.match(comment, /complete=true/);
  assert.throws(() => cloudDispatchComment("unsafe", 12, 34), (error) => error.code === "INVALID_REPOSITORY");
});

test("untrusted Issue intake stops at explicit maintainer approval", async () => {
  const repo = await targetRepository();
  const { client, state } = fakeClient({ association: "NONE" });
  const result = await executeHostlessIntake({ repository: "owner/repo", runtime_ref: runtimeRef, repo, client, event_name: "issues", event: issueEvent("NONE") });
  assert.equal(result.operation, "approval_required");
  assert.equal(state.labels.has("agent:approval-required"), true);
  assert.equal(state.calls.some((call) => call.path.endsWith("/git/refs")), false);
  assert.match(state.comments[0].body, /approve-intake/);
});

test("intake recovers a partially-created branch only from its matching manifest", async () => {
  const repo = await targetRepository();
  const { client, state } = fakeClient();
  state.branchSha = bootstrapSha;
  state.recoveryManifest = {
    version: 2,
    repository: "owner/repo",
    issue: 1,
    branch: "agent/issue-1-mixed-fraction-scaling",
    source_sha: sourceSha,
    runtime_ref: runtimeRef,
  };
  const result = await executeHostlessIntake({ repository: "owner/repo", runtime_ref: runtimeRef, repo, client, event_name: "issues", event: issueEvent() });
  assert.equal(result.branch_created, false);
  assert.equal(result.pr_created, true);
  assert.equal(result.state.source_sha, sourceSha);
  assert.equal(state.calls.some((call) => call.path.includes("/contents/.prarness/requests/issue-1.json")), true);
});

test("bot-authored approval commands are ignored", async () => {
  const repo = await targetRepository();
  const { client, state } = fakeClient();
  const result = await executeHostlessIntake({
    repository: "owner/repo",
    runtime_ref: runtimeRef,
    repo,
    client,
    event_name: "issue_comment",
    event: { action: "created", issue: { number: 1 }, comment: { body: "/agent approve-intake", author_association: "NONE", user: { type: "Bot" } } },
  });
  assert.equal(result.operation, "noop");
  assert.equal(result.reason, "untrusted_command");
  assert.equal(state.calls.length, 0);
});
