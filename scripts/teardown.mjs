// Deletes the Cloudflare resources of this instance (names derived from instance.config.json), after a typed confirmation.
// Usage: npm run teardown        It never deletes anything whose name it did not create.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCf } from "./lib/cf.mjs";
import { terminalIo } from "./lib/prompt.mjs";
import { readSecrets, scrubber } from "./lib/secrets.mjs";
import { resourceNames } from "./lib/setup-steps.mjs";

export async function runTeardown({ root, io, cfFetch, log }) {
  const cfgFile = join(root, "instance", "instance.config.json");
  if (!existsSync(cfgFile)) {
    log("No instance/instance.config.json: nothing to tear down.");
    return { ok: false };
  }
  const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
  const secrets = readSecrets(root);
  if (!secrets.CLOUDFLARE_API_TOKEN) {
    log("No Cloudflare API token in secrets/. Run `npm run setup` first, or delete the resources in the Cloudflare dashboard.");
    return { ok: false };
  }
  const base = cfg.deploy.resourcePrefix || cfg.deploy.workerName;
  const n = resourceNames(base);
  const cf = createCf({ token: secrets.CLOUDFLARE_API_TOKEN, accountId: cfg.deploy.accountId || undefined, fetch: cfFetch });
  const scrub = scrubber(secrets);
  try {
    await cf.whoami();
    const found = await cf.listByPrefix(base);
    const exact = (list, name) => list.filter((x) => x.name === name);
    const plan = [
      ...exact(found.apps, n.appA).map((x) => ["app", x]),
      ...exact(found.apps, n.appB).map((x) => ["app", x]),
      ...exact(found.apps, n.appC).map((x) => ["app", x]),
      ...[n.policyAllow, n.policyService, n.policyBypass].flatMap((p) => exact(found.policies, p).map((x) => ["policy", x])),
      ...exact(found.serviceTokens, n.serviceToken).map((x) => ["serviceToken", x]),
      ...exact(found.kv, n.kv).map((x) => ["kv", x]),
      ...exact(found.d1, n.d1).map((x) => ["d1", x]),
    ];
    log(`This permanently deletes the Worker "${n.worker}" and:`);
    for (const [kind, x] of plan) log(`  - ${kind}: ${x.name}`);
    log("The database content is lost. Export it first if you need it (docs/INSTALL.md, 'Back up').");
    const typed = await io.ask(`To confirm, type: delete ${n.worker}`, "");
    if (typed.trim() !== `delete ${n.worker}`) {
      log("Not confirmed. Nothing was deleted.");
      return { ok: false };
    }
    try {
      await cf.deleteResource("worker", n.worker);
      log(`  ✓ worker ${n.worker}`);
    } catch (e) {
      if (e.status !== 404) throw e;
      log(`  - worker ${n.worker} was already gone`);
    }
    for (const [kind, x] of plan) {
      await cf.deleteResource(kind, x.id);
      log(`  ✓ ${kind} ${x.name}`);
    }
    log("Done. The secrets/ folder still holds the old values; delete it if you will not set up this instance again.");
    return { ok: true };
  } catch (e) {
    log(`  ✗ ${scrub(e.message)}`);
    return { ok: false };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  runTeardown({ root, io: terminalIo, log: (l) => console.log(l) }).then((r) => process.exit(r.ok ? 0 : 1));
}
