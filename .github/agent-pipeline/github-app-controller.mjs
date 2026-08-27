#!/usr/bin/env node

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stableStringify } from "./pipeline.mjs";

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const DELIVERY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class GitHubAppControllerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GitHubAppControllerError";
    this.code = code;
  }
}

function requireCondition(condition, code, message) {
  if (!condition) throw new GitHubAppControllerError(code, message);
}

export function verifyWebhookSignature(secret, body, signature) {
  requireCondition(typeof secret === "string" && secret.length >= 32, "INVALID_WEBHOOK_SECRET", "Webhook secret must contain at least 32 characters");
  requireCondition(Buffer.isBuffer(body), "INVALID_WEBHOOK_BODY", "Webhook body must be bytes");
  requireCondition(typeof signature === "string" && /^sha256=[0-9a-f]{64}$/.test(signature), "INVALID_WEBHOOK_SIGNATURE", "Webhook signature has an invalid shape");
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const suppliedBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  requireCondition(suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes), "INVALID_WEBHOOK_SIGNATURE", "Webhook signature did not match");
  return true;
}

function issueFromAgentBranch(branch) {
  const match = String(branch ?? "").match(/^agent\/issue-(\d+)(?:-|$)/);
  return match ? Number(match[1]) : null;
}

function requestIdFromComment(body, delivery) {
  const operation = String(body ?? "").match(/<!-- prarness-operation:v1 request_id=([A-Za-z0-9][A-Za-z0-9._-]{7,127}) -->/);
  if (operation) return operation[1];
  return deliveryRequestId(delivery);
}

function deliveryRequestId(delivery) {
  return `gh-${createHash("sha256").update(delivery).digest("hex").slice(0, 32)}`;
}

export function normalizeWebhookDelivery(eventName, delivery, payload) {
  requireCondition(DELIVERY_PATTERN.test(delivery ?? ""), "INVALID_DELIVERY_ID", "GitHub delivery ID is invalid");
  if (eventName === "ping") return null;
  const repository = payload?.repository?.full_name;
  const installationId = payload?.installation?.id;
  requireCondition(REPOSITORY_PATTERN.test(repository ?? "") && Number.isInteger(installationId) && installationId > 0,
    "INVALID_WEBHOOK_PAYLOAD", "Webhook payload is missing repository or installation identity");
  const common = {
    version: 1,
    delivery_id: delivery,
    repository,
    installation_id: installationId,
    received_event: eventName,
    received_action: String(payload.action ?? ""),
  };

  if (eventName === "issues" && ["opened", "edited", "reopened"].includes(payload.action)) {
    return { ...common, request_id: deliveryRequestId(delivery), operation: "dispatch", stage: "triage", issue: payload.issue?.number ?? null, pr: null, sha: null, dispatchable: true };
  }
  if (eventName === "issue_comment" && ["created", "edited"].includes(payload.action)) {
    // Pull-request comment payloads do not contain the managed head branch, so
    // they cannot be bound to the source Issue without an extra privileged
    // lookup. Source-Issue comments are the sole operation/command channel.
    if (payload.issue?.pull_request) return null;
    const body = String(payload.comment?.body ?? "");
    const command = body.trim();
    const isCanonical = body.includes("<!-- prarness-operation:v1");
    const isHumanCommand = command === "/agent resume" || command === "/agent approve-intake" || command.startsWith("/agent approve-protected ");
    if (!isCanonical && !isHumanCommand) return null;
    return {
      ...common,
      request_id: requestIdFromComment(body, delivery),
      operation: isCanonical ? "reconcile" : "dispatch",
      stage: isCanonical ? "recover" : "triage",
      issue: payload.issue?.number ?? null,
      pr: null,
      sha: null,
      comment_id: payload.comment?.id ?? null,
      app_id: payload.comment?.performed_via_github_app?.id ?? null,
      dispatchable: true,
    };
  }
  if (eventName === "pull_request" && ["opened", "synchronize", "reopened", "ready_for_review", "closed"].includes(payload.action)) {
    const branch = payload.pull_request?.head?.ref;
    const issue = issueFromAgentBranch(branch);
    if (!issue || payload.pull_request?.head?.repo?.full_name !== repository) return null;
    return {
      ...common,
      request_id: deliveryRequestId(delivery),
      operation: "reconcile",
      stage: payload.action === "closed" ? "closed" : "review",
      issue,
      pr: payload.pull_request?.number ?? null,
      branch,
      sha: payload.pull_request?.head?.sha ?? null,
      dispatchable: false,
    };
  }
  if (eventName === "check_run" && payload.action === "completed") {
    const branch = payload.check_run?.pull_requests?.[0]?.head?.ref ?? payload.check_run?.check_suite?.head_branch;
    const issue = issueFromAgentBranch(branch);
    if (!issue) return null;
    const externalId = String(payload.check_run?.external_id ?? "");
    return {
      ...common,
      request_id: DELIVERY_PATTERN.test(externalId) ? externalId : deliveryRequestId(delivery),
      operation: "reconcile",
      stage: "ci",
      issue,
      pr: payload.check_run?.pull_requests?.[0]?.number ?? null,
      branch,
      sha: payload.check_run?.head_sha ?? null,
      conclusion: payload.check_run?.conclusion ?? null,
      dispatchable: false,
    };
  }
  if (eventName === "workflow_run" && payload.action === "completed") {
    const branch = payload.workflow_run?.head_branch;
    const issue = issueFromAgentBranch(branch);
    if (!issue) return null;
    return {
      ...common,
      request_id: deliveryRequestId(delivery),
      operation: "reconcile",
      stage: "ci",
      issue,
      pr: payload.workflow_run?.pull_requests?.[0]?.number ?? null,
      branch,
      sha: payload.workflow_run?.head_sha ?? null,
      conclusion: payload.workflow_run?.conclusion ?? null,
      workflow_run_id: payload.workflow_run?.id ?? null,
      dispatchable: false,
    };
  }
  return null;
}

function safeSpoolRoot(value) {
  const root = resolve(value);
  requireCondition(root !== "/" && basename(root) !== "." && basename(root) !== "..", "UNSAFE_SPOOL", "Webhook spool path is unsafe");
  return root;
}

export function spoolWebhookJob(spool, job) {
  const root = safeSpoolRoot(spool);
  const pending = resolve(root, "pending");
  const statusDirectories = ["pending", "processing", "completed", "failed"].map((name) => resolve(root, name));
  for (const directory of statusDirectories) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = `${job.delivery_id}.json`;
  if (statusDirectories.some((directory) => {
    try {
      readFileSync(resolve(directory, name));
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  })) return { duplicate: true, path: null };
  const jobPath = resolve(pending, name);
  try {
    writeFileSync(jobPath, `${stableStringify({ ...job, attempts: 0, received_at: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code === "EEXIST") return { duplicate: true, path: null };
    throw error;
  }
  return { duplicate: false, path: jobPath };
}

function dispatchJob(dispatcher, jobPath, options = {}) {
  requireCondition(isAbsolute(dispatcher), "INVALID_DISPATCHER", "Dispatcher command must be an absolute path");
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(dispatcher, [jobPath], {
      stdio: ["ignore", "ignore", "inherit"],
      env: options.env ?? process.env,
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        const error = new GitHubAppControllerError("DISPATCH_FAILED", `Dispatcher exited with ${code ?? signal ?? "unknown"}`);
        error.retryable = code === 75;
        rejectPromise(error);
      }
    });
  });
}

export async function drainWebhookSpool(spool, dispatcher, options = {}) {
  const root = safeSpoolRoot(spool);
  const pending = resolve(root, "pending");
  const processing = resolve(root, "processing");
  const completed = resolve(root, "completed");
  const failed = resolve(root, "failed");
  for (const directory of [pending, processing, completed, failed]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const results = [];
  const maxAttempts = Number(options.max_attempts ?? 5);
  requireCondition(Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 20, "INVALID_RETRY_POLICY", "max_attempts must be from 1 through 20");
  for (const name of readdirSync(pending).filter((entry) => DELIVERY_PATTERN.test(entry.replace(/\.json$/, "")) && entry.endsWith(".json")).sort()) {
    const source = resolve(pending, name);
    const active = resolve(processing, name);
    try {
      renameSync(source, active);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    try {
      await dispatchJob(dispatcher, active, options);
      renameSync(active, resolve(completed, name));
      results.push({ job: name, status: "completed" });
    } catch (error) {
      const job = JSON.parse(readFileSync(active, "utf8"));
      const attempts = Number(job.attempts ?? 0) + 1;
      writeFileSync(active, `${stableStringify({ ...job, attempts, last_error: error.code ?? "DISPATCH_FAILED", last_attempt_at: new Date().toISOString() })}\n`, { mode: 0o600 });
      if (error.retryable === true && attempts < maxAttempts) {
        renameSync(active, resolve(pending, name));
        results.push({ job: name, status: "retrying", attempts, error: error.code ?? "DISPATCH_FAILED" });
      } else {
        renameSync(active, resolve(failed, name));
        results.push({ job: name, status: "failed", attempts, error: error.code ?? "DISPATCH_FAILED" });
      }
    }
  }
  return results;
}

async function readRequestBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    requireCondition(length <= MAX_WEBHOOK_BYTES, "WEBHOOK_TOO_LARGE", "Webhook body exceeds 1 MiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createWebhookServer(options) {
  const secret = readFileSync(resolve(options.secret_file), "utf8").trim();
  const spool = safeSpoolRoot(options.spool);
  const appId = Number(options.app_id);
  requireCondition(Number.isInteger(appId) && appId > 0, "INVALID_APP_ID", "Webhook controller requires the trusted GitHub App ID");
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(`${stableStringify({ healthy: true })}\n`);
        return;
      }
      requireCondition(request.method === "POST" && request.url === "/github/webhook", "NOT_FOUND", "Unknown webhook endpoint");
      const body = await readRequestBody(request);
      verifyWebhookSignature(secret, body, request.headers["x-hub-signature-256"]);
      const delivery = String(request.headers["x-github-delivery"] ?? "");
      const eventName = String(request.headers["x-github-event"] ?? "");
      let payload;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        throw new GitHubAppControllerError("INVALID_WEBHOOK_PAYLOAD", "Webhook body is not valid JSON");
      }
      let job = normalizeWebhookDelivery(eventName, delivery, payload);
      if (job?.received_event === "issue_comment" && job.operation === "reconcile" && job.app_id !== appId) job = null;
      const stored = job ? spoolWebhookJob(spool, job) : { duplicate: false, path: null };
      response.writeHead(stored.duplicate ? 200 : 202, { "content-type": "application/json" });
      response.end(`${stableStringify({ accepted: true, duplicate: stored.duplicate, queued: Boolean(stored.path) })}\n`);
    } catch (error) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "WEBHOOK_TOO_LARGE" ? 413 : 400;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(`${stableStringify({ accepted: false, code: error.code ?? "WEBHOOK_ERROR" })}\n`);
    }
  });
}

function parseArgs(argv) {
  const command = argv[0];
  const result = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    requireCondition(key.startsWith("--") && index + 1 < argv.length, "USAGE", "Expected serve or drain with named arguments");
    result[key.slice(2).replaceAll("-", "_")] = argv[++index];
  }
  return result;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.command === "serve") {
      requireCondition(args.secret_file && args.spool && args.app_id, "USAGE", "serve requires --secret-file, --app-id, and --spool");
      const port = Number(args.port ?? 8787);
      requireCondition(Number.isInteger(port) && port >= 1 && port <= 65535, "USAGE", "port is invalid");
      createWebhookServer(args).listen(port, args.host ?? "127.0.0.1", () => {
        process.stdout.write(`${stableStringify({ listening: true, host: args.host ?? "127.0.0.1", port })}\n`);
      });
    } else if (args.command === "drain") {
      requireCondition(args.spool && args.dispatcher, "USAGE", "drain requires --spool and --dispatcher");
      process.stdout.write(`${stableStringify(await drainWebhookSpool(args.spool, args.dispatcher))}\n`);
    } else {
      throw new GitHubAppControllerError("USAGE", "Expected serve or drain");
    }
  } catch (error) {
    process.stderr.write(`${stableStringify({ error: error.message, code: error.code ?? "UNEXPECTED_ERROR" })}\n`);
    process.exitCode = 1;
  }
}
