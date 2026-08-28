#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cloudIssueDispatchComment } from "./cloud-contract.mjs";
import { GitHubClient, stableStringify } from "./pipeline.mjs";
import { checkRepositoryCompatibility } from "./repository-check.mjs";

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const RUNTIME_REF_PATTERN = /^[0-9a-f]{40}$/;
const LABELS = {
  "agent:approval-required": { color: "fbca04", description: "Maintainer approval is required before PRarness intake" },
  "agent:waiting-for-codex": { color: "1d76db", description: "Managed work is waiting for a human @codex task mention" },
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
      recovered.branch === branch && /^[0-9a-f]{40}$/.test(recovered.source_sha ?? ""),
    "REQUEST_MANIFEST_MISMATCH", "Existing managed branch bootstrap manifest does not match this intake request");
    if (recovered.runtime_ref !== runtimeRef) {
      const migrated = { ...recovered, runtime_ref: runtimeRef };
      const updated = await client.request("PUT", client.repoPath(`/contents/.prarness/requests/issue-${issue}.json`), {
        body: {
          message: `chore(prarness): migrate issue #${issue} runtime\n\nRefs #${issue}\nPRarness-Bootstrap: v2`,
          content: Buffer.from(`${stableStringify(migrated)}\n`).toString("base64"),
          branch,
          sha: manifestResponse.data.sha,
        },
      });
      requireCondition(/^[0-9a-f]{40}$/.test(updated.data?.commit?.sha ?? ""), "BOOTSTRAP_MIGRATION_FAILED",
        "GitHub did not create the runtime migration commit");
      const live = await getBranch(client, branch);
      requireCondition(live?.object?.sha === updated.data.commit.sha, "BOOTSTRAP_MIGRATION_FAILED",
        "Live managed branch does not match the runtime migration commit");
      return { sha: updated.data.commit.sha, source_sha: recovered.source_sha, created: false, migrated: true };
    }
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

async function recoverExistingQueue(client, issue, record, runtimeRef) {
  const state = record?.state;
  if (!state?.branch) return null;
  if (state.runtime_ref !== runtimeRef) return null;
  requireCondition(typeof state.branch === "string" && state.branch.startsWith(`agent/issue-${issue}-`) &&
    (state.pr === null || Number.isInteger(state.pr) && state.pr > 0) && /^[0-9a-f]{40}$/.test(state.source_sha ?? "") &&
    /^[0-9a-f]{40}$/.test(state.bootstrap_sha ?? "") && /^[0-9a-f]{40}$/.test(state.runtime_ref ?? ""),
  "INVALID_INTAKE_STATE", "Existing canonical intake state is incomplete");
  const branch = await getBranch(client, state.branch);
  requireCondition(branch?.object?.sha, "STALE_INTAKE_STATE", "Existing managed branch is missing");
  if (state.pr === null) {
    if (branch.object.sha === state.bootstrap_sha) {
      return { state: { ...state, phase: "WAITING_FOR_CODEX" }, pull: null };
    }
    const owner = client.repository.split("/")[0];
    const pullsResponse = await client.request("GET", client.repoPath(
      `/pulls?state=all&head=${encodeURIComponent(`${owner}:${state.branch}`)}&base=${encodeURIComponent(String(state.base ?? ""))}&per_page=100`,
    ));
    const pulls = Array.isArray(pullsResponse.data) ? pullsResponse.data : [];
    requireCondition(pulls.length === 1, "STALE_INTAKE_STATE",
      "Branch-only intake moved without exactly one recoverable managed pull request");
    const pull = pulls[0];
    requireCondition(pull?.state === "open" && pull?.merged !== true && pull?.draft === true &&
      pull?.head?.ref === state.branch && pull?.head?.sha === branch.object.sha &&
      pull?.head?.repo?.full_name === client.repository && pull?.base?.repo?.full_name === client.repository,
    "STALE_INTAKE_STATE", "Existing Cloud-created pull request no longer matches canonical intake state");
    return { state: { ...state, pr: pull.number, phase: "WAITING_FOR_CODEX" }, pull };
  }
  const pullResponse = await client.request("GET", client.repoPath(`/pulls/${state.pr}`));
  const pull = pullResponse.data;
  requireCondition(branch?.object?.sha && pull?.number === state.pr && pull?.state === "open" && pull?.merged !== true && pull?.draft === true,
    "STALE_INTAKE_STATE", "Existing managed branch or pull request is missing, closed, or merged");
  requireCondition(pull?.head?.ref === state.branch && pull?.head?.sha === branch.object.sha &&
    pull?.head?.repo?.full_name === client.repository && pull?.base?.repo?.full_name === client.repository,
    "STALE_INTAKE_STATE", "Existing pull request no longer matches canonical intake state");
  return { state: { ...state, phase: "WAITING_FOR_CODEX" }, pull };
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
  const existingQueue = await recoverExistingQueue(client, decision.issue, existingRecord, runtimeRef);
  if (existingQueue) {
    await removeLabel(client, decision.issue, "agent:approval-required");
    await addLabel(client, decision.issue, "agent:waiting-for-codex");
    const hasPull = existingQueue.pull !== null;
    const comment = await upsertIntakeComment(client, decision.issue, hasPull ? [
      `Draft PR #${existingQueue.pull.number} is ready: ${existingQueue.pull.html_url}`,
      "",
      "Codex Cloud를 계속하려면 연결된 사람이 해당 PR 본문의 전체 `@codex` 명령을 직접 댓글로 작성하세요.",
    ].join("\n") : [
      `Managed branch \`${existingQueue.state.branch}\` is ready. GitHub Actions does not create the pull request.`,
      "",
      "연결된 사람이 이 Issue에 다음 명령 전체를 직접 댓글로 작성하세요:",
      "",
      "```text",
      cloudIssueDispatchComment(repository, decision.issue, existingQueue.state.branch),
      "```",
    ].join("\n"), existingQueue.state);
    return {
      version: 2,
      repository,
      operation: hasPull ? "bootstrap_pr" : "bootstrap_branch",
      issue: decision.issue,
      branch: existingQueue.state.branch,
      bootstrap_sha: existingQueue.state.bootstrap_sha,
      branch_created: false,
      pr: existingQueue.pull?.number ?? null,
      pr_url: existingQueue.pull?.html_url ?? null,
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
  await removeLabel(client, decision.issue, "agent:approval-required");
  await addLabel(client, decision.issue, "agent:waiting-for-codex");
  const state = {
    version: 2,
    issue: decision.issue,
    phase: "WAITING_FOR_CODEX",
    branch,
    pr: null,
    base: defaultBranch,
    source_sha: bootstrap.source_sha,
    bootstrap_sha: bootstrap.sha,
    runtime_ref: runtimeRef,
  };
  const comment = await upsertIntakeComment(client, decision.issue, [
    `Managed branch \`${branch}\` is ready. GitHub Actions does not create the pull request.`,
    "",
    "연결된 사람이 이 Issue에 다음 명령 전체를 직접 댓글로 작성하세요:",
    "",
    "```text",
    cloudIssueDispatchComment(repository, decision.issue, branch),
    "```",
    "",
    "Codex Cloud의 저장소 GitHub App이 Draft PR을 생성하고 같은 작업에서 구현·리뷰·CI 게시까지 계속합니다.",
  ].join("\n"), state);
  return {
    version: 2,
    repository,
    operation: "bootstrap_branch",
    issue: decision.issue,
    branch,
    bootstrap_sha: bootstrap.sha,
    branch_created: bootstrap.created,
    pr: null,
    pr_url: null,
    pr_created: false,
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
