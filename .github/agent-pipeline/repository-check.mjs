#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseYaml, stableStringify } from "./pipeline.mjs";

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

export function validateRepositoryConfig(config) {
  exactKeys(config, ["version", "runtime", "publication", "ownership", "validation", "ci", "protected_paths"], "config");
  requireCondition(config.version === 1, "INVALID_PRARNESS_CONFIG", "config.version must be 1");

  exactKeys(config.runtime, ["contract"], "runtime");
  requireCondition(config.runtime.contract === 1, "RUNTIME_CONTRACT_MISMATCH", "runtime.contract must be 1");

  exactKeys(config.publication, ["mode", "branch_prefix"], "publication");
  requireCondition(config.publication.mode === "codex_cloud_direct", "PUBLICATION_NOT_OPTED_IN", "publication.mode must be codex_cloud_direct");
  const branchPrefix = String(config.publication.branch_prefix ?? "");
  requireCondition(branchPrefix === "agent/issue-", "INVALID_PRARNESS_CONFIG", "publication.branch_prefix must be agent/issue-");

  if (config.ownership !== undefined) {
    exactKeys(config.ownership, ["source", "fallback"], "ownership");
    requireCondition(["codeowners", "config"].includes(config.ownership.source), "INVALID_PRARNESS_CONFIG", "ownership.source must be codeowners or config");
    requireCondition(typeof config.ownership.fallback === "string" && /^[A-Za-z0-9-]+$/.test(config.ownership.fallback), "INVALID_PRARNESS_CONFIG", "ownership.fallback must be one GitHub login");
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
    runtime_contract: 1,
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
    ownership: config.ownership ?? null,
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

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
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
