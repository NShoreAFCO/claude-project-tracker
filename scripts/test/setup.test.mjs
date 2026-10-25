import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { runSetup, resourceNames } from "../lib/setup-steps.mjs";
import { runTeardown } from "../teardown.mjs";
import { askSecret } from "../lib/prompt.mjs";
import { readSecrets } from "../lib/secrets.mjs";
import { fakeCloudflare } from "./fake-cf.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const API_TOKEN = "cf-api-token-THIS-IS-SECRET-42";

/** A throwaway copy of the files setup needs. */
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "setup-"));
  for (const f of ["instance.example", "wrangler.template.jsonc", "migrations"]) cpSync(join(repo, f), join(root, f), { recursive: true });
  mkdirSync(join(root, "seed"));
  return root;
}

/** Scripted answers: first matching [regex, answer] wins; unmatched questions take the default. */
function scriptedIo(answers = []) {
  const asked = [];
  const pick = (q, def) => {
    asked.push(q);
    const hit = answers.find(([re]) => re.test(q));
    return hit ? hit[1] : def;
  };
  return {
    asked,
    ask: async (q, def = "") => pick(q, def),
    askSecret: async (q) => pick(q, API_TOKEN),
    confirm: async (q, def = false) => {
      const a = pick(q, def ? "y" : "n");
      return a === true || /^y/i.test(String(a));
    },
    openUrl: async () => {},
  };
}

const BASE_ANSWERS = [
  [/email/i, " A@Example.com; b@example.com "],
  [/audit/i, "n"],
  [/switch off/i, ""],
];

/** wrangler stand-in: records calls; the D1 project count query answers 0 (empty database). */
function fakeWrangler() {
  const calls = [];
  const fn = async (args, opts = {}) => {
    calls.push({ args, input: opts.input, env: opts.env });
    if (args.includes("execute") && args.some((a) => /count\(\*\)/i.test(a)))
      return { code: 0, stdout: JSON.stringify([{ results: [{ n: 0 }] }]), stderr: "" };
    return { code: 0, stdout: "ok", stderr: "" };
  };
  fn.calls = calls;
  return fn;
}

/** Access in front of a deployed worker: / redirects to Access, API blocked, machine paths 401. */
const accessFetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.pathname === "/")
    return new Response(null, { status: 302, headers: { Location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" } });
  if (u.pathname.startsWith("/api/"))
    return new Response(null, { status: 302, headers: { Location: "https://team.cloudflareaccess.com/x" } });
  return new Response("unauthorized", { status: 401 });
};

function opts(root, extra = {}) {
  const lines = [];
  const fake = extra.fake ?? fakeCloudflare();
  return {
    lines,
    fake,
    run: {
      root,
      prefix: extra.prefix,
      io: extra.io ?? scriptedIo(BASE_ANSWERS),
      cfFetch: fake.fetch,
      wrangler: extra.wrangler ?? fakeWrangler(),
      gh: async () => ({ code: 0, stdout: "example-owner" }),
      checkFetch: accessFetch,
      checkRetries: 0,
      log: (l) => lines.push(l),
    },
  };
}

test("full dry run completes", async () => {
  const root = tempRoot();
  const o = opts(root);
  const r = await runSetup(o.run);
  assert.equal(r.ok, true, o.lines.join("\n"));
  const cfg = JSON.parse(readFileSync(join(root, "instance", "instance.config.json"), "utf8"));
  assert.equal(cfg.upstream, false);
  assert.equal(cfg.deploy.publicUrl, "https://project-tracker.example.workers.dev");
  assert.equal(cfg.deploy.accessTeamDomain, "team.cloudflareaccess.com");
  assert.ok(cfg.deploy.d1.id && cfg.deploy.kv.id && cfg.deploy.accessAud && cfg.deploy.accountId);
  assert.equal(cfg.deploy.allowedServiceTokenIds.length, 1);
  const s = readSecrets(root);
  for (const k of [
    "CLOUDFLARE_API_TOKEN",
    "COOKIE_ENCRYPTION_KEY",
    "GITHUB_WEBHOOK_SECRET",
    "ACCESS_CLIENT_ID",
    "ACCESS_CLIENT_SECRET",
    "ACCESS_TOKEN_URL",
    "ACCESS_AUTHORIZATION_URL",
    "ACCESS_JWKS_URL",
    "HOOK_CLIENT_ID",
    "HOOK_CLIENT_SECRET",
  ])
    assert.ok(s[k], `secret ${k}`);
  const w = o.run.wrangler.calls;
  const puts = w.filter((c) => c.args[0] === "secret" && c.args[1] === "put");
  assert.deepEqual(puts.map((c) => c.args[2]).sort(), [
    "ACCESS_AUTHORIZATION_URL",
    "ACCESS_CLIENT_ID",
    "ACCESS_CLIENT_SECRET",
    "ACCESS_JWKS_URL",
    "ACCESS_TOKEN_URL",
    "COOKIE_ENCRYPTION_KEY",
    "GITHUB_WEBHOOK_SECRET",
  ]);
  for (const p of puts) assert.equal(p.input, s[p.args[2]]);
  assert.ok(w.some((c) => c.args[0] === "deploy"));
  assert.ok(w.some((c) => c.args.join(" ").startsWith("d1 migrations apply")));
  assert.ok(w.every((c) => c.env.CLOUDFLARE_API_TOKEN === API_TOKEN && c.env.CLOUDFLARE_ACCOUNT_ID === "acc1"));
  assert.ok(existsSync(join(root, "wrangler.jsonc")));
});

test("setup is idempotent after a mid-run failure", async () => {
  const root = tempRoot();
  const fake = fakeCloudflare({ failNth: { "POST /accounts/acc1/access/apps": 2 } });
  const first = opts(root, { fake });
  const r1 = await runSetup(first.run);
  assert.equal(r1.ok, false);
  assert.equal(r1.failedStep, "app-b");
  const second = opts(root, { fake });
  const r2 = await runSetup(second.run);
  assert.equal(r2.ok, true, second.lines.join("\n"));
  const posts = (suffix) => fake.calls.filter((c) => c.method === "POST" && c.path.endsWith(suffix)).length;
  assert.equal(posts("/access/apps"), 4); // A, B (failed), B, C
  assert.equal(fake.db.apps.length, 3);
  assert.equal(posts("/d1/database"), 1);
  assert.equal(posts("/storage/kv/namespaces"), 1);
  assert.equal(posts("/access/service_tokens"), 1);
  assert.equal(fake.db.policies.length, 3);
});

test("no secret value appears in captured output", async () => {
  const root = tempRoot();
  const o = opts(root);
  await runSetup(o.run);
  const s = readSecrets(root);
  const text = o.lines.join("\n") + JSON.stringify(o.run.wrangler.calls.map((c) => c.args));
  for (const [k, v] of Object.entries(s))
    if (typeof v === "string" && v.length >= 12 && !/^https:/.test(v)) assert.ok(!text.includes(v), `${k} leaked`);
  assert.ok(!text.includes(API_TOKEN));
});

test("basics step normalises emails and switches off chosen types", async () => {
  const root = tempRoot();
  const o = opts(root, { io: scriptedIo([[/project types/i, "sales-customer, other"], ...BASE_ANSWERS]) });
  await runSetup(o.run);
  const cfg = JSON.parse(readFileSync(join(root, "instance", "instance.config.json"), "utf8"));
  assert.deepEqual(cfg.deploy.allowedEmails, ["a@example.com", "b@example.com"]);
  const off = cfg.categories.project.filter((c) => c.enabled === false).map((c) => c.key);
  assert.deepEqual(off.sort(), ["other", "sales-customer"]);
});

test("basics step asks for admin emails, defaulting to the first allowed email", async () => {
  const root = tempRoot();
  const io = scriptedIo(BASE_ANSWERS);
  const ask = io.ask;
  let adminQuestion = null;
  let adminDefault = null;
  // the user presses Enter on the admin question: the offered default is taken
  io.ask = async (q, def) => (/admin/i.test(q) ? ((adminQuestion = q), (adminDefault = def), def) : ask(q, def));
  const o = opts(root, { io });
  const r = await runSetup(o.run);
  assert.equal(r.ok, true, o.lines.join("\n"));
  assert.match(adminQuestion, /admin email/i);
  assert.equal(adminDefault, "a@example.com");
  const cfg = JSON.parse(readFileSync(join(root, "instance", "instance.config.json"), "utf8"));
  assert.deepEqual(cfg.policy.admins, ["a@example.com"]);
  // the rest of the policy block keeps its defaults
  assert.equal(cfg.policy.default_role, "editor");
});

test("basics step normalises admin emails and refuses one that is not allowed", async () => {
  const root = tempRoot();
  const o = opts(root, { io: scriptedIo([[/admin/i, " B@Example.com "], ...BASE_ANSWERS]) });
  await runSetup(o.run);
  const cfg = JSON.parse(readFileSync(join(root, "instance", "instance.config.json"), "utf8"));
  assert.deepEqual(cfg.policy.admins, ["b@example.com"]);

  const bad = opts(tempRoot(), { io: scriptedIo([[/admin/i, "stranger@example.com"], ...BASE_ANSWERS]) });
  const r = await runSetup(bad.run);
  assert.equal(r.ok, false);
  assert.match(bad.lines.join("\n"), /stranger@example\.com.*allowed/i);
});

test("prefix names every resource", async () => {
  const root = tempRoot();
  const o = opts(root, { prefix: "cpt-test" });
  const r = await runSetup(o.run);
  assert.equal(r.ok, true, o.lines.join("\n"));
  const names = resourceNames("cpt-test");
  assert.ok(o.fake.db.d1.some((d) => d.name === names.d1));
  assert.ok(o.fake.db.apps.every((a) => a.name.startsWith("cpt-test")));
  const cfg = JSON.parse(readFileSync(join(root, "instance", "instance.config.json"), "utf8"));
  assert.equal(cfg.deploy.workerName, "cpt-test");
});

test("teardown deletes only configured names", async () => {
  const root = tempRoot();
  const fake = fakeCloudflare({ d1: [{ uuid: "keep-1", name: "cpt-test-db-other" }], kv: [{ id: "keep-2", title: "someone-else" }] });
  const o = opts(root, { fake, prefix: "cpt-test" });
  await runSetup(o.run);
  const io = scriptedIo([[/type/i, "delete cpt-test"]]);
  const lines = [];
  const r = await runTeardown({ root, io, cfFetch: fake.fetch, wrangler: fakeWrangler(), log: (l) => lines.push(l) });
  assert.equal(r.ok, true, lines.join("\n"));
  assert.deepEqual(
    fake.db.d1.map((d) => d.uuid),
    ["keep-1"],
  );
  assert.deepEqual(
    fake.db.kv.map((k) => k.id),
    ["keep-2"],
  );
  assert.equal(fake.db.apps.length, 0);
  assert.equal(fake.db.policies.length, 0);
  assert.equal(fake.db.tokens.length, 0);
});

test("teardown stops without the typed confirmation", async () => {
  const root = tempRoot();
  const o = opts(root);
  await runSetup(o.run);
  const r = await runTeardown({ root, io: scriptedIo([[/type/i, "yes"]]), cfFetch: o.fake.fetch, wrangler: fakeWrangler(), log: () => {} });
  assert.equal(r.ok, false);
  assert.equal(o.fake.db.apps.length, 3);
});

test("askSecret refuses non-TTY", async () => {
  const input = Readable.from(["typed\n"]);
  await assert.rejects(askSecret("Token: ", { input, output: { write() {} } }), /terminal/i);
});

test("setup:check reports missing parts by name only", async () => {
  const { runSetupCheck } = await import("../setup-check.mjs");
  const root = tempRoot();
  const o = opts(root);
  await runSetup(o.run);
  const results = await runSetupCheck({ root, fetch: accessFetch });
  assert.ok(
    results.every((r) => r.ok),
    JSON.stringify(results.filter((r) => !r.ok)),
  );
  const s = readSecrets(root);
  const text = JSON.stringify(results);
  for (const v of Object.values(s)) if (typeof v === "string" && v.length >= 12 && !v.startsWith("https://")) assert.ok(!text.includes(v));
  const empty = await runSetupCheck({ root: tempRoot(), fetch: accessFetch });
  assert.equal(empty[0].ok, false);
});

test("setup:check validates the policy block and the admins", async () => {
  const { writeFileSync } = await import("node:fs");
  const { runSetupCheck } = await import("../setup-check.mjs");
  const root = tempRoot();
  await runSetup(opts(root).run);
  const file = join(root, "instance", "instance.config.json");
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  cfg.policy.default_role = "owner";
  cfg.policy.admins = ["stranger@example.com"];
  writeFileSync(file, JSON.stringify(cfg));
  const failed = (await runSetupCheck({ root, fetch: accessFetch })).filter((r) => !r.ok);
  const policy = failed.find((r) => r.name === "config policy block is valid");
  assert.ok(policy && /policy\.default_role/.test(policy.detail), JSON.stringify(failed));
  assert.ok(failed.some((r) => r.name === "config policy.admins names allowed emails"));
});
