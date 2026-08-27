import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { checkRepositoryCompatibility, validateRepositoryConfig } from "../repository-check.mjs";

const exec = promisify(execFile);

function validConfig() {
  return {
    version: 1,
    runtime: { contract: 1 },
    publication: { mode: "codex_cloud_direct", branch_prefix: "agent/issue-" },
    ownership: { source: "codeowners", fallback: "maintainer" },
    validation: { commands: ["npm test"] },
    protected_paths: { additional: ["infra/production/**"] },
  };
}

async function repository() {
  const repo = await mkdtemp(join(tmpdir(), "prarness-repository-check-"));
  await exec("git", ["init", "-q"], { cwd: repo });
  await mkdir(join(repo, ".github"));
  await writeFile(join(repo, ".github/prarness.yml"), `version: 1
runtime:
  contract: 1
publication:
  mode: codex_cloud_direct
  branch_prefix: agent/issue-
ownership:
  source: codeowners
  fallback: maintainer
validation:
  commands:
    - npm test
protected_paths:
  additional:
    - infra/production/**
`);
  await writeFile(join(repo, "AGENTS.md"), "Run npm test before publishing.\n");
  await exec("git", ["add", ".github/prarness.yml", "AGENTS.md"], { cwd: repo });
  return repo;
}

test("repository config opts into scoped Cloud publication", () => {
  const result = validateRepositoryConfig(validConfig());
  assert.equal(result.publication_mode, "codex_cloud_direct");
  assert.equal(result.branch_prefix, "agent/issue-");
  assert.deepEqual(result.validation_commands, ["npm test"]);
});

test("repository compatibility accepts a thin adapter without copied runtime", async () => {
  const repo = await repository();
  const result = checkRepositoryCompatibility({ repo, repository: "owner/repo" });
  assert.equal(result.compatible, true);
  assert.equal(result.config_path, ".github/prarness.yml");
});

test("repository compatibility rejects the legacy deterministic-publisher prohibition", async () => {
  const repo = await repository();
  await writeFile(join(repo, "AGENTS.md"), "Only a deterministic publisher may perform GitHub writes.\n");
  await exec("git", ["add", "AGENTS.md"], { cwd: repo });
  assert.throws(
    () => checkRepositoryCompatibility({ repo, repository: "owner/repo" }),
    (error) => error.code === "LEGACY_PUBLICATION_POLICY" && /AGENTS\.md/.test(error.message),
  );
});

test("repository compatibility refuses missing explicit opt-in", async () => {
  const repo = await mkdtemp(join(tmpdir(), "prarness-repository-check-missing-"));
  await exec("git", ["init", "-q"], { cwd: repo });
  assert.throws(
    () => checkRepositoryCompatibility({ repo, repository: "owner/repo" }),
    (error) => error.code === "MISSING_PRARNESS_CONFIG",
  );
});
