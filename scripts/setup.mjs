// npm run setup [-- --prefix <name>]
// Interactive: run it yourself in a terminal. It asks for the Cloudflare API token with hidden input
// and keeps every secret in secrets/ (never printed). Safe to run again after a failure.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { terminalIo } from "./lib/prompt.mjs";
import { runSetup } from "./lib/setup-steps.mjs";
import { wranglerRunner } from "./lib/wrangler.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const i = args.indexOf("--prefix");
const prefix = i >= 0 ? args[i + 1] : undefined;

const gh = async (a) => {
  const r = spawnSync("gh", a, { encoding: "utf8", shell: process.platform === "win32" });
  return { code: r.status ?? 1, stdout: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

if (!process.stdin.isTTY) {
  console.error(
    "npm run setup is interactive. Run it yourself in a terminal window (in Claude Code: type  ! npm run setup  or use a separate terminal).",
  );
  process.exit(1);
}

const result = await runSetup({ root, prefix, io: terminalIo, wrangler: wranglerRunner(root), gh, log: (l) => console.log(l) });
process.exit(result.ok ? 0 : 1);
