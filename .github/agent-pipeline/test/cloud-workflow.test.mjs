import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("trusted controller and secret-free PR validation keep separate trust boundaries", async () => {
  const controller = await readFile(new URL("../../workflows/issue-review.yml", import.meta.url), "utf8");
  const validation = await readFile(new URL("../../workflows/pr-validation.yml", import.meta.url), "utf8");
  assert.doesNotMatch(controller, /self-hosted|codex-cloud-relay|CODEX_CLOUD_CLI_PATH/);
  assert.doesNotMatch(controller, /openai\/codex-action|anthropics\/claude-code-action|OPENAI_API_KEY|ANTHROPIC_API_KEY/);
  assert.match(controller, /issues:\n\s+types: \[opened\]/);
  assert.doesNotMatch(controller, /issues:\n\s+types: \[[^\]]*labeled/);
  assert.doesNotMatch(controller, /\n  pull_request:\n/);
  assert.match(controller, /CODEX_CLOUD_ENV_ID: \$\{\{ vars\.CODEX_CLOUD_ENV_ID \}\}/);
  assert.doesNotMatch(controller, /node "\$CLOUD_BRIDGE" (?:submit|wait|diff|validate-result)/);
  assert.match(controller, /verify-change:[\s\S]*?if: always\(\) && needs\.implement\.result == 'success'/);
  assert.equal([...controller.matchAll(/build-cloud-request --stage (?:triage|plan|review|implement) \\\n\s+--team "\$TEAM"/g)].length, 4);
  assert.equal([...controller.matchAll(/Stop at the external Codex Cloud relay boundary/g)].length, 4);
  assert.equal([...controller.matchAll(/if: always\(\)\n\s+uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/g)].length, 4);
  assert.match(controller, /permission-actions: write/);
  assert.match(controller, /actions\/workflows\/issue-review\.yml\/dispatches/);
  assert.match(controller, /Preflight required controller configuration/);
  assert.match(controller, /Missing AGENT_APP_ID/);
  assert.match(controller, /Missing CODEX_CLOUD_ENV_ID/);
  assert.match(validation, /\n  pull_request:\n/);
  assert.match(validation, /permissions:\n  contents: read/);
  assert.doesNotMatch(validation, /private-key:|permission-contents: write|permission-pull-requests: write/);
  assert.match(validation, /npm test --prefix \.github\/agent-pipeline/);
  for (const job of ["triage", "analyze", "review", "implement"]) {
    const block = controller.match(new RegExp(`\\n  ${job}:[\\s\\S]*?(?=\\n  [a-z][a-z-]+:|$)`))?.[0] ?? "";
    assert.notEqual(block, "");
    assert.match(block, /runs-on: ubuntu-latest/);
    assert.doesNotMatch(block, /uses: actions\/(?:checkout|setup-node|download-artifact|upload-artifact)@v\d/);
  }
  assert.match(controller, /protected:\(\$protected\[0\] \| \{passed,matched,reason\}\)/);
});

test("Cloud workers bootstrap GitHub and are encouraged to own scoped writes", async () => {
  const policy = await readFile(new URL("../../../docs/git-ground-rules.md", import.meta.url), "utf8");
  const agents = await readFile(new URL("../../../AGENTS.md", import.meta.url), "utf8");
  const bridge = await readFile(new URL("../cloud-bridge.mjs", import.meta.url), "utf8");
  const installer = await readFile(new URL("../cloud-environment-bootstrap.sh", import.meta.url), "utf8");
  const setup = await readFile(new URL("../cloud-github-setup.sh", import.meta.url), "utf8");
  const prompts = await Promise.all(["triage", "diagnose-plan", "implement", "review"].map((name) =>
    readFile(new URL(`../prompts/${name}.md`, import.meta.url), "utf8")));

  assert.match(policy, /direct model GitHub work is actively encouraged/i);
  assert.match(policy, /creates or repairs\s+the `origin` remote/);
  assert.match(agents, /Cloud workers are expected to manage the source Issue/);
  assert.doesNotMatch([policy, agents, bridge, ...prompts].join("\n"), /Only a deterministic publisher|Do not use gh|must not receive a GitHub write credential|deterministic publisher owns all GitHub writes/i);
  assert.match(bridge, /\.local\/bin\/prarness-github-setup --verify/);
  assert.match(installer, /PRARNESS_BOOTSTRAP_REF/);
  assert.match(installer, /40-character commit SHA/);
  assert.match(setup, /git remote add origin/);
  assert.match(setup, /CODEX_GITHUB_REPOSITORY/);
  assert.match(setup, /workflows:\"write\"/);
  assert.match(setup, /oauth_token/);
  assert.match(setup, /gh repo set-default/);
  assert.match(setup, /git ls-remote --exit-code origin HEAD/);
});
