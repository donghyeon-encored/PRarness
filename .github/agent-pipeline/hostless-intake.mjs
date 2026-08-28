#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GitHubClient, stableStringify } from "./pipeline.mjs";
import { checkRepositoryCompatibility } from "./repository-check.mjs";

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const RUNTIME_REF_PATTERN = /^[0-9a-f]{40}$/;
const LABELS = {
  "agent:approval-required": { color: "fbca04", description: "Maintainer approval is required before PRarness intake" },
  "agent:waiting-for-codex": { color: "1d76db", description: "Draft PR is waiting for a human @codex task mention" },
};

export class HostlessIntakeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HostlessIntakeError";
    this.code = code;
  }
}

function requireCondition(condition, code, message) {
  if (!condition) throw new HostlessIntakeError(code, message);
}

function safeRepository(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function trustedAssociation(value) {
  return TRUSTED_ASSOCIATIONS.has(String(value ?? "").toUpperCase());
}

function slugify(value) {
  const slug = String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "work";
}

function intakeMarker(issue) {
  return `<!-- prarness-intake:v2 issue=${issue} -->`;
}

function stateMarker(state) {
  return `<!-- prarness-intake-state:v2 ${JSON.stringify(state)} -->`;
}

function parseStateMarker(body) {
  const match = String(body ?? "").match(/<!-- prarness-intake-state:v2 (\{[^\n]*\}) -->/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    throw new HostlessIntakeError("INVALID_INTAKE_STATE", "Canonical intake comment contains invalid state JSON");
  }
}

function requestId(issue) {
  return `prarness-issue-${issue}`;
}

function normalizeEvent(eventName, event, dispatch) {
  if (eventName === "issues") {
    const issue = Number(event?.issue?.number);
    requireCondition(Number.isInteger(issue) && issue > 0 && !event.issue?.pull_request, "INVALID_EVENT", "Issue event is missing a source Issue");
    if (event.action === "labeled" && event.label?.name === dispatch.label) {
      return { issue, requested: true, approved: true, reason: "maintainer_label" };
    }
    if (["opened", "reopened"].includes(event.action)) {
      const trusted = trustedAssociation(event.issue?.author_association);
      return {
        issue,
        requested: !trusted || dispatch.auto_on_open_for_trusted === true,
        approved: trusted && dispatch.auto_on_open_for_trusted === true,
        reason: trusted
          ? (dispatch.auto_on_open_for_trusted === true ? "trusted_issue" : "trusted_issue_requires_label")
          : "approval_required",
      };
    }
    return { issue, requested: false, approved: false, reason: "ignored_issue_action" };
  }
  if (eventName === "issue_comment") {
    if (event.issue?.pull_request || event.action !== "created") return { issue: null, requested: false, approved: false, reason: "ignored_comment" };
    const issue = Number(event?.issue?.number);
    requireCondition(Number.isInteger(issue) && issue > 0, "INVALID_EVENT", "Comment event is missing a source Issue");
    const command = String(event.comment?.body ?? "").trim();
    if (command !== "/agent approve-intake") return { issue, requested: false, approved: false, reason: "ignored_comment" };
    return {
      issue,
      requested: trustedAssociation(event.comment?.author_association),
      approved: trustedAssociation(event.comment?.author_association),
      reason: trustedAssociation(event.comment?.author_association) ? "maintainer_command" : "untrusted_command",
    };
  }
  if (eventName === "workflow_dispatch") {
    const issue = Number(event?.inputs?.issue_number);
    requireCondition(Number.isInteger(issue) && issue > 0, "INVALID_EVENT", "workflow_dispatch requires issue_number");
    return { issue, requested: true, approved: true, reason: "manual_dispatch" };
  }
  return { issue: null, requested: false, approved: false, reason: "ignored_event" };
}

function trustedWorkflowComment(comment) {
  return String(comment?.user?.login ?? "").toLowerCase() === "github-actions[bot]" && comment?.user?.type === "Bot";
}

async function ensureLabel(client, name) {
  const definition = LABELS[name];
  requireCondition(definition, "INVALID_LABEL", `Unsupported managed label: ${name}`);
  await client.request("POST", client.repoPath("/labels"), {
    body: { name, ...definition },
    allow_statuses: [422],
  });
}

async function addLabel(client, issue, name) {
  await ensureLabel(client, name);
  await client.request("POST", client.repoPath(`/issues/${issue}/labels`), { body: { labels: [name] } });
}

async function removeLabel(client, issue, name) {
  await client.request("DELETE", client.repoPath(`/issues/${issue}/labels/${encodeURIComponent(name)}`), { allow_statuses: [404] });
}

async function upsertIntakeComment(client, issue, body, state) {
  const marker = intakeMarker(issue);
  const comments = await client.paginate(client.repoPath(`/issues/${issue}/comments`));
  const matches = comments.filter((comment) => trustedWorkflowComment(comment) && String(comment.body ?? "").includes(marker));
  requireCondition(matches.length <= 1, "DUPLICATE_INTAKE_STATE", "More than one trusted intake comment exists for this Issue");
  const rendered = `${body.trim()}\n\n${stateMarker(state)}\n${marker}`;
  const response = matches[0]
    ? await client.request("PATCH", client.repoPath(`/issues/comments/${matches[0].id}`), { body: { body: rendered } })
    : await client.request("POST", client.repoPath(`/issues/${issue}/comments`), { body: { body: rendered } });
  requireCondition(Number.isInteger(response.data?.id), "COMMENT_NOT_CONFIRMED", "GitHub did not confirm the canonical intake comment");
  return response.data;
}

async function findIntakeState(client, issue) {
  const marker = intakeMarker(issue);
  const comments = await client.paginate(client.repoPath(`/issues/${issue}/comments`));
  const matches = comments.filter((comment) => trustedWorkflowComment(comment) && String(comment.body ?? "").includes(marker));
  requireCondition(matches.length <= 1, "DUPLICATE_INTAKE_STATE", "More than one trusted intake comment exists for this Issue");
  if (!matches[0]) return null;
  const state = parseStateMarker(matches[0].body);
  requireCondition(state?.version === 2 && state.issue === issue, "INVALID_INTAKE_STATE", "Canonical intake state does not match its source Issue");
  return { comment: matches[0], state };
}

async function getBranch(client, branch) {
  const refPath = branch.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  const response = await client.request("GET", client.repoPath(`/git/ref/heads/${refPath}`), { allow_statuses: [404] });
  return response.status === 404 ? null : response.data;
}

async function createBootstrapBranch(client, issue, title, baseSha, baseTreeSha, branch, runtimeRef) {
  const existing = await getBranch(client, branch);
  if (existing) {
    const manifestResponse = await client.request("GET", client.repoPath(`/contents/.prarness/requests/issue-${issue}.json?ref=${encodeURIComponent(branch)}`), { allow_statuses: [404] });
    requireCondition(manifestResponse.status !== 404 && manifestResponse.data?.encoding === "base64" && typeof manifestResponse.data?.content === "string",
      "UNTRACKED_MANAGED_BRANCH", "Existing managed branch has no canonical state or recoverable bootstrap manifest");
    let recovered;
    try {
      recovered = JSON.parse(Buffer.from(manifestResponse.data.content.replace(/\s/g, ""), "base64").toString("utf8"));
    } catch {
      throw new HostlessIntakeError("INVALID_REQUEST_MANIFEST", "Existing managed branch contains an invalid bootstrap manifest");
    }
    requireCondition(recovered?.version === 2 && recovered.repository === client.repository && recovered.issue === issue &&
      recovered.branch === branch && recovered.runtime_ref === runtimeRef && /^[0-9a-f]{40}$/.test(recovered.source_sha ?? ""),
    "REQUEST_MANIFEST_MISMATCH", "Existing managed branch bootstrap manifest does not match this intake request");
    return { sha: String(existing.object?.sha ?? ""), source_sha: recovered.source_sha, created: false };
  }
  const manifest = {
    version: 2,
    request_id: requestId(issue),
    repository: client.repository,
    issue,
    branch,
    source_sha: baseSha,
    runtime_ref: runtimeRef,
    dispatch: "human_pr_mention",
  };
  const blob = await client.request("POST", client.repoPath("/git/blobs"), {
    body: { content: `${stableStringify(manifest)}\n`, encoding: "utf-8" },
  });
  requireCondition(/^[0-9a-f]{40}$/.test(blob.data?.sha ?? ""), "BOOTSTRAP_FAILED", "GitHub did not create the request manifest blob");
  const tree = await client.request("POST", client.repoPath("/git/trees"), {
    body: {
      base_tree: baseTreeSha,
      tree: [{ path: `.prarness/requests/issue-${issue}.json`, mode: "100644", type: "blob", sha: blob.data.sha }],
    },
  });
  requireCondition(/^[0-9a-f]{40}$/.test(tree.data?.sha ?? ""), "BOOTSTRAP_FAILED", "GitHub did not create the request manifest tree");
  const commit = await client.request("POST", client.repoPath("/git/commits"), {
    body: {
      message: `chore(prarness): prepare issue #${issue}\n\nRefs #${issue}\nPRarness-Bootstrap: v2`,
      tree: tree.data.sha,
      parents: [baseSha],
    },
  });
  requireCondition(/^[0-9a-f]{40}$/.test(commit.data?.sha ?? ""), "BOOTSTRAP_FAILED", "GitHub did not create the bootstrap commit");
  await client.request("POST", client.repoPath("/git/refs"), {
    body: { ref: `refs/heads/${branch}`, sha: commit.data.sha },
  });
  const live = await getBranch(client, branch);
  requireCondition(live?.object?.sha === commit.data.sha, "BOOTSTRAP_FAILED", "Live managed branch does not match the bootstrap commit");
  return { sha: commit.data.sha, source_sha: baseSha, created: true, title };
}

async function recoverExistingQueue(client, issue, record) {
  const state = record?.state;
  if (!state?.branch) return null;
  requireCondition(typeof state.branch === "string" && state.branch.startsWith(`agent/issue-${issue}-`) &&
    Number.isInteger(state.pr) && state.pr > 0 && /^[0-9a-f]{40}$/.test(state.source_sha ?? "") &&
    /^[0-9a-f]{40}$/.test(state.bootstrap_sha ?? "") && /^[0-9a-f]{40}$/.test(state.runtime_ref ?? ""),
  "INVALID_INTAKE_STATE", "Existing canonical intake state is incomplete");
  const [branch, pullResponse] = await Promise.all([
    getBranch(client, state.branch),
    client.request("GET", client.repoPath(`/pulls/${state.pr}`)),
  ]);
  const pull = pullResponse.data;
  requireCondition(branch?.object?.sha && pull?.number === state.pr && pull?.state === "open" && pull?.merged !== true,
    "STALE_INTAKE_STATE", "Existing managed branch or pull request is missing, closed, or merged");
  requireCondition(pull?.head?.ref === state.branch && pull?.head?.sha === branch.object.sha &&
    pull?.head?.repo?.full_name === client.repository && pull?.base?.repo?.full_name === client.repository,
    "STALE_INTAKE_STATE", "Existing pull request no longer matches canonical intake state");
  return { state: { ...state, phase: "WAITING_FOR_CODEX" }, pull };
}

export function cloudDispatchComment(repository, issue, pr) {
  requireCondition(safeRepository(repository), "INVALID_REPOSITORY", "repository must use owner/repository format");
  requireCondition(Number.isInteger(issue) && issue > 0 && Number.isInteger(pr) && pr > 0,
    "INVALID_SESSION_TARGET", "Cloud dispatch requires positive Issue and PR numbers");
  return [
    `@codex Run one complete managed PRarness session for ${repository}, source Issue #${issue}, and canonical PR #${pr}.`,
    "",
    "Before inspecting or editing code, run these exact commands:",
    "",
    `1. \`$HOME/.local/bin/prarness-github-setup --verify ${repository}\``,
    `2. \`$HOME/.local/bin/prarness-session prepare --repository ${repository} --issue ${issue} --pr ${pr} --output /tmp/prarness-session.json --codegraph-output /tmp/prarness-codegraph.json\``,
    "",
    "Read the `instructions` path printed by prepare completely and follow that pinned contract through plan, implementation, self-review, validate, and publish in this same Cloud task.",
    "Use the existing managed branch and PR. Do not use `make_pr`, create a replacement branch or PR, or stop after a normal code-change Summary.",
    "This request is complete only when `prarness-session publish` returns `status=PUBLICATION_VERIFIED`, `complete=true`, and `verified=true` after confirming the live remote/PR SHA, reviewer assignment, managed review comments, and required CI. If publication cannot be verified, report the exact blocker and do not claim completion.",
  ].join("\n");
}

function pullBody(issue, runtimeRef, repository, pr) {
  return [
    `Closes #${issue}`,
    "",
    "## PRarness Cloud 작업 요청",
    "",
    `- Source Issue: #${issue}`,
    `- Runtime SHA: \`${runtimeRef}\``,
    "- Dispatch mode: `human_pr_mention`",
    "",
    "이 Draft PR은 GitHub Actions가 만든 작업 대기열입니다. Codex Cloud를 시작하려면 연결된 사람이 이 PR에 다음 댓글을 직접 작성하세요.",
    "",
    "```text",
    cloudDispatchComment(repository, issue, pr),
    "```",
    "",
    "Cloud 작업은 임시 request manifest를 최종 변경에서 제거하고, 검증·커밋·push·Issue/PR 상태 갱신을 완료해야 합니다.",
    "",
    "> 자동 merge하지 않습니다.",
  ].join("\n");
}

async function ensurePullBody(client, pull, issue, runtimeRef) {
  const body = pullBody(issue, runtimeRef, client.repository, pull.number);
  if (pull.body === body) return pull;
  const updated = await client.request("PATCH", client.repoPath(`/pulls/${pull.number}`), { body: { body } });
  requireCondition(updated.data?.number === pull.number && updated.data?.body === body,
    "PR_BODY_NOT_CONFIRMED", "GitHub did not confirm the managed Cloud dispatch contract");
  return updated.data;
}

async function ensurePullRequest(client, issue, title, branch, base, runtimeRef) {
  const owner = client.repository.split("/")[0];
  const response = await client.request("GET", client.repoPath(`/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(base)}&per_page=100`));
  const pulls = Array.isArray(response.data) ? response.data : [];
  requireCondition(pulls.length <= 1, "DUPLICATE_MANAGED_PR", "More than one pull request exists for the managed branch");
  if (pulls[0]) {
    requireCondition(pulls[0].state === "open" && pulls[0].merged !== true, "CLOSED_MANAGED_PR", "The canonical managed pull request is closed or merged");
    return { pull: await ensurePullBody(client, pulls[0], issue, runtimeRef), created: false };
  }
  const created = await client.request("POST", client.repoPath("/pulls"), {
    body: {
      title: `Draft: ${String(title ?? `Issue #${issue}`).slice(0, 180)}`,
      body: `Closes #${issue}\n\nPRarness is finalizing the managed Cloud dispatch contract.`,
      head: branch,
      base,
      draft: true,
    },
  });
  requireCondition(Number.isInteger(created.data?.number) && created.data?.html_url, "PR_NOT_CONFIRMED", "GitHub did not confirm the bootstrap pull request");
  return { pull: await ensurePullBody(client, created.data, issue, runtimeRef), created: true };
}

export async function executeHostlessIntake(options = {}) {
  const repository = String(options.repository ?? process.env.GITHUB_REPOSITORY ?? "");
  const runtimeRef = String(options.runtime_ref ?? "");
  requireCondition(safeRepository(repository), "INVALID_REPOSITORY", "repository must use owner/repository format");
  requireCondition(RUNTIME_REF_PATTERN.test(runtimeRef), "INVALID_RUNTIME_REF", "runtime_ref must be a reviewed full lowercase commit SHA");
  const compatibility = checkRepositoryCompatibility({
    repo: options.repo ?? ".",
    repository,
    config: options.config ?? ".github/prarness.yml",
  });
  requireCondition(compatibility.dispatch.mode === "human_pr_mention", "UNSUPPORTED_DISPATCH", "Only human_pr_mention dispatch is supported without an external host");
  const event = options.event ?? JSON.parse(readFileSync(resolve(options.event_path ?? process.env.GITHUB_EVENT_PATH), "utf8"));
  const eventName = String(options.event_name ?? process.env.GITHUB_EVENT_NAME ?? "");
  const decision = normalizeEvent(eventName, event, compatibility.dispatch);
  if (!decision.issue || !decision.requested) {
    return { version: 2, repository, operation: "noop", reason: decision.reason, issue: decision.issue };
  }
  const client = options.client ?? new GitHubClient({ token: options.token, repository, fetch: options.fetch });
  const issueResponse = await client.request("GET", client.repoPath(`/issues/${decision.issue}`));
  const issue = issueResponse.data;
  requireCondition(issue?.number === decision.issue && !issue?.pull_request && issue?.state === "open", "UNSAFE_ISSUE", "Source Issue must exist and remain open");
  const approved = decision.approved || trustedAssociation(issue.author_association);
  if (!approved) {
    await addLabel(client, decision.issue, "agent:approval-required");
    const state = { version: 2, issue: decision.issue, phase: "HUMAN_APPROVAL", branch: null, pr: null, runtime_ref: runtimeRef };
    const comment = await upsertIntakeComment(client, decision.issue,
      "PRarness intake requires a maintainer. Apply the configured run label or comment with `/agent approve-intake`.", state);
    return { version: 2, repository, operation: "approval_required", issue: decision.issue, comment_id: comment.id, state };
  }

  const existingRecord = await findIntakeState(client, decision.issue);
  const existingQueue = await recoverExistingQueue(client, decision.issue, existingRecord);
  if (existingQueue) {
    requireCondition(existingQueue.state.runtime_ref === runtimeRef, "STALE_RUNTIME_REF",
      `Existing managed queue is pinned to ${existingQueue.state.runtime_ref}; migrate or close it explicitly before running ${runtimeRef}`);
    existingQueue.pull = await ensurePullBody(client, existingQueue.pull, decision.issue, runtimeRef);
    await removeLabel(client, decision.issue, "agent:approval-required");
    await addLabel(client, decision.issue, "agent:waiting-for-codex");
    const comment = await upsertIntakeComment(client, decision.issue, [
      `Draft PR #${existingQueue.pull.number} is ready: ${existingQueue.pull.html_url}`,
      "",
      "Codex Cloud를 시작하거나 계속하려면 연결된 사람이 해당 PR의 `@codex` 명령을 직접 댓글로 작성하세요.",
    ].join("\n"), existingQueue.state);
    return {
      version: 2,
      repository,
      operation: "bootstrap_pr",
      issue: decision.issue,
      branch: existingQueue.state.branch,
      bootstrap_sha: existingQueue.state.bootstrap_sha,
      branch_created: false,
      pr: existingQueue.pull.number,
      pr_url: existingQueue.pull.html_url,
      pr_created: false,
      comment_id: comment.id,
      requires_human_dispatch: true,
      state: existingQueue.state,
    };
  }

  const repositoryResponse = await client.request("GET", client.repoPath(""));
  const defaultBranch = String(repositoryResponse.data?.default_branch ?? "");
  requireCondition(defaultBranch && !defaultBranch.includes("..") && !/\s/.test(defaultBranch), "INVALID_DEFAULT_BRANCH", "GitHub did not return a safe default branch");
  const baseResponse = await client.request("GET", client.repoPath(`/commits/${encodeURIComponent(defaultBranch)}`));
  const baseSha = String(baseResponse.data?.sha ?? "");
  const baseTreeSha = String(baseResponse.data?.commit?.tree?.sha ?? "");
  requireCondition(/^[0-9a-f]{40}$/.test(baseSha) && /^[0-9a-f]{40}$/.test(baseTreeSha), "INVALID_BASE", "GitHub did not return the default branch commit and tree");
  const branch = `agent/issue-${decision.issue}-${slugify(issue.title)}`;
  const bootstrap = await createBootstrapBranch(client, decision.issue, issue.title, baseSha, baseTreeSha, branch, runtimeRef);
  const managed = await ensurePullRequest(client, decision.issue, issue.title, branch, defaultBranch, runtimeRef);
  await removeLabel(client, decision.issue, "agent:approval-required");
  await addLabel(client, decision.issue, "agent:waiting-for-codex");
  const state = {
    version: 2,
    issue: decision.issue,
    phase: "WAITING_FOR_CODEX",
    branch,
    pr: managed.pull.number,
    source_sha: bootstrap.source_sha,
    bootstrap_sha: bootstrap.sha,
    runtime_ref: runtimeRef,
  };
  const comment = await upsertIntakeComment(client, decision.issue, [
    `Draft PR #${managed.pull.number} is ready: ${managed.pull.html_url}`,
    "",
    "Codex Cloud를 시작하려면 연결된 사람이 해당 PR에 PR 본문의 `@codex` 명령을 직접 댓글로 작성하세요.",
    "GitHub Actions는 사용자 계정을 가장하지 않으며 봇 멘션으로 Cloud 실행을 주장하지 않습니다.",
  ].join("\n"), state);
  return {
    version: 2,
    repository,
    operation: "bootstrap_pr",
    issue: decision.issue,
    branch,
    bootstrap_sha: bootstrap.sha,
    branch_created: bootstrap.created,
    pr: managed.pull.number,
    pr_url: managed.pull.html_url,
    pr_created: managed.created,
    comment_id: comment.id,
    requires_human_dispatch: true,
    state,
  };
}

function parseArgs(argv) {
  const result = {};
  const allowed = new Set(["repository", "runtime_ref", "event", "event_name", "repo", "config", "result"]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    requireCondition(key.startsWith("--") && index + 1 < argv.length, "USAGE", "Expected --repository OWNER/REPO --runtime-ref SHA [--event FILE] [--result FILE]");
    const normalized = key.slice(2).replaceAll("-", "_");
    requireCondition(allowed.has(normalized), "USAGE", `Unsupported intake option: ${key}`);
    result[normalized] = argv[++index];
  }
  return result;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await executeHostlessIntake({
      repository: args.repository,
      runtime_ref: args.runtime_ref,
      event_path: args.event,
      event_name: args.event_name,
      repo: args.repo,
      config: args.config,
    });
    const output = `${stableStringify(result)}\n`;
    if (args.result) writeFileSync(resolve(args.result), output, { mode: 0o600 });
    process.stdout.write(output);
  } catch (error) {
    process.stderr.write(`${stableStringify({ error: error.message, code: error.code ?? "UNEXPECTED_ERROR" })}\n`);
    process.exitCode = 1;
  }
}
