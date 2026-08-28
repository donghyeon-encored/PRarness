import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Issue intake is a thin hostless reusable-workflow caller", async () => {
  const caller = await readFile(new URL("../../workflows/issue-review.yml", import.meta.url), "utf8");
  const intake = await readFile(new URL("../../workflows/reusable-intake.yml", import.meta.url), "utf8");
  const validation = await readFile(new URL("../../workflows/pr-validation.yml", import.meta.url), "utf8");
  const reusableValidation = await readFile(new URL("../../workflows/reusable-validation.yml", import.meta.url), "utf8");

  assert.match(caller, /issues:\n\s+types: \[opened, reopened, labeled\]/);
  assert.match(caller, /issue_comment:\n\s+types: \[created\]/);
  assert.match(caller, /uses: \.\/\.github\/workflows\/reusable-intake\.yml/);
  assert.match(caller, /runtime_ref: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(caller, /OPENAI_API_KEY|CODEX_CLOUD_ENV_ID|self-hosted|cloud-bridge|controller/);

  assert.match(intake, /workflow_call:/);
  assert.match(intake, /runtime_ref:/);
  assert.match(intake, /hostless-intake\.mjs/);
  assert.match(intake, /persist-credentials: false/g);
  assert.match(intake, /contents: write/);
  assert.match(intake, /issues: write/);
  assert.doesNotMatch(intake, /pull-requests: write/);
  assert.doesNotMatch(intake, /secrets:|OPENAI_API_KEY|private-key:|pull_request_target/);

  assert.match(validation, /\n  pull_request:\n/);
  assert.match(validation, /permissions:\n  contents: read/);
  assert.match(reusableValidation, /workflow_call:/);
  assert.doesNotMatch(reusableValidation, /secrets:|private-key:|pull_request_target|persist-credentials: true/);
});

test("Cloud runtime installs one-session commands and has no relay dependency", async () => {
  const policy = await readFile(new URL("../../../docs/git-ground-rules.md", import.meta.url), "utf8");
  const agents = await readFile(new URL("../../../AGENTS.md", import.meta.url), "utf8");
  const installer = await readFile(new URL("../cloud-environment-bootstrap.sh", import.meta.url), "utf8");
  const setup = await readFile(new URL("../cloud-github-setup.sh", import.meta.url), "utf8");
  const session = await readFile(new URL("../cloud-session.mjs", import.meta.url), "utf8");
  const sessionPrompt = await readFile(new URL("../prompts/cloud-session.md", import.meta.url), "utf8");
  const intakeRuntime = await readFile(new URL("../hostless-intake.mjs", import.meta.url), "utf8");
  const cloudContract = await readFile(new URL("../cloud-contract.mjs", import.meta.url), "utf8");
  const analysis = await readFile(new URL("../cloud-analysis.mjs", import.meta.url), "utf8");
  const publisher = await readFile(new URL("../cloud-publish.mjs", import.meta.url), "utf8");

  assert.match(policy, /human.*`@codex`/i);
  assert.match(agents, /prarness-session/);
  assert.match(installer, /PRARNESS_BOOTSTRAP_REF/);
  assert.match(installer, /runtime-manifest\.json/);
  assert.match(installer, /prarness-session/);
  assert.match(setup, /git remote add origin/);
  assert.match(setup, /git credential fill/);
  assert.match(setup, /\.permissions\.push == true/);
  assert.match(session, /prepareCloudSession/);
  assert.match(session, /publishCloudSession/);
  assert.match(session, /analyzeRepositoryIssue/);
  assert.match(session, /prarness-codegraph\.json/);
  assert.match(session, /PREPARED_NOT_PUBLISHED/);
  assert.match(session, /PUBLICATION_VERIFIED/);
  assert.match(sessionPrompt, /normal Codex Summary/);
  assert.match(cloudContract, /Do not use `make_pr`/);
  assert.match(cloudContract, /--repository \$\{repository\} --issue \$\{issue\} --branch \$\{branch\}/);
  assert.doesNotMatch(intakeRuntime, /request\("POST", client\.repoPath\("\/pulls"\)/);
  assert.match(analysis, /buildCodegraph/);
  assert.match(analysis, /selectOwner/);
  assert.match(analysis, /selectPrTeam/);
  assert.match(publisher, /STALE_REMOTE_BRANCH/);
  assert.match(publisher, /Agent-Iteration/);
  assert.match(publisher, /evaluateRisk/);
  assert.match(publisher, /UNRESOLVED_LOW_RISK_REVIEW/);
  assert.doesNotMatch(publisher, /risk:\s*["']medium["']/);
  assert.doesNotMatch(publisher, /problems:\s*\[\]/);
  assert.doesNotMatch([policy, agents, installer, session].join("\n"), /CODEX_CLOUD_ENV_ID|cloud-bridge|github-app-controller|controller-dispatch/);
});
