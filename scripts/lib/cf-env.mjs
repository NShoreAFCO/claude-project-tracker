// Cloudflare credentials for wrangler, taken from secrets/ and the instance config (so no `wrangler login` is needed).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readSecrets } from "./secrets.mjs";

const deployOf = (root) => JSON.parse(readFileSync(join(root, "instance", "instance.config.json"), "utf8")).deploy ?? {};

export function cfEnv(root) {
  const token = readSecrets(root).CLOUDFLARE_API_TOKEN;
  const accountId = deployOf(root).accountId;
  if (!token || !accountId) throw new Error("No saved Cloudflare API token or account yet. Run npm run setup first.");
  return { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId };
}

/** wrangler arguments that export the remote database to backups/<db>-YYYY-MM-DD-HHMM.sql (UTC). */
export function backupArgs(root, now = new Date()) {
  const db = deployOf(root).d1?.name;
  const stamp = now.toISOString().slice(0, 16).replace("T", "-").replace(":", "");
  return ["d1", "export", db, "--remote", "--output", join(root, "backups", `${db}-${stamp}.sql`)];
}
