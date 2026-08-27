import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  drainWebhookSpool,
  normalizeWebhookDelivery,
  spoolWebhookJob,
  verifyWebhookSignature,
} from "../github-app-controller.mjs";

test("GitHub webhook signatures use the raw body and reject tampering", () => {
  const secret = "s".repeat(32);
  const body = Buffer.from('{"zen":"safe"}');
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.equal(verifyWebhookSignature(secret, body, signature), true);
  assert.throws(() => verifyWebhookSignature(secret, Buffer.from('{"zen":"changed"}'), signature), (error) => error.code === "INVALID_WEBHOOK_SIGNATURE");
});

test("managed PR and canonical comment events normalize into reconcile jobs", () => {
  const common = { repository: { full_name: "owner/repo" }, installation: { id: 123 }, action: "synchronize" };
  const pull = normalizeWebhookDelivery("pull_request", "delivery-12345678", {
    ...common,
    pull_request: { number: 7, head: { ref: "agent/issue-4-fix", sha: "a".repeat(40), repo: { full_name: "owner/repo" } } },
  });
  assert.equal(pull.issue, 4);
  assert.equal(pull.stage, "review");
  assert.equal(pull.dispatchable, false);
  const comment = normalizeWebhookDelivery("issue_comment", "delivery-abcdefgh", {
    ...common,
    action: "created",
    issue: { number: 4 },
    comment: { id: 9, body: "done\n\n<!-- prarness-operation:v1 request_id=request-12345678 -->", performed_via_github_app: { id: 42 } },
  });
  assert.equal(comment.request_id, "request-12345678");
  assert.equal(comment.operation, "reconcile");
  assert.equal(comment.dispatchable, true);
  assert.equal(normalizeWebhookDelivery("issue_comment", "delivery-prcomment", {
    ...common,
    action: "created",
    issue: { number: 7, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/7" } },
    comment: { id: 10, body: "/agent resume" },
  }), null);
});

test("webhook spool is idempotent and dispatches each delivery once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prarness-webhook-spool-"));
  const output = join(directory, "dispatched.txt");
  const dispatcher = join(directory, "dispatcher.sh");
  await writeFile(dispatcher, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1" >> ${JSON.stringify(output)}
`);
  await chmod(dispatcher, 0o700);
  const job = {
    version: 1,
    delivery_id: "delivery-12345678",
    request_id: "gh-delivery-12345678",
    repository: "owner/repo",
    installation_id: 123,
    operation: "dispatch",
    stage: "triage",
    issue: 1,
  };
  assert.equal(spoolWebhookJob(directory, job).duplicate, false);
  assert.equal(spoolWebhookJob(directory, job).duplicate, true);
  const results = await drainWebhookSpool(directory, dispatcher);
  assert.deepEqual(results.map((entry) => entry.status), ["completed"]);
  assert.equal((await readFile(output, "utf8")).trim().split("\n").length, 1);
  assert.deepEqual(await drainWebhookSpool(directory, dispatcher), []);
});

test("only an explicitly transient dispatcher failure is retried", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prarness-webhook-retry-"));
  const retryDispatcher = join(directory, "retry.sh");
  const successDispatcher = join(directory, "success.sh");
  await writeFile(retryDispatcher, "#!/usr/bin/env bash\nexit 75\n");
  await writeFile(successDispatcher, "#!/usr/bin/env bash\nexit 0\n");
  await chmod(retryDispatcher, 0o700);
  await chmod(successDispatcher, 0o700);
  spoolWebhookJob(directory, {
    version: 1,
    delivery_id: "delivery-retry123",
    request_id: "gh-delivery-retry123",
    repository: "owner/repo",
    installation_id: 123,
    operation: "dispatch",
    stage: "triage",
    issue: 1,
  });
  const retry = await drainWebhookSpool(directory, retryDispatcher);
  assert.equal(retry[0].status, "retrying");
  assert.equal(retry[0].attempts, 1);
  const completed = await drainWebhookSpool(directory, successDispatcher);
  assert.equal(completed[0].status, "completed");
});
