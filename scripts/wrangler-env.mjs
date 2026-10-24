// node scripts/wrangler-env.mjs <wrangler args…>   (used by npm run deploy and npm run backup)
// Runs wrangler with the Cloudflare token and account saved by npm run setup; output goes straight to the terminal.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { backupArgs, cfEnv } from "./lib/cf-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let args = process.argv.slice(2);
if (args[0] === "--backup") {
  mkdirSync(join(root, "backups"), { recursive: true });
  args = backupArgs(root);
}
let env;
try {
  env = cfEnv(root);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const quoted = args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
const r = spawnSync("npx", ["wrangler", ...quoted], { cwd: root, stdio: "inherit", shell: true, env: { ...process.env, ...env } });
if (args[0] === "d1" && args[1] === "export" && r.status === 0) console.log(`Backup written to ${args[5]} (keep it private; backups/ is not committed).`);
process.exit(r.status ?? 1);
