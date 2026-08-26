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

async function harness(repository, origin = null) {
  const directory = await mkdtemp(join(tmpdir(), "cloud-github-setup-"));
  const home = join(directory, "home");
  const bin = join(directory, "bin");
  const repo = join(directory, "repo");
  await mkdir(home); await mkdir(bin); await mkdir(repo);
  await exec("git", ["init", "-q"], { cwd: repo });
  const realGit = (await exec("which", ["git"])).stdout.trim();
  if (origin) await exec(realGit, ["remote", "add", "origin", origin], { cwd: repo });

  await writeFile(join(bin, "git"), `#!/usr/bin/env bash
if [[ $1 == ls-remote ]]; then exit 0; fi
exec ${JSON.stringify(realGit)} "$@"
`);
  await writeFile(join(bin, "gh"), `#!/usr/bin/env bash
if [[ $1 == api ]]; then printf '%s\\n' "$TEST_REPOSITORY"; exit 0; fi
if [[ $1 == repo && $2 == set-default ]]; then exit 0; fi
if [[ $1 == auth && $2 == git-credential ]]; then exit 0; fi
exit 7
`);
  await chmod(join(bin, "git"), 0o755); await chmod(join(bin, "gh"), 0o755);
  return {
    home, repo, realGit,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      CODEX_GITHUB_TOKEN: "github_pat_test_token",
      TEST_REPOSITORY: repository,
    },
  };
}

async function assertConfigured(context, repository) {
  const origin = await exec(context.realGit, ["remote", "get-url", "origin"], { cwd: context.repo });
  assert.equal(origin.stdout.trim(), `https://github.com/${repository}.git`);
  const hosts = await readFile(join(context.home, ".config/gh/hosts.yml"), "utf8");
  assert.match(hosts, /oauth_token: github_pat_test_token/);
}

test("Cloud setup accepts an explicit repository and persists non-interactive gh authentication", async () => {
  const context = await harness("owner/repo");
  const result = await exec("bash", [setup, "owner/repo"], { cwd: context.repo, env: context.env });
  assert.match(result.stdout, /GitHub access ready/);
  await assertConfigured(context, "owner/repo");
  await exec("bash", [setup, "--verify", "owner/repo"], { cwd: context.repo, env: context.env });
});

test("Cloud setup detects the repository from the environment without an argument", async () => {
  const context = await harness("another/project");
  context.env.CODEX_GITHUB_REPOSITORY = "another/project";
  await exec("bash", [setup], { cwd: context.repo, env: context.env });
  await assertConfigured(context, "another/project");
});

test("Cloud setup detects and normalizes an existing GitHub origin", async () => {
  const context = await harness("ssh-owner/ssh-repo", "git@github.com:ssh-owner/ssh-repo.git");
  await exec("bash", [setup], { cwd: context.repo, env: context.env });
  await assertConfigured(context, "ssh-owner/ssh-repo");
});

test("Cloud setup fails closed when no repository identity is available", async () => {
  const context = await harness("unused/repo");
  await assert.rejects(
    exec("bash", [setup], { cwd: context.repo, env: context.env }),
    (error) => error.code === 2 && /Set CODEX_GITHUB_REPOSITORY/.test(error.stderr),
  );
});
