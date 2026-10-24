// Local secret store: secrets/instance.secrets.json (gitignored; AI assistants never read this folder).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const secretsFile = (root) => join(root, "secrets", "instance.secrets.json");

export function readSecrets(root) {
  const f = secretsFile(root);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
}

/** Merge values into the store; the file is readable by the current user only where the OS supports it. */
export function writeSecrets(root, patch) {
  const f = secretsFile(root);
  mkdirSync(join(root, "secrets"), { recursive: true });
  const next = { ...readSecrets(root), ...patch };
  writeFileSync(f, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(f, 0o600);
  } catch {
    /* Windows: ACLs of the user profile apply */
  }
  return next;
}

/** Replace every secret value in text with [hidden]. */
export function scrubber(secrets) {
  const values = Object.values(secrets).filter((v) => typeof v === "string" && v.length >= 8 && !v.startsWith("https://"));
  return (text) => values.reduce((t, v) => t.split(v).join("[hidden]"), String(text ?? ""));
}

/** Store Worker secrets with `wrangler secret put NAME`; the value goes through stdin, never the command line. */
export async function putWorkerSecrets(names, { secrets, wrangler }) {
  const scrub = scrubber(secrets);
  for (const name of names) {
    const value = secrets[name];
    if (!value) throw new Error(`Secret ${name} is missing from secrets/instance.secrets.json.`);
    const r = await wrangler(["secret", "put", name], { input: value });
    if (r.code !== 0) throw new Error(`Could not store ${name} in Cloudflare: ${scrub(r.stderr || r.stdout).slice(-400)}`);
  }
}
