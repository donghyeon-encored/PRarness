import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const setup = fileURLToPath(new URL("../cloud-github-setup.sh", import.meta.url));

test("Cloud setup adds origin and persists gh authentication without an interactive login", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-github-setup-"));
  const home = join(directory, "home");
  const bin = join(directory, "bin");
  const repo = join(directory, "repo");
  await mkdir(home); await mkdir(bin); await mkdir(repo);
  await exec("git", ["init", "-q"], { cwd: repo });
  const realGit = (await exec("which", ["git"])).stdout.trim();

  await writeFile(join(bin, "git"), `#!/usr/bin/env bash
if [[ $1 == ls-remote ]]; then exit 0; fi
exec ${JSON.stringify(realGit)} "$@"
`);
  await writeFile(join(bin, "gh"), `#!/usr/bin/env bash
if [[ $1 == api ]]; then printf '%s\\n' 'owner/repo'; exit 0; fi
if [[ $1 == repo && $2 == set-default ]]; then exit 0; fi
if [[ $1 == auth && $2 == git-credential ]]; then exit 0; fi
exit 7
`);
  await chmod(join(bin, "git"), 0o755); await chmod(join(bin, "gh"), 0o755);

  const result = await exec("bash", [setup, "owner/repo"], {
    cwd: repo,
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, CODEX_GITHUB_TOKEN: "github_pat_test_token" },
  });
  assert.match(result.stdout, /GitHub access ready/);
  assert.equal((await exec(realGit, ["remote", "get-url", "origin"], { cwd: repo })).stdout.trim(), "https://github.com/owner/repo.git");
  const hosts = await readFile(join(home, ".config/gh/hosts.yml"), "utf8");
  assert.match(hosts, /oauth_token: github_pat_test_token/);

  await exec("bash", [setup, "--verify", "owner/repo"], {
    cwd: repo,
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });
});
