// npm run secrets:rotate — new COOKIE_ENCRYPTION_KEY and GITHUB_WEBHOOK_SECRET, stored locally and in Cloudflare.
// Afterwards every GitHub webhook needs the new secret (docs/INSTALL.md, "GitHub webhooks"); MCP clients sign in again.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { putWorkerSecrets, readSecrets, writeSecrets } from "./lib/secrets.mjs";
import { wranglerRunner } from "./lib/wrangler.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const d = JSON.parse(readFileSync(join(root, "instance", "instance.config.json"), "utf8")).deploy;
const old = readSecrets(root);
if (!old.CLOUDFLARE_API_TOKEN) {
  console.error("No Cloudflare API token in secrets/. Run npm run setup first.");
  process.exit(1);
}
const secrets = writeSecrets(root, {
  COOKIE_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  GITHUB_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
});
const run = wranglerRunner(root);
const wrangler = (args, opts = {}) =>
  run(args, { ...opts, env: { CLOUDFLARE_API_TOKEN: secrets.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: d.accountId } });
try {
  await putWorkerSecrets(["COOKIE_ENCRYPTION_KEY", "GITHUB_WEBHOOK_SECRET"], { secrets, wrangler });
  console.log("✓ New secrets are stored locally (secrets/) and in Cloudflare.");
  console.log(
    "  Next: update the secret of each GitHub webhook (docs/INSTALL.md, 'GitHub webhooks'); people using claude.ai sign in again.",
  );
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
