// node scripts/add-webhook.mjs "<owner>/<repository>"
// Registers the tracker's GitHub webhook on one repository. The webhook secret is read from secrets/ and
// handed to the GitHub CLI through stdin, so it never appears on screen or in the shell history.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSecrets, scrubber } from "./lib/secrets.mjs";

export const WEBHOOK_EVENTS = ["push", "create", "delete", "pull_request", "fork"];

/** gh(args, stdinText) → { code, stdout } */
export async function addWebhook({ repo, publicUrl, secret, gh, log }) {
  const scrub = scrubber({ secret });
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo ?? "")) {
    log(`"${repo}" is not a repository name. Use owner/name, for example my-org/my-repo.`);
    return { ok: false };
  }
  const body = {
    name: "web",
    active: true,
    events: WEBHOOK_EVENTS,
    config: { url: `${publicUrl}/webhooks/github`, content_type: "json", secret, insecure_ssl: "0" },
  };
  const r = await gh(["api", `repos/${repo}/hooks`, "--method", "POST", "--input", "-"], JSON.stringify(body));
  if (r.code !== 0) {
    log(`✗ GitHub did not add the webhook to ${repo}. You need admin rights on the repository, and gh must be logged in (gh auth status).`);
    log(`  GitHub said: ${scrub(r.stdout).slice(-300)}`);
    return { ok: false };
  }
  log(`✓ webhook added to ${repo} → ${publicUrl}/webhooks/github`);
  log("  Also set this repository's URL on its tracker project, so events land on the right project.");
  return { ok: true };
}

const ghRunner = (args, input) =>
  new Promise((res) => {
    const child = spawn("gh", args);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => res({ code: code ?? 1, stdout: out }));
    child.on("error", (e) => res({ code: 1, stdout: e.message }));
    child.stdin.end(input);
  });

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { publicUrl } = JSON.parse(readFileSync(join(root, "instance", "instance.config.json"), "utf8")).deploy;
  const secret = readSecrets(root).GITHUB_WEBHOOK_SECRET;
  if (!publicUrl || !secret) {
    console.error("Run npm run setup first (no tracker address or webhook secret yet).");
    process.exit(1);
  }
  const r = await addWebhook({ repo: process.argv[2], publicUrl, secret, gh: ghRunner, log: (l) => console.log(l) });
  process.exit(r.ok ? 0 : 1);
}
