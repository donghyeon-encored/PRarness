import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const installer = fileURLToPath(new URL("../cloud-environment-bootstrap.sh", import.meta.url));
const pipelineRoot = fileURLToPath(new URL("..", import.meta.url));

test("Cloud environment bootstrap verifies and installs the pinned runtime bundle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-environment-bootstrap-"));
  const home = join(directory, "home");
  const bin = join(directory, "bin");
  const source = join(directory, "source-setup.sh");
  const repositoryCheck = join(directory, "repository-check.mjs");
  const publisher = join(directory, "cloud-publish.mjs");
  const manifest = join(directory, "runtime-manifest.json");
  const invocation = join(directory, "invocation.txt");
  const requestedUrl = join(directory, "requested-url.txt");
  await mkdir(home); await mkdir(bin);
  await writeFile(source, `#!/usr/bin/env bash
printf '%s' "$*" > "$TEST_INVOCATION"
`);
  await writeFile(repositoryCheck, "#!/usr/bin/env node\n");
  await writeFile(publisher, "#!/usr/bin/env node\n");
  const entries = [
    ["cloud-github-setup.sh", source],
    ["repository-check.mjs", repositoryCheck],
    ["cloud-publish.mjs", publisher],
  ];
  await writeFile(manifest, JSON.stringify({
    version: 1,
    runtime_contract: 1,
    files: await Promise.all(entries.map(async ([path, file]) => ({
      path,
      sha256: createHash("sha256").update(await readFile(file)).digest("hex"),
      executable: true,
    }))),
  }));
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
printf '%s\\n' "$url" >> "$TEST_REQUESTED_URL"
case "$url" in
  */runtime-manifest.json) cp "$TEST_MANIFEST_SOURCE" "$output" ;;
  */cloud-github-setup.sh) cp "$TEST_SETUP_SOURCE" "$output" ;;
  */repository-check.mjs) cp "$TEST_CHECK_SOURCE" "$output" ;;
  */cloud-publish.mjs) cp "$TEST_PUBLISH_SOURCE" "$output" ;;
  *) exit 90 ;;
esac
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
      TEST_MANIFEST_SOURCE: manifest,
      TEST_CHECK_SOURCE: repositoryCheck,
      TEST_PUBLISH_SOURCE: publisher,
    },
  });

  assert.equal(await readFile(invocation, "utf8"), "owner/repo");
  const urls = await readFile(requestedUrl, "utf8");
  assert.match(urls, new RegExp(`${ref}/\\.github/agent-pipeline/runtime-manifest\\.json`));
  assert.match(urls, new RegExp(`${ref}/\\.github/agent-pipeline/cloud-github-setup\\.sh`));
  const installed = join(home, ".local/bin/prarness-github-setup");
  assert.equal((await stat(installed)).mode & 0o777, 0o700);
  assert.equal((await stat(join(home, ".local/bin/prarness-repository-check"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(home, ".local/bin/prarness-publish"))).mode & 0o777, 0o700);
});

test("Cloud environment bootstrap rejects mutable or abbreviated refs", async () => {
  await assert.rejects(
    exec("bash", [installer], { env: { ...process.env, PRARNESS_BOOTSTRAP_REF: "main" } }),
    (error) => error.code === 2 && /40-character commit SHA/.test(error.stderr),
  );
});

test("committed runtime manifest covers required commands and has exact hashes", async () => {
  const manifest = JSON.parse(await readFile(join(pipelineRoot, "runtime-manifest.json"), "utf8"));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.runtime_contract, 1);
  const entries = new Map(manifest.files.map((entry) => [entry.path, entry]));
  for (const required of ["cloud-github-setup.sh", "repository-check.mjs", "cloud-publish.mjs", "pipeline.mjs"]) {
    assert.equal(entries.has(required), true, `missing runtime entry: ${required}`);
  }
  for (const [relativePath, entry] of entries) {
    assert.match(relativePath, /^[A-Za-z0-9._/-]+$/);
    assert.equal(relativePath.includes(".."), false);
    const contents = await readFile(join(pipelineRoot, relativePath));
    assert.equal(createHash("sha256").update(contents).digest("hex"), entry.sha256, relativePath);
  }
});
