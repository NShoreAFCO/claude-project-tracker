import { test } from "node:test";
import assert from "node:assert/strict";
import { addWebhook } from "../add-webhook.mjs";

const SECRET = "webhook-secret-abcdef123456";

test("addWebhook sends the secret through stdin only", async () => {
  const calls = [];
  const lines = [];
  const r = await addWebhook({
    repo: "example-org/web-app",
    publicUrl: "https://t.example.workers.dev",
    secret: SECRET,
    gh: async (args, input) => (calls.push({ args, input }), { code: 0, stdout: '{"id":1}' }),
    log: (l) => lines.push(l),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0].args, ["api", "repos/example-org/web-app/hooks", "--method", "POST", "--input", "-"]);
  const body = JSON.parse(calls[0].input);
  assert.deepEqual(body.events.sort(), ["create", "delete", "fork", "pull_request", "push"]);
  assert.deepEqual(body.config, { url: "https://t.example.workers.dev/webhooks/github", content_type: "json", secret: SECRET, insecure_ssl: "0" });
  assert.ok(!calls[0].args.join(" ").includes(SECRET));
  assert.ok(!lines.join("\n").includes(SECRET));
});

test("addWebhook rejects a malformed repository name", async () => {
  const r = await addWebhook({ repo: "not a repo", publicUrl: "https://t.example", secret: SECRET, gh: async () => ({ code: 0 }), log: () => {} });
  assert.equal(r.ok, false);
});

test("addWebhook explains a gh failure without the secret", async () => {
  const lines = [];
  const r = await addWebhook({
    repo: "example-org/web-app",
    publicUrl: "https://t.example.workers.dev",
    secret: SECRET,
    gh: async () => ({ code: 1, stdout: `HTTP 404 ${SECRET}` }),
    log: (l) => lines.push(l),
  });
  assert.equal(r.ok, false);
  assert.match(lines.join("\n"), /admin/i);
  assert.ok(!lines.join("\n").includes(SECRET));
});
