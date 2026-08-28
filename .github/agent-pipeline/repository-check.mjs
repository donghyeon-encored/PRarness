#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { isDirectExecution, parseYaml, stableStringify } from "./pipeline.mjs";

const LEGACY_PUBLICATION_RULES = [
  /only a deterministic publisher may perform github writes/i,
  /deterministic publisher owns all github writes/i,
  /must not (?:assign users, )?(?:request reviewers, )?create or update comments/i,
  /do not run `git commit`, `git push`/i,
  /must not receive a github write credential/i,
];
const POLICY_NAMES = new Set(["AGENTS.md", "AGENTS.override.md", "CLAUDE.md"]);
const KNOWN_LEGACY_PATHS = new Set([
  "docs/git-ground-rules.md",
  ".github/agent-pipeline/prompts/implement.md",
]);

export class RepositoryCompatibilityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RepositoryCompatibilityError";
    this.code = code;
  }
}

function requireCondition(condition, code, message) {
  if (!condition) throw new RepositoryCompatibilityError(code, message);
}

function exactKeys(value, allowed, location) {
  requireCondition(value && typeof value === "object" && !Array.isArray(value), "INVALID_PRARNESS_CONFIG", `${location} must be a mapping`);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  requireCondition(unexpected.length === 0, "INVALID_PRARNESS_CONFIG", `${location} contains unsupported keys: ${unexpected.join(", ")}`);
}

function safeWorkflowName(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]*\.ya?ml$/.test(value) &&
    !value.startsWith("/") && !value.includes("..") && !value.includes("\\");
}

function safePattern(value) {
  return typeof value === "string" && value && !value.startsWith("/") &&
    !value.includes("..") && !value.includes("\\") && !value.includes("\0");
}

function stringList(value, location, pattern = null) {
  requireCondition(Array.isArray(value), "INVALID_PRARNESS_CONFIG", `${location} must be a list`);
  requireCondition(value.every((entry) => typeof entry === "string" && entry.trim() && !entry.includes("\0") &&
    (!pattern || pattern(entry))), "INVALID_PRARNESS_CONFIG", `${location} contains an invalid value`);
  requireCondition(new Set(value).size === value.length, "INVALID_PRARNESS_CONFIG", `${location} must contain unique values`);
}

function validateOwnershipPerson(person, index) {
  const location = `ownership.people[${index}]`;
  exactKeys(person, ["github", "active", "responsibilities", "review"], location);
  requireCondition(typeof person.github === "string" && /^[A-Za-z0-9-]+$/.test(person.github),
    "INVALID_PRARNESS_CONFIG", `${location}.github must be one GitHub login`);
  if (person.active !== undefined) requireCondition(typeof person.active === "boolean", "INVALID_PRARNESS_CONFIG", `${location}.active must be boolean`);
  exactKeys(person.responsibilities, ["domains", "labels", "keywords", "paths"], `${location}.responsibilities`);
  for (const key of ["domains", "labels", "keywords"]) stringList(person.responsibilities[key] ?? [], `${location}.responsibilities.${key}`);
  stringList(person.responsibilities.paths ?? [], `${location}.responsibilities.paths`, safePattern);
  exactKeys(person.review, ["can_review", "high_risk_domains", "high_risk_paths"], `${location}.review`);
  requireCondition(typeof person.review.can_review === "boolean", "INVALID_PRARNESS_CONFIG", `${location}.review.can_review must be boolean`);
  stringList(person.review.high_risk_domains ?? [], `${location}.review.high_risk_domains`);
  stringList(person.review.high_risk_paths ?? [], `${location}.review.high_risk_paths`, safePattern);
}

export function validateRepositoryConfig(config) {
  exactKeys(config, ["version", "repository", "runtime", "dispatch", "publication", "ownership", "codegraph", "validation", "ci", "protected_paths"], "config");
  requireCondition(config.version === 1, "INVALID_PRARNESS_CONFIG", "config.version must be 1");

  if (config.repository !== undefined) {
    requireCondition(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository), "INVALID_PRARNESS_CONFIG", "repository must use owner/repository format");
  }

  exactKeys(config.runtime, ["contract"], "runtime");
  requireCondition(config.runtime.contract === 1, "RUNTIME_CONTRACT_MISMATCH", "runtime.contract must be 1");

  if (config.dispatch !== undefined) {
    exactKeys(config.dispatch, ["mode", "label", "auto_on_open_for_trusted"], "dispatch");
    requireCondition(config.dispatch.mode === "human_pr_mention", "INVALID_PRARNESS_CONFIG", "dispatch.mode must be human_pr_mention");
    requireCondition(typeof config.dispatch.label === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,49}$/.test(config.dispatch.label),
      "INVALID_PRARNESS_CONFIG", "dispatch.label must be a safe GitHub label");
    requireCondition(typeof config.dispatch.auto_on_open_for_trusted === "boolean", "INVALID_PRARNESS_CONFIG", "dispatch.auto_on_open_for_trusted must be boolean");
  }

  exactKeys(config.publication, ["mode", "branch_prefix"], "publication");
  requireCondition(config.publication.mode === "codex_cloud_direct", "PUBLICATION_NOT_OPTED_IN", "publication.mode must be codex_cloud_direct");
  const branchPrefix = String(config.publication.branch_prefix ?? "");
  requireCondition(branchPrefix === "agent/issue-", "INVALID_PRARNESS_CONFIG", "publication.branch_prefix must be agent/issue-");

  requireCondition(config.ownership !== undefined, "INVALID_PRARNESS_CONFIG", "ownership must configure a source and fallback login");
  if (config.ownership !== undefined) {
    exactKeys(config.ownership, ["source", "fallback", "max_issue_assignees", "max_pr_assignees", "people"], "ownership");
    requireCondition(["codeowners", "config"].includes(config.ownership.source), "INVALID_PRARNESS_CONFIG", "ownership.source must be codeowners or config");
    requireCondition(typeof config.ownership.fallback === "string" && /^[A-Za-z0-9-]+$/.test(config.ownership.fallback), "INVALID_PRARNESS_CONFIG", "ownership.fallback must be one GitHub login");
    for (const key of ["max_issue_assignees", "max_pr_assignees"]) {
      if (config.ownership[key] !== undefined) requireCondition(Number.isInteger(config.ownership[key]) && config.ownership[key] >= 1 && config.ownership[key] <= 5,
        "INVALID_PRARNESS_CONFIG", `ownership.${key} must be an integer from 1 through 5`);
    }
    if (config.ownership.people !== undefined) {
      requireCondition(Array.isArray(config.ownership.people) && config.ownership.people.length > 0,
        "INVALID_PRARNESS_CONFIG", "ownership.people must be a non-empty list when provided");
      config.ownership.people.forEach(validateOwnershipPerson);
      const logins = config.ownership.people.map((person) => person.github.toLowerCase());
      requireCondition(new Set(logins).size === logins.length, "INVALID_PRARNESS_CONFIG", "ownership.people contains duplicate GitHub logins");
    }
    requireCondition(config.ownership.source !== "config" || Array.isArray(config.ownership.people),
      "INVALID_PRARNESS_CONFIG", "ownership.source=config requires ownership.people");
  }

  if (config.codegraph !== undefined) {
    exactKeys(config.codegraph, ["max_files", "blame_lookback_days"], "codegraph");
    requireCondition(Number.isInteger(config.codegraph.max_files) && config.codegraph.max_files >= 1 && config.codegraph.max_files <= 20000,
      "INVALID_PRARNESS_CONFIG", "codegraph.max_files must be an integer from 1 through 20000");
    requireCondition(Number.isInteger(config.codegraph.blame_lookback_days) && config.codegraph.blame_lookback_days >= 1 && config.codegraph.blame_lookback_days <= 3650,
      "INVALID_PRARNESS_CONFIG", "codegraph.blame_lookback_days must be an integer from 1 through 3650");
  }

  exactKeys(config.validation, ["commands"], "validation");
  requireCondition(Array.isArray(config.validation.commands) && config.validation.commands.length > 0, "INVALID_PRARNESS_CONFIG", "validation.commands must be a non-empty list");
  requireCondition(config.validation.commands.every((command) => typeof command === "string" && command.trim() && !command.includes("\0") && !command.includes("\n")), "INVALID_PRARNESS_CONFIG", "validation.commands must contain single-line commands");

  exactKeys(config.ci, ["required", "trigger", "workflow", "app_slug", "required_checks", "timeout_seconds"], "ci");
  requireCondition(config.ci.required === true, "INVALID_PRARNESS_CONFIG", "ci.required must be true for managed publication");
  requireCondition(["pull_request", "workflow_dispatch"].includes(config.ci.trigger), "INVALID_PRARNESS_CONFIG", "ci.trigger must be pull_request or workflow_dispatch");
  requireCondition(safeWorkflowName(config.ci.workflow), "INVALID_PRARNESS_CONFIG", "ci.workflow must be a safe .yml or .yaml path/name");
  requireCondition(typeof config.ci.app_slug === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(config.ci.app_slug), "INVALID_PRARNESS_CONFIG", "ci.app_slug must identify the trusted check provider");
  requireCondition(Array.isArray(config.ci.required_checks) && config.ci.required_checks.length > 0 &&
    config.ci.required_checks.every((name) => typeof name === "string" && name.trim() && !name.includes("\0") && !name.includes("\n")),
    "INVALID_PRARNESS_CONFIG", "ci.required_checks must be a non-empty list of single-line check names");
  requireCondition(new Set(config.ci.required_checks).size === config.ci.required_checks.length, "INVALID_PRARNESS_CONFIG", "ci.required_checks must be unique");
  requireCondition(Number.isInteger(config.ci.timeout_seconds) && config.ci.timeout_seconds >= 30 && config.ci.timeout_seconds <= 3000,
    "INVALID_PRARNESS_CONFIG", "ci.timeout_seconds must be an integer from 30 through 3000 so a one-hour App token retains a publication safety margin");

  if (config.protected_paths !== undefined) {
    exactKeys(config.protected_paths, ["additional"], "protected_paths");
    requireCondition(Array.isArray(config.protected_paths.additional), "INVALID_PRARNESS_CONFIG", "protected_paths.additional must be a list");
    requireCondition(config.protected_paths.additional.every((pattern) => typeof pattern === "string" && pattern && !pattern.startsWith("/") && !pattern.includes("..") && !pattern.includes("\\") && !pattern.includes("\0")), "INVALID_PRARNESS_CONFIG", "protected_paths.additional contains an unsafe pattern");
  }

  return {
    version: 1,
    repository: config.repository ?? null,
    runtime_contract: 1,
    dispatch: config.dispatch ?? {
      mode: "human_pr_mention",
      label: "agent:run",
      auto_on_open_for_trusted: false,
    },
    publication_mode: config.publication.mode,
    branch_prefix: branchPrefix,
    validation_commands: [...config.validation.commands],
    ci: {
      required: config.ci.required,
      trigger: config.ci.trigger,
      workflow: config.ci.workflow,
      app_slug: config.ci.app_slug,
      required_checks: [...config.ci.required_checks],
      timeout_seconds: config.ci.timeout_seconds,
    },
    protected_paths: [...(config.protected_paths?.additional ?? [])],
    ownership: config.ownership ? JSON.parse(JSON.stringify(config.ownership)) : null,
    codegraph: config.codegraph ? { ...config.codegraph } : null,
  };
}

function trackedPolicyPaths(repo) {
  const raw = execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return raw.split("\0").filter(Boolean).filter((filePath) => POLICY_NAMES.has(basename(filePath)) || KNOWN_LEGACY_PATHS.has(filePath));
}

export function findLegacyPublicationPolicies(repo) {
  const conflicts = [];
  for (const filePath of trackedPolicyPaths(repo)) {
    const contents = readFileSync(resolve(repo, filePath), "utf8");
    requireCondition(Buffer.byteLength(contents) <= 1024 * 1024, "POLICY_FILE_TOO_LARGE", `Policy file is too large: ${filePath}`);
    if (LEGACY_PUBLICATION_RULES.some((pattern) => pattern.test(contents))) conflicts.push(filePath);
  }
  return conflicts.sort();
}

export function checkRepositoryCompatibility(options = {}) {
  const repo = resolve(options.repo ?? ".");
  const repository = String(options.repository ?? "");
  requireCondition(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), "INVALID_REPOSITORY", "repository must use owner/repository format");
  const configPath = String(options.config ?? ".github/prarness.yml");
  requireCondition(!configPath.startsWith("/") && !configPath.includes("..") && !configPath.includes("\\"), "INVALID_CONFIG_PATH", "config path must be repository-relative");
  let source;
  try {
    source = readFileSync(resolve(repo, configPath), "utf8");
  } catch {
    throw new RepositoryCompatibilityError("MISSING_PRARNESS_CONFIG", `Repository must opt in through ${configPath}`);
  }
  const config = validateRepositoryConfig(parseYaml(source));
  requireCondition(config.repository === null || config.repository === repository, "REPOSITORY_CONFIG_MISMATCH",
    `Configured repository ${config.repository} does not match ${repository}`);
  const conflicts = findLegacyPublicationPolicies(repo);
  requireCondition(conflicts.length === 0, "LEGACY_PUBLICATION_POLICY", `Legacy or conflicting publication policy found in: ${conflicts.join(", ")}`);
  return { compatible: true, repository, config_path: configPath, ...config };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    requireCondition(key.startsWith("--") && index + 1 < argv.length, "USAGE", "Expected --repository OWNER/REPO [--repo PATH] [--config PATH] [--output PATH]");
    result[key.slice(2).replaceAll("-", "_")] = argv[++index];
  }
  return result;
}

const isMain = isDirectExecution(import.meta.url);
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = checkRepositoryCompatibility(args);
    const output = `${stableStringify(result)}\n`;
    if (args.output) writeFileSync(resolve(args.output), output, { mode: 0o600 });
    else process.stdout.write(output);
  } catch (error) {
    process.stderr.write(`${stableStringify({ error: error.message, code: error.code ?? "UNEXPECTED_ERROR" })}\n`);
    process.exitCode = 1;
  }
}
