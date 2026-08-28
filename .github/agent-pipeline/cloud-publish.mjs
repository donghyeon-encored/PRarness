#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeRepositoryIssue } from "./cloud-analysis.mjs";
import { evaluateRisk, isDirectExecution, matchesGlob, normalizeAgentOutput, publish, selectPrTeam, stableStringify } from "./pipeline.mjs";
import {
  createCloudGitHubClient,
  dispatchAndVerifyCi,
  preflightGitHubCapabilities,
  reconcilePublicationReceipt,
  upsertManagedComment,
} from "./cloud-github.mjs";
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
    "subject_sha", "branch", "allowed_paths", "plan", "review",
  ], "request");
  requireCondition(value.version === 1 && value.runtime_contract === 1, "RUNTIME_CONTRACT_MISMATCH", "Publish request contract must be version 1");
  requireCondition(/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value.request_id ?? ""), "INVALID_PUBLISH_REQUEST", "Invalid request_id");
  requireCondition(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository ?? ""), "INVALID_PUBLISH_REQUEST", "Invalid repository");
  requireCondition(Number.isInteger(value.issue) && value.issue > 0, "INVALID_PUBLISH_REQUEST", "Invalid source Issue");
  requireCondition(Number.isInteger(value.iteration) && value.iteration > 0, "INVALID_PUBLISH_REQUEST", "Invalid implementation iteration");
  requireCondition(value.stage === "implement", "INVALID_PUBLISH_REQUEST", "Only an implement request may publish code");
  requireCondition(/^[0-9a-f]{40}$/.test(value.source_sha ?? "") && /^[0-9a-f]{40}$/.test(value.subject_sha ?? ""), "INVALID_PUBLISH_REQUEST", "Request SHAs must be full lowercase Git SHAs");
  requireCondition(typeof value.branch === "string" && value.branch.startsWith(`agent/issue-${value.issue}-`) && !value.branch.includes("..") && !/\s/.test(value.branch), "UNSAFE_BRANCH", "Managed branch does not match the source Issue");
  requireCondition(Array.isArray(value.allowed_paths) && value.allowed_paths.length > 0 && value.allowed_paths.every((filePath) => typeof filePath === "string" && filePath && !filePath.startsWith("/") && !filePath.includes("..") && !filePath.includes("\\") && !filePath.includes("\0")), "INVALID_ALLOWED_PATHS", "allowed_paths must contain safe repository-relative paths");
  requireCondition(new Set(value.allowed_paths).size === value.allowed_paths.length, "INVALID_ALLOWED_PATHS", "allowed_paths must be unique");
  let plan;
  let review;
  try {
    plan = normalizeAgentOutput(value.plan, "plan");
    review = normalizeAgentOutput(value.review, "review");
  } catch (error) {
    throw new CloudPublishError("INVALID_AGENT_ARTIFACT", error.message);
  }
  requireCondition(plan.issue === value.issue && plan.iteration === value.iteration && plan.phase === "plan",
    "INVALID_AGENT_ARTIFACT", "Plan identity does not match the publish request");
  requireCondition(plan.problems.length > 0 && plan.steps.length > 0 && plan.units.length === 0,
    "INVALID_AGENT_ARTIFACT", "Plan must contain diagnosed problems and one unsplit implementation unit");
  requireCondition(plan.changed_paths.length === value.allowed_paths.length && plan.changed_paths.every((filePath) => value.allowed_paths.includes(filePath)),
    "INVALID_AGENT_ARTIFACT", "Plan changed_paths must exactly match allowed_paths");
  return { ...value, plan, review };
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

function riskReasonText(risk) {
  const reasons = (risk.reasons ?? []).map((reason) => {
    const values = (reason.values ?? []).join(", ");
    return `${reason.type}${reason.category ? `/${reason.category}` : ""}${values ? `: ${values}` : ""}`;
  });
  return reasons.length ? reasons.join("; ") : "No deterministic high-risk signal";
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
    execFileSync("git", ["merge-base", "--is-ancestor", request.source_sha, request.subject_sha], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["merge-base", "--is-ancestor", request.subject_sha, head], { cwd: repo, stdio: "ignore" });
  } catch {
    throw new CloudPublishError("SOURCE_SHA_MISMATCH", "The source, starting branch head, and implementation HEAD are not a fast-forward chain");
  }
  const commitCount = Number(git(repo, ["rev-list", "--count", `${request.subject_sha}..${head}`]).trim());
  requireCondition(commitCount === 1, "INVALID_COMMIT_COUNT", "One Cloud session must append exactly one implementation commit to its starting branch head");
  const commitMessage = git(repo, ["log", "-1", "--format=%B", head]);
  requireCondition(new RegExp(`^Refs #${request.issue}$`, "m").test(commitMessage), "INVALID_COMMIT_TRAILER", "Implementation commit must contain the source Issue trailer");
  requireCondition(new RegExp(`^Agent-Iteration: ${request.iteration}$`, "m").test(commitMessage), "INVALID_COMMIT_TRAILER", "Implementation commit must contain the current Agent-Iteration trailer");
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
  requireCondition(request.plan.validation_commands.length === compatibility.validation_commands.length &&
    request.plan.validation_commands.every((command, index) => command === compatibility.validation_commands[index]),
  "INVALID_AGENT_ARTIFACT", "Plan validation commands do not match the live repository policy");
  requireCondition(request.review.reviewed_sha === head, "STALE_AGENT_REVIEW", "Self-review must target the exact implementation HEAD");
  const invalidFindingPaths = request.review.findings.filter((finding) => !actualPaths.includes(finding.path));
  requireCondition(invalidFindingPaths.length === 0, "INVALID_AGENT_REVIEW",
    `Review findings reference paths outside the implementation diff: ${invalidFindingPaths.map((finding) => finding.path).join(", ")}`);
  const unresolvedLowRisk = request.review.findings.filter((finding) => finding.risk === "low" && finding.must_fix);
  requireCondition(unresolvedLowRisk.length === 0, "UNRESOLVED_LOW_RISK_REVIEW",
    `Low-risk must-fix findings must be resolved inside this Cloud task before publication: ${unresolvedLowRisk.map((finding) => finding.id).join(", ")}`);
  requireCondition(git(repo, ["status", "--porcelain=v1", "-z"]).length === 0, "DIRTY_WORKTREE", "Publication requires a clean worktree after validation and commit");

  const startingRemoteSha = remoteBranchSha(repo, request.branch);
  requireCondition(startingRemoteSha === request.subject_sha, "STALE_REMOTE_BRANCH", "Remote managed branch moved after the Cloud session started");

  await preflightGitHubCapabilities(request.repository, { ...options, repo });
  const { client } = createCloudGitHubClient(request.repository, options);
  const issue = (await client.request("GET", client.repoPath(`/issues/${request.issue}`))).data;
  requireCondition(issue?.number === request.issue && issue?.state === "open" && !issue?.pull_request,
    "UNSAFE_ISSUE", "Source Issue must remain open at publication time");
  const analysis = analyzeRepositoryIssue({ repo, compatibility, issue, changed_paths: actualPaths });
  const risk = evaluateRisk(analysis.team, {
    title: issue.title,
    body: issue.body,
    changed_paths: actualPaths,
    risk: request.plan.risk,
  });
  const prTeam = selectPrTeam(analysis.team, {
    changed_paths: actualPaths,
    codegraph: analysis.codegraph,
    issue_assignee: analysis.owner.assignee,
    risk: risk.risk,
  });
  requireCondition(prTeam.assignees.length > 0, "NO_PR_ASSIGNEE", "R&R analysis did not produce an assignable PR team candidate");
  requireCondition(prTeam.reviewer, "NO_PR_REVIEWER", "R&R analysis did not produce an eligible human reviewer");
  const configuredLogins = new Set(analysis.team.people.filter((person) => person.active !== false).map((person) => person.github.toLowerCase()));
  const review = {
    ...request.review,
    findings: request.review.findings.map((finding) => ({
      ...finding,
      human_owner: finding.risk === "high"
        ? prTeam.reviewer ?? analysis.owner.assignee
        : configuredLogins.has(String(finding.human_owner ?? "").toLowerCase()) ? finding.human_owner : null,
    })),
  };
  const riskProblem = risk.risk === "high" ? [{
    id: "P-900000001",
    problem: "Deterministic risk policy requires human review of the current PR head",
    risk: "high",
    status: "HUMAN_REQUIRED",
    evidence: riskReasonText(risk),
    owner: prTeam.reviewer ?? analysis.owner.assignee,
    next_step: "Review and approve the exact published head SHA",
  }] : [];
  const publicationInput = {
    issue: request.issue,
    branch: request.branch,
    branch_prefix: "agent/issue-",
    changed_paths: actualPaths,
    repo,
    title: `Fix #${request.issue}: ${String(issue.title ?? "Issue implementation").slice(0, 180)}`,
    summary: `Codex Cloud completed the bounded implementation. Risk: ${risk.risk}. Reviewer: ${prTeam.reviewer ? `@${prTeam.reviewer}` : "human selection required"}.`,
    pr_summary: [
      "### Deterministic ownership and risk routing",
      "",
      `- Issue assignee: @${analysis.owner.assignee} (${analysis.owner.rationale})`,
      `- PR assignees: ${prTeam.assignees.map((login) => `@${login}`).join(", ")}`,
      `- Reviewer: ${prTeam.reviewer ? `@${prTeam.reviewer}` : prTeam.fallback_mention ?? "unavailable"}`,
      `- Risk: **${risk.risk}** — ${riskReasonText(risk)}`,
      `- CodeGraph: ${analysis.codegraph_summary.file_count} files / ${analysis.codegraph_summary.edge_count} edges`,
    ].join("\n"),
    assignees: prTeam.assignees,
    max_assignees: analysis.team.pipeline.max_pr_assignees,
    reviewer: prTeam.reviewer,
    fallback_mention: prTeam.fallback_mention,
    plan: request.plan,
    risk,
    state: {
      issue: request.issue,
      branch: request.branch,
      iteration: request.iteration,
      phase: "implement",
      validation: { passed: true, commands: validations },
      protected_paths: { passed: true, matched: [] },
      change_scope: { passed: true, split_required: false, changed_lines: lineCount, target: 200, maximum: 400 },
      assignee: analysis.owner.assignee,
      reviewer: prTeam.reviewer,
      plan: request.plan,
      problems: [...request.plan.problems, ...riskProblem],
    },
    gate: { base_sha: request.source_sha },
  };
  const result = await publish(client, "pr", publicationInput);
  requireCondition(result.pr && result.pr_url, "PR_NOT_CONFIRMED", "GitHub did not return a pull request URL");
  requireCondition(result.assignments?.assigned?.length > 0, "PR_ASSIGNEE_NOT_CONFIRMED", "GitHub did not confirm any selected PR assignee");
  requireCondition(result.reviewer?.requested === prTeam.reviewer, "PR_REVIEWER_NOT_CONFIRMED", "GitHub did not confirm the selected PR reviewer");

  const remoteSha = remoteBranchSha(repo, request.branch);
  requireCondition(remoteSha === head, "REMOTE_SHA_MISMATCH", "Remote branch SHA does not match the local implementation commit");
  const pull = (await client.request("GET", client.repoPath(`/pulls/${result.pr}`))).data;
  requireCondition(pull?.html_url === result.pr_url, "PR_NOT_CONFIRMED", "Live pull request URL does not match the publication result");
  requireCondition(pull?.head?.repo?.full_name === request.repository && pull?.base?.repo?.full_name === request.repository, "UNSAFE_PR_REPOSITORY", "Pull request is not same-repository");
  requireCondition(pull?.head?.ref === request.branch && pull?.head?.sha === head, "PR_HEAD_MISMATCH", "Pull request head does not match the published branch and SHA");
  requireCondition(pull?.state === "open" && pull?.merged !== true, "UNSAFE_PR_LIFECYCLE", "Pull request is not open and unmerged");

  const reviewResult = await publish(client, "review", {
    issue: request.issue,
    pr: result.pr,
    review,
    reviewer: prTeam.reviewer,
    fallback_mention: prTeam.fallback_mention,
    evaluation: {
      all_ok: risk.risk === "low" && review.verdict === "pass",
      human_required: risk.risk === "high" || review.findings.some((finding) => finding.risk === "high"),
      next_phase: risk.risk === "high" ? "human_required" : "review",
    },
    summary: risk.risk === "high"
      ? `High-risk review evidence requires ${prTeam.reviewer ? `@${prTeam.reviewer}` : prTeam.fallback_mention ?? "a maintainer"}.`
      : "Low-risk self-review comments were posted directly; human PR review remains required before merge.",
  });

  const ci = await dispatchAndVerifyCi({
    version: 1,
    request_id: request.request_id,
    repository: request.repository,
    operation: "ci",
    ref: request.branch,
    sha: head,
  }, { ...options, repo });
  const receipt = {
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
    comments: {
      issue: reviewResult.comment?.comment_id ?? result.comment?.comment_id ?? null,
      pull_request: reviewResult.summary?.id ?? result.summary?.id ?? null,
    },
    ownership: { issue_assignee: analysis.owner.assignee, assignees: prTeam.assignees, reviewer: prTeam.reviewer },
    risk,
    review: { verdict: review.verdict, phase: reviewResult.phase, human_required: reviewResult.human_required, findings: review.findings.length },
    ci,
    completed_at: new Date().toISOString(),
    verified: false,
  };
  const verified = await reconcilePublicationReceipt(receipt, { ...options, repo, timeout_seconds: 30 });
  const completion = await upsertManagedComment({
    version: 1,
    request_id: request.request_id,
    repository: request.repository,
    operation: "comment",
    number: request.issue,
    body: `Verified publication complete: PR #${verified.pr} at ${verified.remote_sha}; required CI checks passed. Deterministic risk is ${risk.risk}; review phase is ${reviewResult.phase}.`,
  }, options);
  return { ...verified, completion_comment: completion.comment_id };
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

const isMain = isDirectExecution(import.meta.url);
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
