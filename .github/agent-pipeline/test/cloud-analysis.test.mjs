import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { analyzeRepositoryIssue } from "../cloud-analysis.mjs";
import { checkRepositoryCompatibility } from "../repository-check.mjs";
import { selectPrTeam } from "../pipeline.mjs";

const exec = promisify(execFile);

async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), "prarness-cloud-analysis-"));
  await exec("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await mkdir(join(repo, ".github"));
  await mkdir(join(repo, "src"));
  await mkdir(join(repo, "test"));
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
ci:
  required: true
  trigger: pull_request
  workflow: ci.yml
  app_slug: github-actions
  required_checks:
    - Test
  timeout_seconds: 300
`);
  await writeFile(join(repo, ".github/CODEOWNERS"), `* @maintainer
src/** @backend-owner
test/** @test-owner
`);
  await writeFile(join(repo, "src/scaling.js"), "export function scaleMixedFraction(value) { return value; }\n");
  await writeFile(join(repo, "test/scaling.test.js"), "// mixed fraction scaling regression\n");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["-c", "user.name=backend-owner", "-c", "user.email=backend-owner@users.noreply.github.com", "commit", "-qm", "base"], { cwd: repo });
  return repo;
}

test("hostless analysis builds CodeGraph and routes the minimal Issue owner from CODEOWNERS", async () => {
  const repo = await fixture();
  const compatibility = checkRepositoryCompatibility({ repo, repository: "owner/repo" });
  const analysis = analyzeRepositoryIssue({
    repo,
    compatibility,
    issue: { number: 1, title: "Mixed fraction scaling", body: "scaleMixedFraction returns the wrong result", labels: [] },
  });
  assert.equal(analysis.owner.assignee, "backend-owner");
  assert.equal(analysis.owner.used_fallback, false);
  assert.ok(analysis.related_paths.includes("src/scaling.js"));
  assert.ok(analysis.codegraph_summary.edge_types.owns >= 3);
  assert.ok(analysis.codegraph_summary.edge_types.related >= 1);
  assert.ok(analysis.codegraph_summary.edge_types.recent_commit >= 1);

  const routing = selectPrTeam(analysis.team, {
    changed_paths: ["src/scaling.js"],
    codegraph: analysis.codegraph,
    issue_assignee: analysis.owner.assignee,
    risk: "high",
  });
  assert.deepEqual(routing.assignees, ["backend-owner"]);
  assert.equal(routing.reviewer, "backend-owner");
});
