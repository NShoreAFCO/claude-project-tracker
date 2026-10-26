// Cloudflare credentials for wrangler, taken from secrets/ and the instance config (so no `wrangler login` is needed).
// Without a saved token, wrangler's own login (`wrangler login`) is used, with the account from the instance config.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readSecrets, secretsFile } from "./secrets.mjs";
import { wranglerBin } from "./wrangler.mjs";

const deployOf = (root) => JSON.parse(readFileSync(join(root, "instance", "instance.config.json"), "utf8")).deploy ?? {};

export const NO_CREDENTIALS = "No saved Cloudflare API token or account yet. Run npm run setup first.";

/** Whether wrangler has its own login (`wrangler whoami`); a failed or unauthenticated run counts as no. */
export function wranglerLoggedIn(root, { spawn = spawnSync } = {}) {
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };
  delete env.CLOUDFLARE_API_TOKEN;
  const r = spawn(process.execPath, [wranglerBin(root), "whoami"], { cwd: root, encoding: "utf8", env });
  if (!r || r.error || r.status !== 0) return false;
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  return !/not authenticated|not logged in/i.test(out) && /logged in/i.test(out);
}

/**
 * Environment for wrangler: the saved token and account, or (no saved token) only the account, so wrangler
 * uses its own login. `exists` and `spawn` are seams for tests. Throws NO_CREDENTIALS when neither is there.
 */
export function cfEnv(root, { exists = existsSync, spawn = spawnSync } = {}) {
  const accountId = deployOf(root).accountId;
  const token = exists(secretsFile(root)) ? readSecrets(root).CLOUDFLARE_API_TOKEN : undefined;
  if (token && accountId) return { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId };
  if (!token && accountId && wranglerLoggedIn(root, { spawn })) return { CLOUDFLARE_ACCOUNT_ID: accountId };
  throw new Error(NO_CREDENTIALS);
}

/** wrangler arguments that export the remote database to backups/<db>-YYYY-MM-DD-HHMM.sql (UTC). */
export function backupArgs(root, now = new Date()) {
  const db = deployOf(root).d1?.name;
  const stamp = now.toISOString().slice(0, 16).replace("T", "-").replace(":", "");
  return ["d1", "export", db, "--remote", "--output", join(root, "backups", `${db}-${stamp}.sql`)];
}
