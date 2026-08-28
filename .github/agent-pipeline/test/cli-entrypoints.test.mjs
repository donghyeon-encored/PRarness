import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const pipelineRoot = fileURLToPath(new URL("..", import.meta.url));

for (const source of ["repository-check.mjs", "cloud-github.mjs", "cloud-publish.mjs", "cloud-session.mjs"]) {
  test(`${source} executes its CLI through an installed symlink`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "prarness-cli-symlink-"));
    const command = join(directory, `prarness-${basename(source, ".mjs")}`);
    await symlink(join(pipelineRoot, source), command);
    await assert.rejects(
      exec(process.execPath, [command]),
      (error) => {
        assert.notEqual(error.code, 0);
        assert.match(error.stderr, /"code":\s*"(?:USAGE|INVALID_REPOSITORY|INVALID_GITHUB_REQUEST)"/);
        return true;
      },
    );
  });
}
