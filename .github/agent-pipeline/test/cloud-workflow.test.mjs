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
