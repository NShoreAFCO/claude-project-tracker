// npm run setup:check — non-interactive status report: which setup parts are done and whether the deployed
// tracker is protected. Prints names and pass/fail only, never secret values; an AI assistant may run it.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAccessChecks } from "./lib/access-checks.mjs";
import { readSecrets } from "./lib/secrets.mjs";
import { WORKER_SECRETS } from "./lib/setup-steps.mjs";

/** @returns {Promise<Array<{ name: string, ok: boolean, detail: string }>>} */
export async function runSetupCheck({ root, fetch: doFetch, retries = 0 }) {
  const out = [];
  const add = (name, ok, detail = "") => out.push({ name, ok, detail });
  const cfgFile = join(root, "instance", "instance.config.json");
  add("instance/instance.config.json exists", existsSync(cfgFile), "run npm run setup");
  if (!existsSync(cfgFile)) return out;
  const d = JSON.parse(readFileSync(cfgFile, "utf8")).deploy ?? {};
  for (const [k, v] of Object.entries({
    accountId: d.accountId,
    publicUrl: d.publicUrl,
    accessTeamDomain: d.accessTeamDomain,
    accessAud: d.accessAud,
    allowedEmails: d.allowedEmails?.length,
    allowedServiceTokenIds: d.allowedServiceTokenIds?.length,
    "d1.id": d.d1?.id,
    "kv.id": d.kv?.id,
  }))
    add(`config deploy.${k} is set`, !!v, "run npm run setup");
  const s = readSecrets(root);
  for (const k of ["CLOUDFLARE_API_TOKEN", ...WORKER_SECRETS, "HOOK_CLIENT_ID", "HOOK_CLIENT_SECRET"])
    add(`secret ${k} is saved`, !!s[k], "run npm run setup");
  if (d.auditRepo) add("secret AUDIT_GITHUB_TOKEN is saved (audit log)", !!s.AUDIT_GITHUB_TOKEN, "run npm run setup");
  if (d.publicUrl) for (const r of await runAccessChecks({ publicUrl: d.publicUrl, fetch: doFetch, retries })) out.push(r);
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const results = await runSetupCheck({ root });
  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : ` — ${r.detail}`}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
