import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const installer = fileURLToPath(new URL("../cloud-environment-bootstrap.sh", import.meta.url));

test("Cloud environment bootstrap installs the generic setup command from a pinned ref", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-environment-bootstrap-"));
  const home = join(directory, "home");
  const bin = join(directory, "bin");
  const source = join(directory, "source-setup.sh");
  const invocation = join(directory, "invocation.txt");
  const requestedUrl = join(directory, "requested-url.txt");
  await mkdir(home); await mkdir(bin);
  await writeFile(source, `#!/usr/bin/env bash
printf '%s' "$*" > "$TEST_INVOCATION"
`);
  await writeFile(join(bin, "curl"), `#!/usr/bin/env bash
output=''
url=''
while (( $# )); do
  case "$1" in
    --output) output=$2; shift 2 ;;
    --*) shift ;;
    *) url=$1; shift ;;
  esac
done
printf '%s' "$url" > "$TEST_REQUESTED_URL"
cp "$TEST_SETUP_SOURCE" "$output"
`);
  await chmod(source, 0o755); await chmod(join(bin, "curl"), 0o755);

  const ref = "0123456789abcdef0123456789abcdef01234567";
  await exec("bash", [installer, "owner/repo"], {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      PRARNESS_BOOTSTRAP_REF: ref,
      TEST_INVOCATION: invocation,
      TEST_REQUESTED_URL: requestedUrl,
      TEST_SETUP_SOURCE: source,
    },
  });

  assert.equal(await readFile(invocation, "utf8"), "owner/repo");
  assert.match(await readFile(requestedUrl, "utf8"), new RegExp(`${ref}/\\.github/agent-pipeline/cloud-github-setup\\.sh$`));
  const installed = join(home, ".local/bin/prarness-github-setup");
  assert.equal((await stat(installed)).mode & 0o777, 0o700);
});

test("Cloud environment bootstrap rejects mutable or abbreviated refs", async () => {
  await assert.rejects(
    exec("bash", [installer], { env: { ...process.env, PRARNESS_BOOTSTRAP_REF: "main" } }),
    (error) => error.code === 2 && /40-character commit SHA/.test(error.stderr),
  );
});
