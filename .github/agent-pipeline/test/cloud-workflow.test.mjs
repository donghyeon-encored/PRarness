import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("public workflow produces bounded Cloud requests but never accesses ChatGPT auth", async () => {
  const workflow = await readFile(new URL("../../workflows/issue-review.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /self-hosted|codex-cloud-relay|CODEX_CLOUD_CLI_PATH/);
  assert.doesNotMatch(workflow, /openai\/codex-action|anthropics\/claude-code-action|OPENAI_API_KEY|ANTHROPIC_API_KEY/);
  assert.match(workflow, /CODEX_CLOUD_ENV_ID: \$\{\{ vars\.CODEX_CLOUD_ENV_ID \}\}/);
  assert.doesNotMatch(workflow, /node "\$CLOUD_BRIDGE" (?:submit|wait|diff|validate-result)/);
  assert.match(workflow, /verify-change:[\s\S]*?if: always\(\) && needs\.implement\.result == 'success'/);
  assert.equal([...workflow.matchAll(/build-cloud-request --stage (?:triage|plan|review|implement) \\\n\s+--team "\$TEAM"/g)].length, 4);
  assert.equal([...workflow.matchAll(/Stop at the external Codex Cloud relay boundary/g)].length, 4);
  assert.equal([...workflow.matchAll(/if: always\(\)\n\s+uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/g)].length, 4);
  for (const job of ["triage", "analyze", "review", "implement"]) {
    const block = workflow.match(new RegExp(`\\n  ${job}:[\\s\\S]*?(?=\\n  [a-z][a-z-]+:|$)`))?.[0] ?? "";
    assert.notEqual(block, "");
    assert.match(block, /runs-on: ubuntu-latest/);
    assert.doesNotMatch(block, /uses: actions\/(?:checkout|setup-node|download-artifact|upload-artifact)@v\d/);
  }
  assert.match(workflow, /protected:\(\$protected\[0\] \| \{passed,matched,reason\}\)/);
});
