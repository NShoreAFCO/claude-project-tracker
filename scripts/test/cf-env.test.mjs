import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfEnv, backupArgs } from "../lib/cf-env.mjs";
import { writeSecrets } from "../lib/secrets.mjs";

function root(withSecrets = true) {
  const r = mkdtempSync(join(tmpdir(), "cfenv-"));
  mkdirSync(join(r, "instance"));
  writeFileSync(join(r, "instance", "instance.config.json"), JSON.stringify({ deploy: { accountId: "acc1", d1: { name: "pt-db" } } }));
  if (withSecrets) writeSecrets(r, { CLOUDFLARE_API_TOKEN: "tok-123456789" });
  return r;
}

test("cfEnv reads token and account from secrets and config", () => {
  assert.deepEqual(cfEnv(root()), { CLOUDFLARE_API_TOKEN: "tok-123456789", CLOUDFLARE_ACCOUNT_ID: "acc1" });
});

test("cfEnv without a saved token says to run setup", () => {
  // No real wrangler runs: the login check is mocked as "not logged in".
  const spawn = () => ({ status: 0, stdout: "You are not authenticated.", stderr: "" });
  assert.throws(() => cfEnv(root(false), { spawn }), /npm run setup/);
});

test("backupArgs exports the configured database into backups/", () => {
  const args = backupArgs(root(), new Date("2026-10-24T09:05:00Z"));
  assert.deepEqual(args.slice(0, 4), ["d1", "export", "pt-db", "--remote"]);
  assert.equal(args[4], "--output");
  assert.match(args[5].replaceAll("\\", "/"), /backups\/pt-db-2026-10-24-0905\.sql$/);
});

// F12 / R5.2: no saved token → wrangler's own login, with the account from the instance config.
// The file check and the spawn are mocked: no token file is opened and no real wrangler runs.
const noTokenFile = () => false;
const whoami = (stdout, status = 0) => {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status, stdout, stderr: "" };
  };
  return { spawn, calls };
};

test("cf-env falls back to wrangler login when no token file", () => {
  const { spawn, calls } = whoami("You are logged in with an OAuth Token, associated with the email user@example.com.");
  const env = cfEnv(root(false), { exists: noTokenFile, spawn });
  assert.deepEqual(env, { CLOUDFLARE_ACCOUNT_ID: "acc1" });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("whoami"));
  assert.equal(calls[0].opts.env.CLOUDFLARE_API_TOKEN, undefined);
});

test("cf-env without token file and without wrangler login keeps the setup message", () => {
  const { spawn } = whoami("You are not authenticated. Please run `wrangler login`.");
  assert.throws(() => cfEnv(root(false), { exists: noTokenFile, spawn }), {
    message: "No saved Cloudflare API token or account yet. Run npm run setup first.",
  });
  const failed = whoami("", 1);
  assert.throws(() => cfEnv(root(false), { exists: noTokenFile, spawn: failed.spawn }), /npm run setup first/);
});

test("cf-env with a saved token never asks wrangler", () => {
  const { spawn, calls } = whoami("logged in");
  assert.deepEqual(cfEnv(root(), { spawn }), { CLOUDFLARE_API_TOKEN: "tok-123456789", CLOUDFLARE_ACCOUNT_ID: "acc1" });
  assert.equal(calls.length, 0);
});
