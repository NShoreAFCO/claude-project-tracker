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
  assert.throws(() => cfEnv(root(false)), /npm run setup/);
});

test("backupArgs exports the configured database into backups/", () => {
  const args = backupArgs(root(), new Date("2026-10-24T09:05:00Z"));
  assert.deepEqual(args.slice(0, 4), ["d1", "export", "pt-db", "--remote"]);
  assert.equal(args[4], "--output");
  assert.match(args[5].replaceAll("\\", "/"), /backups\/pt-db-2026-10-24-0905\.sql$/);
});
