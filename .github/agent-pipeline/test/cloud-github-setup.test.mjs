import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  await writeFile(join(repo, "fixture.txt"), `${repository}\n`);
  await exec(realGit, ["add", "fixture.txt"], { cwd: repo });
  await exec(realGit, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], { cwd: repo });
  const head = (await exec(realGit, ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  if (origin) await exec(realGit, ["remote", "add", "origin", origin], { cwd: repo });

  await writeFile(join(bin, "git"), `#!/usr/bin/env bash
if [[ $1 == ls-remote ]]; then exit 0; fi
exec ${JSON.stringify(realGit)} "$@"
`);
  await writeFile(join(bin, "gh"), `#!/usr/bin/env bash
if [[ $1 == api ]]; then
  [[ -f "$HOME/.config/gh/hosts.yml" ]] || exit 1
  if [[ $* == *'.permissions.push == true'* ]]; then
    printf '%s\\n' "\${TEST_PUSH_PERMISSION:-true}"
  else
    printf '%s\\n' "$TEST_REPOSITORY"
  fi
  exit 0
fi
if [[ $1 == repo && $2 == set-default ]]; then
  printf '%s\\n' 'HTTP 401: Requires authentication (https://api.github.com/graphql)' >&2
  exit 1
fi
if [[ $1 == auth && $2 == git-credential ]]; then
  [[ \${TEST_GIT_CREDENTIAL_COMPLETE:-true} == true ]] || exit 0
  printf '%s\\n' 'protocol=https' 'host=github.com' 'username=x-access-token' 'password=test-credential'
  exit 0
fi
exit 7
`);
  await chmod(join(bin, "git"), 0o755); await chmod(join(bin, "gh"), 0o755);
  return {
    bin, head, home, repo, realGit,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      CODEX_GITHUB_TOKEN: "github_pat_test_token",
      TEST_REPOSITORY: repository,
    },
  };
}

async function installFakeCurl(context) {
  await writeFile(join(context.bin, "curl"), `#!/usr/bin/env bash
url=\${!#}
if [[ -n \${TEST_CURL_LOG:-} ]]; then
  printf '%s\\n' "$url" >> "$TEST_CURL_LOG"
fi
if [[ $url == *"/app/installations?per_page="* ]]; then
  printf '%s' "\${TEST_INSTALLATIONS_JSON}"
  exit 0
fi
if [[ $url == *"/installation/repositories?per_page="* ]]; then
  printf '%s' "\${TEST_INSTALLATION_REPOSITORIES_JSON}"
  exit 0
fi
if [[ $url == *"/user/repos?affiliation="* ]]; then
  printf '%s' "\${TEST_TOKEN_REPOSITORIES_JSON}"
  exit 0
fi
if [[ $url == */git/commits/\${TEST_HEAD} ]]; then
  candidate=\${url#*/repos/}
  candidate=\${candidate%/git/commits/*}
  while IFS= read -r match; do
    [[ -n $match && $candidate == "$match" ]] && exit 0
  done <<< "\${TEST_MATCH_REPOSITORIES:-}"
  exit 22
fi
if [[ $url == */installation ]]; then
  printf '%s' '{"id":123}'
  exit 0
fi
if [[ $url == */app/installations/*/access_tokens ]]; then
  if [[ $* == *'contents":"write'* ]]; then
    printf '%s' '{"token":"github_app_write_token","expires_at":"2099-01-01T00:00:00Z"}'
  else
    printf '%s' '{"token":"github_app_discovery_token","expires_at":"2099-01-01T00:00:00Z"}'
  fi
  exit 0
fi
printf 'Unexpected curl request: %s\n' "$url" >&2
exit 90
`);
  await chmod(join(context.bin, "curl"), 0o755);
}

function appPrivateKey() {
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    format: "pem",
    type: "pkcs8",
  });
}

async function assertConfigured(context, repository, token = "github_pat_test_token") {
  const origin = await exec(context.realGit, ["remote", "get-url", "origin"], { cwd: context.repo });
  assert.equal(origin.stdout.trim(), `https://github.com/${repository}.git`);
  const resolution = await exec(context.realGit, ["config", "--local", "--get-regexp", "^remote\\..*\\.gh-resolved$"], { cwd: context.repo });
  assert.equal(resolution.stdout.trim(), "remote.origin.gh-resolved base");
  const hosts = await readFile(join(context.home, ".config/gh/hosts.yml"), "utf8");
  assert.match(hosts, new RegExp(`oauth_token: ${token}`));
  const metadata = JSON.parse(await readFile(join(context.home, ".config/gh/prarness-auth.json"), "utf8"));
  assert.equal(metadata.repository, repository);
}

test("Cloud setup accepts an explicit repository and persists non-interactive gh authentication", async () => {
  const context = await harness("owner/repo");
  const result = await exec("bash", [setup, "owner/repo"], { cwd: context.repo, env: context.env });
  assert.match(result.stdout, /GitHub write access ready/);
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

test("Cloud setup discovers a remote-less checkout from token-accessible repositories", async () => {
  const context = await harness("owner/target");
  await installFakeCurl(context);
  context.env.TEST_HEAD = context.head;
  context.env.TEST_TOKEN_REPOSITORIES_JSON = JSON.stringify([
    { full_name: "owner/unrelated" },
    { full_name: "owner/target" },
  ]);
  context.env.TEST_MATCH_REPOSITORIES = "owner/target";
  await exec("bash", [setup], { cwd: context.repo, env: context.env });
  await assertConfigured(context, "owner/target");
});

test("Cloud setup discovers a remote-less checkout from GitHub App installations", async () => {
  const context = await harness("owner/target");
  await installFakeCurl(context);
  delete context.env.CODEX_GITHUB_TOKEN;
  context.env.AGENT_APP_ID = "42";
  context.env.AGENT_APP_PRIVATE_KEY = appPrivateKey();
  context.env.TEST_HEAD = context.head;
  context.env.TEST_INSTALLATIONS_JSON = JSON.stringify([{ id: 123 }]);
  context.env.TEST_INSTALLATION_REPOSITORIES_JSON = JSON.stringify({ repositories: [
    { full_name: "owner/unrelated" },
    { full_name: "owner/target" },
  ] });
  context.env.TEST_MATCH_REPOSITORIES = "owner/target";
  await exec("bash", [setup], { cwd: context.repo, env: context.env });
  await assertConfigured(context, "owner/target", "github_app_write_token");
});

test("Cloud setup normalizes a quoted GitHub App PEM with escaped newlines", async () => {
  const context = await harness("owner/target");
  await installFakeCurl(context);
  delete context.env.CODEX_GITHUB_TOKEN;
  context.env.AGENT_APP_ID = "42";
  context.env.AGENT_APP_PRIVATE_KEY = `"${appPrivateKey().replaceAll("\n", "\\n")}"`;
  context.env.TEST_HEAD = context.head;
  context.env.TEST_INSTALLATIONS_JSON = JSON.stringify([{ id: 123 }]);
  context.env.TEST_INSTALLATION_REPOSITORIES_JSON = JSON.stringify({ repositories: [
    { full_name: "owner/target" },
  ] });
  context.env.TEST_MATCH_REPOSITORIES = "owner/target";
  await exec("bash", [setup], { cwd: context.repo, env: context.env });
  await assertConfigured(context, "owner/target", "github_app_write_token");
});

test("Cloud setup accepts an explicitly base64-encoded GitHub App PEM", async () => {
  const context = await harness("owner/target");
  await installFakeCurl(context);
  delete context.env.CODEX_GITHUB_TOKEN;
  context.env.AGENT_APP_ID = "42";
  context.env.AGENT_APP_PRIVATE_KEY = `base64:${Buffer.from(appPrivateKey()).toString("base64")}`;
  context.env.TEST_HEAD = context.head;
  context.env.TEST_INSTALLATIONS_JSON = JSON.stringify([{ id: 123 }]);
  context.env.TEST_INSTALLATION_REPOSITORIES_JSON = JSON.stringify({ repositories: [
    { full_name: "owner/target" },
  ] });
  context.env.TEST_MATCH_REPOSITORIES = "owner/target";
  await exec("bash", [setup], { cwd: context.repo, env: context.env });
  await assertConfigured(context, "owner/target", "github_app_write_token");
});

test("Cloud setup rejects an invalid GitHub App private key before any API request", async () => {
  const context = await harness("owner/target");
  await installFakeCurl(context);
  delete context.env.CODEX_GITHUB_TOKEN;
  context.env.AGENT_APP_ID = "42";
  context.env.AGENT_APP_PRIVATE_KEY = "definitely-not-a-private-key";
  context.env.TEST_CURL_LOG = join(context.repo, "curl.log");
  await assert.rejects(
    exec("bash", [setup], { cwd: context.repo, env: context.env }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /not a valid RSA PEM private key/);
      assert.doesNotMatch(error.stderr, /definitely-not-a-private-key|401|Could not read private key/);
      return true;
    },
  );
  await assert.rejects(access(context.env.TEST_CURL_LOG), (error) => error.code === "ENOENT");
});

test("Cloud setup fails closed when multiple App repositories contain the checkout HEAD", async () => {
  const context = await harness("owner/target");
  await installFakeCurl(context);
  delete context.env.CODEX_GITHUB_TOKEN;
  context.env.AGENT_APP_ID = "42";
  context.env.AGENT_APP_PRIVATE_KEY = appPrivateKey();
  context.env.TEST_HEAD = context.head;
  context.env.TEST_INSTALLATIONS_JSON = JSON.stringify([{ id: 123 }]);
  context.env.TEST_INSTALLATION_REPOSITORIES_JSON = JSON.stringify({ repositories: [
    { full_name: "owner/target" },
    { full_name: "fork/target" },
  ] });
  context.env.TEST_MATCH_REPOSITORIES = "owner/target\nfork/target";
  await assert.rejects(
    exec("bash", [setup], { cwd: context.repo, env: context.env }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /multiple repositories containing the checkout HEAD/);
      assert.doesNotMatch(error.stderr, /owner\/target|fork\/target/);
      return true;
    },
  );
});

test("Cloud setup fails closed when no repository identity is available", async () => {
  const context = await harness("unused/repo");
  delete context.env.CODEX_GITHUB_TOKEN;
  await assert.rejects(
    exec("bash", [setup], { cwd: context.repo, env: context.env }),
    (error) => error.code === 2 && /Unable to identify the Cloud checkout/.test(error.stderr),
  );
});

test("Cloud write verification rejects a credential helper that supplies no password", async () => {
  const context = await harness("owner/repo");
  context.env.TEST_GIT_CREDENTIAL_COMPLETE = "false";
  await assert.rejects(
    exec("bash", [setup, "owner/repo"], { cwd: context.repo, env: context.env }),
    (error) => error.code === 2 && /(?:could not provide|incomplete) GitHub HTTPS credentials/.test(error.stderr),
  );
});

test("Cloud write verification rejects repository read access without push permission", async () => {
  const context = await harness("owner/repo");
  context.env.TEST_PUSH_PERMISSION = "false";
  await assert.rejects(
    exec("bash", [setup, "owner/repo"], { cwd: context.repo, env: context.env }),
    (error) => error.code === 2 && /does not have repository push permission/.test(error.stderr),
  );
});
