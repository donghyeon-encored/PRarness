#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCloudGitHubClient, preflightGitHubCapabilities } from "./cloud-github.mjs";
import { publishCloudRequest } from "./cloud-publish.mjs";
import { stableStringify } from "./pipeline.mjs";
import { checkRepositoryCompatibility } from "./repository-check.mjs";

const STATE_PATTERN = /<!-- prarness-intake-state:v2 (\{[^\n]*\}) -->/;

export class CloudSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CloudSessionError";
    this.code = code;
  }
}

function requireCondition(condition, code, message) {
  if (!condition) throw new CloudSessionError(code, message);
}

function safeRepository(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function safePath(value) {
  return typeof value === "string" && value && !value.startsWith("/") && !value.includes("..") && !value.includes("\\") && !value.includes("\0");
}

function gitPaths(repo, source, head) {
  const output = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", `${source}...${head}`, "--"], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.split("\0").filter(Boolean).sort();
}

function git(repo, args) {
  try {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  } catch (error) {
    throw new CloudSessionError("GIT_COMMAND_FAILED", `git ${args[0]} failed with exit ${error.status ?? "unknown"}`);
  }
}

function parseStateComment(comments, issue) {
  const candidates = comments.filter((comment) =>
    String(comment?.user?.login ?? "").toLowerCase() === "github-actions[bot]" &&
    comment?.user?.type === "Bot" && String(comment.body ?? "").includes(`<!-- prarness-intake:v2 issue=${issue} -->`));
  requireCondition(candidates.length === 1, "MISSING_INTAKE_STATE", "Exactly one trusted hostless intake comment is required");
  const match = String(candidates[0].body ?? "").match(STATE_PATTERN);
  requireCondition(match, "INVALID_INTAKE_STATE", "Trusted intake comment does not contain its state marker");
  let state;
  try {
    state = JSON.parse(match[1]);
  } catch {
    throw new CloudSessionError("INVALID_INTAKE_STATE", "Trusted intake state is not valid JSON");
  }
  requireCondition(state?.version === 2 && state.issue === issue, "INVALID_INTAKE_STATE", "Trusted intake state does not match the source Issue");
  return state;
}

function readOptionalManifest(repo, issue) {
  const path = resolve(repo, `.prarness/requests/issue-${issue}.json`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new CloudSessionError("INVALID_REQUEST_MANIFEST", "PRarness request manifest is not valid JSON");
  }
}

function verifyPinnedRuntime(runtimeRef, executable) {
  const actual = realpathSync(executable);
  requireCondition(actual.includes(`/prarness/${runtimeRef}/`), "RUNTIME_REF_MISMATCH", "prarness-session is not running from the runtime SHA recorded by intake");
}

export async function prepareCloudSession(options = {}) {
  const repo = resolve(options.repo ?? ".");
  const repository = String(options.repository ?? "");
  const issueNumber = Number(options.issue);
  const prNumber = Number(options.pr);
  requireCondition(safeRepository(repository), "INVALID_REPOSITORY", "repository must use owner/repository format");
  requireCondition(Number.isInteger(issueNumber) && issueNumber > 0 && Number.isInteger(prNumber) && prNumber > 0,
    "INVALID_SESSION_TARGET", "prepare requires positive Issue and PR numbers");
  const compatibility = checkRepositoryCompatibility({ repo, repository, config: options.config ?? ".github/prarness.yml" });
  if (!options.skip_preflight) await preflightGitHubCapabilities(repository, options);
  const { client } = options.client
    ? { client: options.client }
    : createCloudGitHubClient(repository, options);
  const [issueResponse, pullResponse, comments] = await Promise.all([
    client.request("GET", client.repoPath(`/issues/${issueNumber}`)),
    client.request("GET", client.repoPath(`/pulls/${prNumber}`)),
    client.paginate(client.repoPath(`/issues/${issueNumber}/comments`)),
  ]);
  const issue = issueResponse.data;
  const pull = pullResponse.data;
  requireCondition(issue?.number === issueNumber && issue?.state === "open" && !issue?.pull_request, "UNSAFE_ISSUE", "Source Issue must exist and remain open");
  requireCondition(pull?.number === prNumber && pull?.state === "open" && pull?.merged !== true, "UNSAFE_PR", "Canonical pull request must exist and remain open");
  requireCondition(pull?.head?.repo?.full_name === repository && pull?.base?.repo?.full_name === repository, "UNSAFE_PR", "Canonical pull request must be same-repository");
  const branch = String(pull?.head?.ref ?? "");
  requireCondition(branch.startsWith(`agent/issue-${issueNumber}-`), "UNSAFE_PR", "Pull request branch does not match its source Issue");
  const state = parseStateComment(comments, issueNumber);
  requireCondition(state.pr === prNumber && state.branch === branch, "INTAKE_STATE_MISMATCH", "Canonical intake state does not match the pull request");
  requireCondition(/^[0-9a-f]{40}$/.test(state.source_sha ?? "") && /^[0-9a-f]{40}$/.test(state.bootstrap_sha ?? "") && /^[0-9a-f]{40}$/.test(state.runtime_ref ?? ""),
    "INVALID_INTAKE_STATE", "Canonical intake state is missing source, bootstrap, or runtime SHA");
  const manifest = readOptionalManifest(repo, issueNumber);
  if (manifest) {
    requireCondition(manifest.version === 2 && manifest.repository === repository && manifest.issue === issueNumber && manifest.branch === branch &&
      manifest.source_sha === state.source_sha && manifest.runtime_ref === state.runtime_ref,
    "REQUEST_MANIFEST_MISMATCH", "Tracked request manifest does not match canonical intake state");
  }
  const head = git(repo, ["rev-parse", "HEAD"]);
  requireCondition(head === pull.head.sha, "CHECKOUT_SHA_MISMATCH", "Cloud checkout HEAD does not match the live pull request head");
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", state.source_sha, head], { cwd: repo, stdio: "ignore" });
  } catch {
    throw new CloudSessionError("SOURCE_SHA_MISMATCH", "Intake source SHA is not an ancestor of the Cloud checkout");
  }
  if (options.require_pinned_runtime) verifyPinnedRuntime(state.runtime_ref, options.executable ?? process.argv[1]);
  const instructionsPath = options.require_pinned_runtime
    ? join(dirname(realpathSync(options.executable ?? process.argv[1])), "prompts", "cloud-session.md")
    : null;
  const commitsAfterBase = Number(git(repo, ["rev-list", "--count", `${state.source_sha}..${head}`]));
  requireCondition(Number.isInteger(commitsAfterBase) && commitsAfterBase >= 1, "MISSING_BOOTSTRAP_COMMIT", "Managed branch is missing its bootstrap commit");
  const requestManifest = manifest ? `.prarness/requests/issue-${issueNumber}.json` : null;
  const existingChangedPaths = gitPaths(repo, state.source_sha, head).filter((filePath) => filePath !== requestManifest);
  const session = {
    version: 1,
    runtime_contract: 1,
    request_id: `prarness-issue-${issueNumber}-iteration-${commitsAfterBase}`,
    repository,
    issue: issueNumber,
    pr: prNumber,
    branch,
    source_sha: state.source_sha,
    subject_sha: head,
    bootstrap_sha: state.bootstrap_sha,
    runtime_ref: state.runtime_ref,
    instructions_path: instructionsPath,
    iteration: commitsAfterBase,
    request_manifest: requestManifest,
    existing_changed_paths: existingChangedPaths,
    validation_commands: compatibility.validation_commands,
    protected_paths: compatibility.protected_paths,
    ci: compatibility.ci,
  };
  if (options.output) writeFileSync(resolve(options.output), `${stableStringify(session)}\n`, { mode: 0o600 });
  return session;
}

function readSession(path) {
  let value;
  try {
    value = JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch {
    throw new CloudSessionError("INVALID_SESSION", "Session file must be valid JSON");
  }
  requireCondition(value?.version === 1 && value.runtime_contract === 1 && safeRepository(value.repository) &&
    Number.isInteger(value.issue) && value.issue > 0 && Number.isInteger(value.pr) && value.pr > 0 &&
    typeof value.branch === "string" && value.branch.startsWith(`agent/issue-${value.issue}-`) &&
    Number.isInteger(value.iteration) && value.iteration > 0 &&
    /^[0-9a-f]{40}$/.test(value.source_sha ?? "") && /^[0-9a-f]{40}$/.test(value.subject_sha ?? "") &&
    /^[0-9a-f]{40}$/.test(value.bootstrap_sha ?? "") && /^[0-9a-f]{40}$/.test(value.runtime_ref ?? "") &&
    typeof value.request_id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value.request_id),
  "INVALID_SESSION", "Session file has an invalid identity or SHA contract");
  requireCondition(Array.isArray(value.validation_commands) && value.validation_commands.length > 0,
    "INVALID_SESSION", "Session file has no validation commands");
  requireCondition(Array.isArray(value.existing_changed_paths) && value.existing_changed_paths.every(safePath),
    "INVALID_SESSION", "Session file has invalid existing changed paths");
  return value;
}

export function validateCloudSession(options = {}) {
  const session = readSession(options.session);
  const repo = resolve(options.repo ?? ".");
  const timeoutMs = options.timeout_ms === undefined ? 1200000 : Number(options.timeout_ms);
  requireCondition(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 3600000,
    "INVALID_TIMEOUT", "Validation timeout must be from 1000 through 3600000 milliseconds");
  const commands = session.validation_commands.map((command) => {
    const result = spawnSync("/bin/bash", ["-lc", command], {
      cwd: repo,
      stdio: options.quiet ? "ignore" : "inherit",
      timeout: timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { command, passed: result.status === 0, exit_code: result.status ?? 1 };
  });
  const report = { version: 1, request_id: session.request_id, commands };
  if (options.result) writeFileSync(resolve(options.result), `${stableStringify(report)}\n`, { mode: 0o600 });
  requireCondition(commands.every((entry) => entry.passed), "VALIDATION_FAILED", "One or more required validation commands failed");
  return report;
}

function readPlan(path) {
  let plan;
  try {
    plan = JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch {
    throw new CloudSessionError("INVALID_PLAN", "Plan file must be valid JSON");
  }
  requireCondition(plan?.version === 1 && Array.isArray(plan.allowed_paths) && plan.allowed_paths.length > 0 &&
    plan.allowed_paths.every(safePath) && new Set(plan.allowed_paths).size === plan.allowed_paths.length,
  "INVALID_PLAN", "Plan must contain unique safe allowed_paths");
  return plan;
}

export async function publishCloudSession(options = {}) {
  const session = readSession(options.session);
  const plan = readPlan(options.plan);
  const missingExistingPaths = session.existing_changed_paths.filter((filePath) => !plan.allowed_paths.includes(filePath));
  requireCondition(missingExistingPaths.length === 0, "INVALID_PLAN",
    `Plan must retain every existing cumulative pull-request path: ${missingExistingPaths.join(", ")}`);
  const temporary = mkdtempSync(join(tmpdir(), "prarness-session-"));
  const requestPath = join(temporary, "publish-request.json");
  try {
    writeFileSync(requestPath, `${stableStringify({
      version: 1,
      runtime_contract: 1,
      request_id: session.request_id,
      repository: session.repository,
      issue: session.issue,
      iteration: session.iteration,
      stage: "implement",
      source_sha: session.source_sha,
      subject_sha: session.subject_sha,
      branch: session.branch,
      allowed_paths: plan.allowed_paths,
    })}\n`, { mode: 0o600 });
    const result = await publishCloudRequest({
      ...options,
      repo: resolve(options.repo ?? "."),
      request: requestPath,
      validation: options.validation,
    });
    if (options.result) writeFileSync(resolve(options.result), `${stableStringify(result)}\n`, { mode: 0o600 });
    return result;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const result = { command: argv[0] };
  requireCondition(["prepare", "validate", "publish"].includes(result.command), "USAGE", "Expected prepare, validate, or publish");
  const allowed = {
    prepare: new Set(["repository", "issue", "pr", "output", "repo", "config"]),
    validate: new Set(["session", "result", "repo", "timeout_ms"]),
    publish: new Set(["session", "plan", "validation", "result", "repo", "config"]),
  }[result.command];
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    requireCondition(key.startsWith("--") && index + 1 < argv.length, "USAGE", "Expected --key value arguments");
    const normalized = key.slice(2).replaceAll("-", "_");
    requireCondition(allowed.has(normalized), "USAGE", `Unsupported ${result.command} option: ${key}`);
    result[normalized] = argv[++index];
  }
  return result;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    let result;
    if (args.command === "prepare") {
      requireCondition(args.repository && args.issue && args.pr && args.output, "USAGE", "prepare requires --repository, --issue, --pr, and --output");
      result = await prepareCloudSession({ ...args, require_pinned_runtime: true, executable: process.argv[1] });
    } else if (args.command === "validate") {
      requireCondition(args.session && args.result, "USAGE", "validate requires --session and --result");
      result = validateCloudSession(args);
    } else {
      requireCondition(args.session && args.plan && args.validation && args.result, "USAGE", "publish requires --session, --plan, --validation, and --result");
      result = await publishCloudSession(args);
    }
    process.stdout.write(`${stableStringify({
      command: args.command,
      verified: true,
      request_id: result.request_id ?? null,
      pr: result.pr ?? null,
      instructions: result.instructions_path ?? null,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${stableStringify({ error: error.message, code: error.code ?? "UNEXPECTED_ERROR" })}\n`);
    process.exitCode = 1;
  }
}
