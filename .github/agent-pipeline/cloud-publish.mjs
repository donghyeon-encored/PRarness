#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GitHubClient, matchesGlob, publish, stableStringify } from "./pipeline.mjs";
import { checkRepositoryCompatibility } from "./repository-check.mjs";

class CloudPublishError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CloudPublishError";
    this.code = code;
  }
}

function requireCondition(condition, code, message) {
  if (!condition) throw new CloudPublishError(code, message);
}

function exactKeys(value, allowed, location) {
  requireCondition(value && typeof value === "object" && !Array.isArray(value), "INVALID_PUBLISH_REQUEST", `${location} must be an object`);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  requireCondition(unexpected.length === 0, "INVALID_PUBLISH_REQUEST", `${location} contains unsupported keys: ${unexpected.join(", ")}`);
}

function git(repo, args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", options.quietStderr ? "ignore" : "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (error) {
    throw new CloudPublishError("GIT_COMMAND_FAILED", `git ${args[0]} failed with exit ${error.status ?? "unknown"}`);
  }
}

function readRequest(filePath) {
  let value;
  try {
    value = JSON.parse(readFileSync(filePath === "-" ? 0 : resolve(filePath), "utf8"));
  } catch {
    throw new CloudPublishError("INVALID_PUBLISH_REQUEST", "Publish request must be valid JSON");
  }
  exactKeys(value, [
    "version", "runtime_contract", "request_id", "repository", "issue", "iteration", "stage", "source_sha",
    "subject_sha", "branch", "allowed_paths",
  ], "request");
  requireCondition(value.version === 1 && value.runtime_contract === 1, "RUNTIME_CONTRACT_MISMATCH", "Publish request contract must be version 1");
  requireCondition(/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value.request_id ?? ""), "INVALID_PUBLISH_REQUEST", "Invalid request_id");
  requireCondition(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository ?? ""), "INVALID_PUBLISH_REQUEST", "Invalid repository");
  requireCondition(Number.isInteger(value.issue) && value.issue > 0, "INVALID_PUBLISH_REQUEST", "Invalid source Issue");
  requireCondition(Number.isInteger(value.iteration) && value.iteration > 0, "INVALID_PUBLISH_REQUEST", "Invalid implementation iteration");
  requireCondition(value.stage === "implement", "INVALID_PUBLISH_REQUEST", "Only an implement request may publish code");
  requireCondition(/^[0-9a-f]{40}$/.test(value.source_sha ?? "") && /^[0-9a-f]{40}$/.test(value.subject_sha ?? ""), "INVALID_PUBLISH_REQUEST", "Request SHAs must be full lowercase Git SHAs");
  requireCondition(value.subject_sha === value.source_sha, "INVALID_PUBLISH_REQUEST", "Initial implementation subject_sha must equal source_sha");
  requireCondition(typeof value.branch === "string" && value.branch.startsWith(`agent/issue-${value.issue}-`) && !value.branch.includes("..") && !/\s/.test(value.branch), "UNSAFE_BRANCH", "Managed branch does not match the source Issue");
  requireCondition(Array.isArray(value.allowed_paths) && value.allowed_paths.length > 0 && value.allowed_paths.every((filePath) => typeof filePath === "string" && filePath && !filePath.startsWith("/") && !filePath.includes("..") && !filePath.includes("\\") && !filePath.includes("\0")), "INVALID_ALLOWED_PATHS", "allowed_paths must contain safe repository-relative paths");
  requireCondition(new Set(value.allowed_paths).size === value.allowed_paths.length, "INVALID_ALLOWED_PATHS", "allowed_paths must be unique");
  return value;
}

function readValidation(filePath, request, expectedCommands) {
  let value;
  try {
    value = JSON.parse(readFileSync(resolve(filePath), "utf8"));
  } catch {
    throw new CloudPublishError("INVALID_VALIDATION_REPORT", "Validation report must be valid JSON");
  }
  exactKeys(value, ["version", "request_id", "commands"], "validation report");
  requireCondition(value.version === 1 && value.request_id === request.request_id, "INVALID_VALIDATION_REPORT", "Validation report does not match the publish request");
  requireCondition(Array.isArray(value.commands) && value.commands.length === expectedCommands.length, "INVALID_VALIDATION_REPORT", "Validation report command count does not match repository policy");
  const normalized = value.commands.map((entry, index) => {
    exactKeys(entry, ["command", "passed", "exit_code"], `validation report command ${index + 1}`);
    requireCondition(entry.command === expectedCommands[index], "INVALID_VALIDATION_REPORT", "Validation report commands must exactly match repository policy order");
    requireCondition(entry.passed === true && entry.exit_code === 0, "VALIDATION_FAILED", `Required validation did not pass: ${entry.command}`);
    return { command: entry.command, passed: true, exit_code: 0 };
  });
  return normalized;
}

function changedPaths(repo, sourceSha) {
  const raw = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", `${sourceSha}...HEAD`, "--"], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return raw.split("\0").filter(Boolean).sort();
}

function ghToken() {
  try {
    const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    requireCondition(token.length > 0, "MISSING_GITHUB_TOKEN", "gh did not provide an authenticated token");
    return token;
  } catch (error) {
    if (error instanceof CloudPublishError) throw error;
    throw new CloudPublishError("MISSING_GITHUB_TOKEN", "gh did not provide an authenticated token");
  }
}

function remoteBranchSha(repo, branch) {
  const output = git(repo, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
  const match = output.match(/^([0-9a-f]{40})\s+refs\/heads\/.+$/m);
  requireCondition(match, "REMOTE_BRANCH_MISSING", "Published branch was not found on origin");
  return match[1];
}

const ALWAYS_PROTECTED = [
  ".github/workflows/**",
  ".github/agent-pipeline/**",
  ".github/prarness.yml",
  "CODEOWNERS",
  "docs/git-ground-rules.md",
  "**/AGENTS.md",
  ".env*",
  "**/.env*",
];

function changedLines(repo, sourceSha, head) {
  const output = git(repo, ["diff", "--numstat", `${sourceSha}...${head}`, "--"]);
  let total = 0;
  for (const line of output.trim().split("\n").filter(Boolean)) {
    const [added, deleted] = line.split("\t", 2);
    requireCondition(/^\d+$/.test(added) && /^\d+$/.test(deleted), "BINARY_CHANGE", "Binary changes require human publication review");
    total += Number(added) + Number(deleted);
  }
  return total;
}

export async function publishCloudRequest(options = {}) {
  const repo = resolve(options.repo ?? ".");
  const request = readRequest(options.request);
  const compatibility = checkRepositoryCompatibility({ repo, repository: request.repository, config: options.config ?? ".github/prarness.yml" });

  const origin = git(repo, ["remote", "get-url", "origin"]).trim();
  requireCondition(origin === `https://github.com/${request.repository}.git`, "REMOTE_MISMATCH", "origin does not match the authorized repository");
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  requireCondition(/^[0-9a-f]{40}$/.test(head), "MISSING_COMMIT", "No publishable commit exists");
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", request.source_sha, head], { cwd: repo, stdio: "ignore" });
  } catch {
    throw new CloudPublishError("SOURCE_SHA_MISMATCH", "The requested source SHA is not an ancestor of HEAD");
  }
  const commitCount = Number(git(repo, ["rev-list", "--count", `${request.source_sha}..${head}`]).trim());
  requireCondition(commitCount === 1, "INVALID_COMMIT_COUNT", "One implementation task must publish exactly one commit");
  const actualPaths = changedPaths(repo, request.source_sha);
  requireCondition(actualPaths.length > 0, "EMPTY_IMPLEMENTATION", "Implementation commit has no changed paths");
  const undeclared = actualPaths.filter((filePath) => !request.allowed_paths.includes(filePath));
  requireCondition(undeclared.length === 0, "UNDECLARED_CHANGES", `Implementation changed paths outside its contract: ${undeclared.join(", ")}`);
  const protectedPatterns = [...ALWAYS_PROTECTED, ...compatibility.protected_paths];
  const protectedPaths = actualPaths.filter((filePath) => protectedPatterns.some((pattern) => matchesGlob(filePath, pattern)));
  requireCondition(protectedPaths.length === 0, "PROTECTED_PATH", `Automated Cloud publication cannot modify protected paths: ${protectedPaths.join(", ")}`);
  const lineCount = changedLines(repo, request.source_sha, head);
  requireCondition(lineCount <= 400, "CHANGE_SCOPE_FAILED", `Implementation changes ${lineCount} lines; maximum is 400`);
  const validations = readValidation(options.validation, request, compatibility.validation_commands);
  requireCondition(git(repo, ["status", "--porcelain=v1", "-z"]).length === 0, "DIRTY_WORKTREE", "Publication requires a clean worktree after validation and commit");

  const token = ghToken();
  const client = new GitHubClient({ token, repository: request.repository });
  const publicationInput = {
    issue: request.issue,
    branch: request.branch,
    branch_prefix: "agent/issue-",
    changed_paths: actualPaths,
    repo,
    title: `Fix #${request.issue}`,
    summary: "Codex Cloud completed the bounded implementation and required validation.",
    assignees: compatibility.ownership?.fallback ?? null,
    reviewer: compatibility.ownership?.fallback ?? null,
    plan: { steps: ["Implement the approved source Issue within its allowed path contract"], risk: "medium" },
    state: {
      issue: request.issue,
      branch: request.branch,
      iteration: request.iteration,
      phase: "implement",
      validation: { passed: true, commands: validations },
      protected_paths: { passed: true, matched: [] },
      change_scope: { passed: true, split_required: false, changed_lines: lineCount, target: 200, maximum: 400 },
      problems: [],
    },
    gate: { base_sha: request.source_sha },
  };
  const result = await publish(client, "pr", publicationInput);
  requireCondition(result.pr && result.pr_url, "PR_NOT_CONFIRMED", "GitHub did not return a pull request URL");

  const remoteSha = remoteBranchSha(repo, request.branch);
  requireCondition(remoteSha === head, "REMOTE_SHA_MISMATCH", "Remote branch SHA does not match the local implementation commit");
  const pull = (await client.request("GET", client.repoPath(`/pulls/${result.pr}`))).data;
  requireCondition(pull?.html_url === result.pr_url, "PR_NOT_CONFIRMED", "Live pull request URL does not match the publication result");
  requireCondition(pull?.head?.repo?.full_name === request.repository && pull?.base?.repo?.full_name === request.repository, "UNSAFE_PR_REPOSITORY", "Pull request is not same-repository");
  requireCondition(pull?.head?.ref === request.branch && pull?.head?.sha === head, "PR_HEAD_MISMATCH", "Pull request head does not match the published branch and SHA");
  requireCondition(pull?.state === "open" && pull?.merged !== true, "UNSAFE_PR_LIFECYCLE", "Pull request is not open and unmerged");

  return {
    version: 1,
    request_id: request.request_id,
    repository: request.repository,
    issue: request.issue,
    branch: request.branch,
    local_sha: head,
    remote_sha: remoteSha,
    pr: result.pr,
    pr_url: result.pr_url,
    draft: pull.draft === true,
    reused: result.reused === true,
    verified: true,
  };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    requireCondition(key.startsWith("--") && index + 1 < argv.length, "USAGE", "Expected --request FILE --validation FILE --result FILE [--repo PATH] [--config PATH]");
    result[key.slice(2).replaceAll("-", "_")] = argv[++index];
  }
  requireCondition(result.request && result.validation && result.result, "USAGE", "--request, --validation, and --result are required");
  return result;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await publishCloudRequest(args);
    writeFileSync(resolve(args.result), `${stableStringify(result)}\n`, { mode: 0o600 });
    process.stdout.write(`${stableStringify({ verified: true, pr: result.pr, pr_url: result.pr_url, remote_sha: result.remote_sha })}\n`);
  } catch (error) {
    process.stderr.write(`${stableStringify({ error: error.message, code: error.code ?? "UNEXPECTED_ERROR" })}\n`);
    process.exitCode = 1;
  }
}
