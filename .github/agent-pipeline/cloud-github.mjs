#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GitHubClient, stableStringify } from "./pipeline.mjs";
import { checkRepositoryCompatibility } from "./repository-check.mjs";

const REQUIRED_WRITE_PERMISSIONS = ["contents", "issues", "pull_requests", "actions", "checks", "deployments"];
const SUCCESSFUL_CHECK_CONCLUSIONS = new Set(["success"]);

export class CloudGitHubError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CloudGitHubError";
    this.code = code;
  }
}

function requireCondition(condition, code, message) {
  if (!condition) throw new CloudGitHubError(code, message);
}

function safeRepository(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function safeRequestId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value);
}

function metadataPath(options = {}) {
  if (options.auth_metadata) return resolve(options.auth_metadata);
  const configRoot = process.env.GH_CONFIG_DIR ?? resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), "gh");
  return resolve(configRoot, "prarness-auth.json");
}

export function readCloudGitHubIdentity(options = {}) {
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(metadataPath(options), "utf8"));
  } catch {
    throw new CloudGitHubError("MISSING_GITHUB_IDENTITY", "Cloud GitHub authentication metadata is missing; rerun prarness-github-setup");
  }
  requireCondition(metadata?.version === 1 && safeRepository(metadata.repository), "INVALID_GITHUB_IDENTITY", "Cloud GitHub authentication metadata is invalid");
  const appId = String(metadata.app_id ?? process.env.AGENT_APP_ID ?? "");
  const botLogin = String(metadata.bot_login ?? process.env.AGENT_APP_BOT_LOGIN ?? "").toLowerCase();
  requireCondition(/^\d+$/.test(appId) || /^[a-z0-9](?:[a-z0-9-]{0,38})(?:\[bot\])?$/.test(botLogin),
    "MISSING_APP_IDENTITY", "Authenticated GitHub identity must provide an App ID or bot login");
  return {
    ...metadata,
    app_id: appId,
    bot_login: botLogin,
    installation_id: metadata.installation_id == null ? null : String(metadata.installation_id),
  };
}

function ghToken() {
  try {
    const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    requireCondition(token, "MISSING_GITHUB_TOKEN", "gh did not provide an authenticated token");
    return token;
  } catch (error) {
    if (error instanceof CloudGitHubError) throw error;
    throw new CloudGitHubError("MISSING_GITHUB_TOKEN", "gh did not provide an authenticated token");
  }
}

export function createCloudGitHubClient(repository, options = {}) {
  requireCondition(safeRepository(repository), "INVALID_REPOSITORY", "repository must use owner/repository format");
  const identity = readCloudGitHubIdentity(options);
  requireCondition(identity.repository === repository, "REPOSITORY_IDENTITY_MISMATCH", "Authenticated GitHub identity is scoped to another repository");
  return {
    identity,
    client: new GitHubClient({
      token: options.token ?? ghToken(),
      repository,
      app_id: identity.app_id,
      bot_login: identity.bot_login,
      fetch: options.fetch,
    }),
  };
}

function trustedAppAuthored(value, identity) {
  if (identity.app_id && String(value?.performed_via_github_app?.id ?? "") === identity.app_id) return true;
  return Boolean(identity.bot_login && String(value?.user?.login ?? "").toLowerCase() === identity.bot_login && value?.user?.type === "Bot");
}

function operationMarker(requestId) {
  return `<!-- prarness-operation:v1 request_id=${requestId} -->`;
}

export async function preflightGitHubCapabilities(repository, options = {}) {
  const compatibility = checkRepositoryCompatibility({
    repo: options.repo ?? ".",
    repository,
    config: options.config ?? ".github/prarness.yml",
  });
  const { client, identity } = createCloudGitHubClient(repository, options);
  const live = (await client.request("GET", client.repoPath(""))).data;
  requireCondition(live?.full_name === repository, "REPOSITORY_IDENTITY_MISMATCH", "Authenticated API repository does not match the checkout");
  requireCondition(identity.auth_kind === "github_app", "GITHUB_APP_REQUIRED", "Managed publication requires a repository-scoped GitHub App identity");
  const missing = REQUIRED_WRITE_PERMISSIONS.filter((name) => identity.permissions?.[name] !== "write");
  requireCondition(missing.length === 0, "MISSING_GITHUB_CAPABILITY", `GitHub App token is missing required write permissions: ${missing.join(", ")}`);
  const expiresAt = Date.parse(identity.expires_at ?? "");
  const minimumLifetimeMs = ((compatibility.ci?.timeout_seconds ?? 0) + 300) * 1000;
  requireCondition(Number.isFinite(expiresAt) && expiresAt - Date.now() >= minimumLifetimeMs, "TOKEN_REFRESH_REQUIRED",
    "GitHub App token cannot cover the configured CI and publication window; start a fresh Cloud continuation so setup can mint a new token");
  return {
    version: 1,
    repository,
    app_id: identity.app_id || null,
    installation_id: identity.installation_id,
    permissions: identity.permissions ?? {},
    ci: compatibility.ci,
    verified: true,
  };
}

export async function manageIssue(request, options = {}) {
  requireCondition(request.action === "create" || request.action === "update", "INVALID_GITHUB_REQUEST", "issue action must be create or update");
  const { client, identity } = createCloudGitHubClient(request.repository, options);
  let issue;
  if (request.action === "create") {
    requireCondition(typeof request.title === "string" && request.title.trim(), "INVALID_GITHUB_REQUEST", "issue create requires title");
    const marker = operationMarker(request.request_id);
    const existing = (await client.paginate(client.repoPath("/issues?state=all&sort=created&direction=desc")))
      .find((candidate) => !candidate?.pull_request && trustedAppAuthored(candidate, identity) && String(candidate.body ?? "").includes(marker));
    issue = existing ?? (await client.request("POST", client.repoPath("/issues"), {
      body: { title: request.title, body: `${String(request.body ?? "").trim()}\n\n${marker}`.trim(), labels: request.labels ?? [] },
    })).data;
  } else {
    requireCondition(Number.isInteger(request.issue) && request.issue > 0, "INVALID_GITHUB_REQUEST", "issue update requires issue number");
    const body = {};
    for (const key of ["title", "body", "state", "labels", "assignees"]) {
      if (request[key] !== undefined) body[key] = request[key];
    }
    requireCondition(Object.keys(body).length > 0, "INVALID_GITHUB_REQUEST", "issue update has no fields");
    issue = (await client.request("PATCH", client.repoPath(`/issues/${request.issue}`), { body })).data;
  }
  const number = Number(issue?.number);
  requireCondition(Number.isInteger(number) && number > 0, "ISSUE_NOT_CONFIRMED", "GitHub did not return an Issue number");
  const live = (await client.request("GET", client.repoPath(`/issues/${number}`))).data;
  requireCondition(live?.number === number && typeof live?.html_url === "string", "ISSUE_NOT_CONFIRMED", "Live Issue could not be verified");
  if (request.action === "create") requireCondition(trustedAppAuthored(live, identity) && String(live.body ?? "").includes(operationMarker(request.request_id)),
    "ISSUE_NOT_CONFIRMED", "Live Issue is not bound to the trusted App and request ID");
  return { version: 1, request_id: request.request_id, operation: "issue", issue: number, issue_url: live.html_url, verified: true };
}

export async function upsertManagedComment(request, options = {}) {
  requireCondition(Number.isInteger(request.number) && request.number > 0, "INVALID_GITHUB_REQUEST", "comment requires an Issue or PR number");
  requireCondition(typeof request.body === "string" && request.body.trim(), "INVALID_GITHUB_REQUEST", "comment requires body");
  const { client, identity } = createCloudGitHubClient(request.repository, options);
  const marker = operationMarker(request.request_id);
  const body = `${request.body.trim()}\n\n${marker}`;
  const comments = await client.paginate(client.repoPath(`/issues/${request.number}/comments`));
  const existing = comments.find((comment) => trustedAppAuthored(comment, identity) && String(comment.body ?? "").includes(marker));
  const comment = existing
    ? (await client.request("PATCH", client.repoPath(`/issues/comments/${existing.id}`), { body: { body } })).data
    : (await client.request("POST", client.repoPath(`/issues/${request.number}/comments`), { body: { body } })).data;
  requireCondition(Number.isInteger(comment?.id), "COMMENT_NOT_CONFIRMED", "GitHub did not return a comment ID");
  const live = (await client.request("GET", client.repoPath(`/issues/comments/${comment.id}`))).data;
  requireCondition(trustedAppAuthored(live, identity) && String(live?.body ?? "").includes(marker), "COMMENT_NOT_CONFIRMED", "Live App-authored comment could not be verified");
  return {
    version: 1,
    request_id: request.request_id,
    operation: "comment",
    number: request.number,
    comment_id: live.id,
    comment_url: live.html_url,
    reused: Boolean(existing),
    verified: true,
  };
}

async function currentChecks(client, sha, ci) {
  const response = await client.request("GET", client.repoPath(`/commits/${sha}/check-runs?per_page=100`));
  const runs = Array.isArray(response.data?.check_runs) ? response.data.check_runs : [];
  const selected = ci.required_checks.map((name) => {
    const matching = runs.filter((run) => run?.name === name && run?.head_sha === sha && run?.app?.slug === ci.app_slug)
      .sort((left, right) => Number(right.id ?? 0) - Number(left.id ?? 0));
    const run = matching[0] ?? null;
    return run ? {
      id: run.id,
      name,
      status: run.status,
      conclusion: run.conclusion,
      details_url: run.details_url ?? null,
      head_sha: run.head_sha ?? sha,
    } : { id: null, name, status: "missing", conclusion: null, details_url: null, head_sha: sha };
  });
  const failed = selected.filter((run) => run.conclusion && !SUCCESSFUL_CHECK_CONCLUSIONS.has(run.conclusion));
  const pending = selected.filter((run) => run.status !== "completed" || run.id === null);
  return { runs: selected, failed, pending };
}

export async function waitForRequiredChecks(client, sha, ci, options = {}) {
  requireCondition(/^[0-9a-f]{40}$/.test(sha), "INVALID_GITHUB_REQUEST", "CI requires a full lowercase commit SHA");
  if (!ci?.required) return { required: false, verified: true, checks: [] };
  const timeoutMs = (options.timeout_seconds ?? ci.timeout_seconds) * 1000;
  const pollMs = options.poll_interval_ms ?? 10000;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const status = await currentChecks(client, sha, ci);
    requireCondition(status.failed.length === 0, "CI_FAILED", `Required CI checks failed: ${status.failed.map((run) => run.name).join(", ")}`);
    if (status.pending.length === 0) return { required: true, verified: true, checks: status.runs };
    if (Date.now() >= deadline) {
      throw new CloudGitHubError("CI_TIMEOUT", `Required CI checks did not complete: ${status.pending.map((run) => run.name).join(", ")}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  }
}

export async function dispatchAndVerifyCi(request, options = {}) {
  const compatibility = checkRepositoryCompatibility({ repo: options.repo ?? ".", repository: request.repository, config: options.config ?? ".github/prarness.yml" });
  const ci = compatibility.ci;
  requireCondition(ci, "MISSING_CI_CONTRACT", "Repository must configure ci in .github/prarness.yml");
  requireCondition(typeof request.ref === "string" && request.ref && !request.ref.includes("..") && !/\s/.test(request.ref), "INVALID_GITHUB_REQUEST", "CI requires a safe ref");
  const { client } = createCloudGitHubClient(request.repository, options);
  let dispatched = false;
  if (ci.trigger === "workflow_dispatch") {
    const current = await currentChecks(client, request.sha, ci);
    requireCondition(current.failed.length === 0, "CI_FAILED", `Required CI checks failed: ${current.failed.map((run) => run.name).join(", ")}`);
    if (current.runs.every((run) => run.id === null)) {
      await client.request("POST", client.repoPath(`/actions/workflows/${encodeURIComponent(ci.workflow)}/dispatches`), {
        body: { ref: request.ref },
      });
      dispatched = true;
    }
  }
  const status = await waitForRequiredChecks(client, request.sha, ci, options);
  return {
    version: 1,
    request_id: request.request_id,
    operation: "ci",
    workflow: ci.workflow,
    trigger: ci.trigger,
    dispatched,
    sha: request.sha,
    ...status,
  };
}

export async function manageDeployment(request, options = {}) {
  requireCondition(request.action === "create" || request.action === "status", "INVALID_GITHUB_REQUEST", "deployment action must be create or status");
  const { client } = createCloudGitHubClient(request.repository, options);
  if (request.action === "create") {
    requireCondition(typeof request.ref === "string" && request.ref && !request.ref.includes("..") && !/\s/.test(request.ref), "INVALID_GITHUB_REQUEST", "deployment create requires a safe ref");
    requireCondition(typeof request.environment === "string" && /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(request.environment), "INVALID_GITHUB_REQUEST", "deployment create requires a safe environment");
    const existing = (await client.paginate(client.repoPath(`/deployments?ref=${encodeURIComponent(request.ref)}&environment=${encodeURIComponent(request.environment)}`)))
      .find((candidate) => candidate?.ref === request.ref && candidate?.environment === request.environment && candidate?.payload?.prarness_request_id === request.request_id);
    const deployment = existing ?? (await client.request("POST", client.repoPath("/deployments"), {
      body: {
        ref: request.ref,
        environment: request.environment,
        description: String(request.description ?? `PRarness ${request.request_id}`),
        auto_merge: false,
        required_contexts: [],
        payload: { prarness_request_id: request.request_id },
      },
    })).data;
    requireCondition(Number.isInteger(deployment?.id), "DEPLOYMENT_NOT_CONFIRMED", "GitHub did not return a deployment ID");
    const live = (await client.request("GET", client.repoPath(`/deployments/${deployment.id}`))).data;
    requireCondition(live?.id === deployment.id && live?.ref === request.ref, "DEPLOYMENT_NOT_CONFIRMED", "Live deployment does not match the requested ref");
    return { version: 1, request_id: request.request_id, operation: "deployment", deployment_id: live.id, ref: live.ref, environment: live.environment, verified: true };
  }
  requireCondition(Number.isInteger(request.deployment_id) && request.deployment_id > 0, "INVALID_GITHUB_REQUEST", "deployment status requires deployment_id");
  requireCondition(["error", "failure", "inactive", "in_progress", "queued", "pending", "success"].includes(request.state), "INVALID_GITHUB_REQUEST", "deployment status is invalid");
  const status = (await client.request("POST", client.repoPath(`/deployments/${request.deployment_id}/statuses`), {
    body: {
      state: request.state,
      description: String(request.description ?? "PRarness deployment status"),
      environment_url: request.environment_url ?? undefined,
      log_url: request.log_url ?? undefined,
      auto_inactive: request.auto_inactive !== false,
    },
  })).data;
  requireCondition(Number.isInteger(status?.id) && status?.state === request.state, "DEPLOYMENT_NOT_CONFIRMED", "GitHub did not confirm the deployment status");
  const statuses = (await client.request("GET", client.repoPath(`/deployments/${request.deployment_id}/statuses?per_page=100`))).data;
  requireCondition(Array.isArray(statuses) && statuses.some((entry) => entry?.id === status.id && entry?.state === request.state), "DEPLOYMENT_NOT_CONFIRMED", "Live deployment status could not be verified");
  return { version: 1, request_id: request.request_id, operation: "deployment", deployment_id: request.deployment_id, status_id: status.id, state: status.state, verified: true };
}

export async function reconcilePublicationReceipt(receipt, options = {}) {
  requireCondition(receipt?.version === 1 && safeRequestId(receipt.request_id) && safeRepository(receipt.repository), "INVALID_RECEIPT", "Publication receipt is invalid");
  requireCondition(Number.isInteger(receipt.issue) && receipt.issue > 0 && Number.isInteger(receipt.pr) && receipt.pr > 0, "INVALID_RECEIPT", "Publication receipt is missing Issue or PR identity");
  requireCondition(/^[0-9a-f]{40}$/.test(receipt.remote_sha ?? ""), "INVALID_RECEIPT", "Publication receipt is missing remote SHA");
  requireCondition(typeof receipt.branch === "string" && receipt.branch.startsWith(`agent/issue-${receipt.issue}-`), "INVALID_RECEIPT", "Publication receipt branch does not match its source Issue");
  const { client, identity } = createCloudGitHubClient(receipt.repository, options);
  const pull = (await client.request("GET", client.repoPath(`/pulls/${receipt.pr}`))).data;
  requireCondition(pull?.state === "open" && pull?.merged !== true && pull?.head?.repo?.full_name === receipt.repository &&
    pull?.head?.ref === receipt.branch && pull?.head?.sha === receipt.remote_sha,
  "PR_HEAD_MISMATCH", "Live pull request does not match the publication receipt");
  for (const [commentId, subject] of [[receipt.comments?.issue, receipt.issue], [receipt.comments?.pull_request, receipt.pr]]) {
    requireCondition(Number.isInteger(commentId), "INVALID_RECEIPT", "Publication receipt is missing canonical comment IDs");
    const comment = (await client.request("GET", client.repoPath(`/issues/comments/${commentId}`))).data;
    requireCondition(trustedAppAuthored(comment, identity) && String(comment?.issue_url ?? "").endsWith(`/issues/${subject}`),
      "COMMENT_NOT_CONFIRMED", "Publication receipt comment is not authored by the trusted App on the expected Issue or PR");
  }
  const compatibility = checkRepositoryCompatibility({ repo: options.repo ?? ".", repository: receipt.repository, config: options.config ?? ".github/prarness.yml" });
  const ci = await waitForRequiredChecks(client, receipt.remote_sha, compatibility.ci, options);
  return { ...receipt, ci: { ...(receipt.ci ?? {}), ...ci }, reconciled_at: new Date().toISOString(), verified: true };
}

function readRequest(filePath) {
  let request;
  try {
    request = JSON.parse(readFileSync(filePath === "-" ? 0 : resolve(filePath), "utf8"));
  } catch {
    throw new CloudGitHubError("INVALID_GITHUB_REQUEST", "GitHub request must be valid JSON");
  }
  requireCondition(request?.version === 1 && safeRequestId(request.request_id) && safeRepository(request.repository), "INVALID_GITHUB_REQUEST", "GitHub request identity is invalid");
  requireCondition(["preflight", "issue", "comment", "ci", "deployment", "reconcile"].includes(request.operation), "INVALID_GITHUB_REQUEST", "Unsupported GitHub operation");
  return request;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    requireCondition(key.startsWith("--") && index + 1 < argv.length, "USAGE", "Expected --request FILE --result FILE [--repo PATH] [--config PATH]");
    result[key.slice(2).replaceAll("-", "_")] = argv[++index];
  }
  requireCondition(result.request && result.result, "USAGE", "--request and --result are required");
  return result;
}

export async function executeGitHubOperation(request, options = {}) {
  if (request.operation === "preflight") return preflightGitHubCapabilities(request.repository, options);
  if (request.operation === "issue") return manageIssue(request, options);
  if (request.operation === "comment") return upsertManagedComment(request, options);
  if (request.operation === "ci") return dispatchAndVerifyCi(request, options);
  if (request.operation === "deployment") return manageDeployment(request, options);
  requireCondition(request.receipt?.request_id === request.request_id && request.receipt?.repository === request.repository,
    "INVALID_RECEIPT", "Reconcile receipt does not match its outer request identity");
  return reconcilePublicationReceipt(request.receipt, options);
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const request = readRequest(args.request);
    const result = await executeGitHubOperation(request, args);
    writeFileSync(resolve(args.result), `${stableStringify(result)}\n`, { mode: 0o600 });
    process.stdout.write(`${stableStringify({ operation: request.operation, verified: result.verified === true, request_id: request.request_id })}\n`);
  } catch (error) {
    process.stderr.write(`${stableStringify({ error: error.message, code: error.code ?? "UNEXPECTED_ERROR" })}\n`);
    process.exitCode = 1;
  }
}
