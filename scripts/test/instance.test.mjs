import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { instanceDir, validateConfig, normaliseEmails, renderWrangler, publicConfig, resolvePolicy } from "../lib/instance.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const example = JSON.parse(readFileSync(join(root, "instance.example", "instance.config.json"), "utf8"));
const clone = (o) => JSON.parse(JSON.stringify(o));

test("instanceDir falls back to instance.example", () => {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  mkdirSync(join(dir, "instance.example"));
  assert.equal(instanceDir(dir), join(dir, "instance.example"));
  mkdirSync(join(dir, "instance"));
  assert.equal(instanceDir(dir), join(dir, "instance"));
});

test("example config is valid", () => {
  assert.deepEqual(validateConfig(example), []);
});

test("validateConfig rejects bad colour", () => {
  const c = clone(example);
  c.categories.project[0].color = "red";
  assert.ok(validateConfig(c).some((p) => p.includes("categories.project[0].color")));
});

test("validateConfig rejects duplicate key", () => {
  const c = clone(example);
  c.categories.workpackage[1].key = c.categories.workpackage[0].key;
  assert.ok(validateConfig(c).some((p) => p.includes("duplicate")));
});

test("validateConfig rejects unknown locale and missing en label", () => {
  const c = clone(example);
  c.app.locale = "fr";
  delete c.categories.project[0].label.en;
  const problems = validateConfig(c);
  assert.ok(problems.some((p) => p.includes("app.locale")));
  assert.ok(problems.some((p) => p.includes("categories.project[0].label.en")));
});

test("normaliseEmails", () => {
  assert.deepEqual(normaliseEmails(" A@Example.com; b@example.com ,a@example.com"), ["a@example.com", "b@example.com"]);
  assert.deepEqual(normaliseEmails(["X@example.org", ""]), ["x@example.org"]);
});

test("renderWrangler fills placeholders and never emits deploy secrets", () => {
  const c = clone(example);
  c.deploy.workerName = "my-tracker";
  c.deploy.allowedEmails = ["a@example.com", "b@example.com"];
  const tpl = readFileSync(join(root, "wrangler.template.jsonc"), "utf8");
  const out = renderWrangler(tpl, c);
  assert.ok(!out.includes("${"), "no placeholder left");
  assert.match(out, /"name": "my-tracker"/);
  assert.match(out, /"ALLOWED_EMAILS": "a@example.com,b@example.com"/);
  assert.match(out, /"database_id": "00000000000000000000000000000000"/);
  assert.ok(!/SECRET|COOKIE_ENCRYPTION_KEY/.test(out));
});

test("publicConfig omits deploy", () => {
  const pc = publicConfig(example, { de: { appTitle: "X" } });
  assert.equal(pc.deploy, undefined);
  assert.deepEqual(Object.keys(pc).sort(), ["app", "categories", "strings"]);
  assert.equal(pc.strings.de.appTitle, "X");
});

test("buildInstance writes generated files and keeps deploy out of the public config", async () => {
  const { cpSync, existsSync } = await import("node:fs");
  const { buildInstance } = await import("../build-instance.mjs");
  const dir = mkdtempSync(join(tmpdir(), "build-"));
  cpSync(join(root, "instance.example"), join(dir, "instance.example"), { recursive: true });
  cpSync(join(root, "wrangler.template.jsonc"), join(dir, "wrangler.template.jsonc"));
  const r = buildInstance(dir);
  assert.equal(r.isExample, true);
  for (const f of ["wrangler.jsonc", "src/generated/instance.ts", "public/instance/config.js", "public/instance/categories.css"])
    assert.ok(existsSync(join(dir, f)), f);
  const pub = readFileSync(join(dir, "public/instance/config.js"), "utf8");
  assert.ok(!pub.includes("deploy") && !pub.includes("allowedEmails"));
  assert.match(readFileSync(join(dir, "public/instance/categories.css"), "utf8"), /--cat-w-coding: #2f6db5;/);
});

test("renderWrangler defaults an empty publicUrl to a loopback URL for local dev", () => {
  const tpl = readFileSync(join(root, "wrangler.template.jsonc"), "utf8");
  assert.match(renderWrangler(tpl, example), /"PUBLIC_URL": "http:\/\/localhost:8787"/);
});

test("disabled categories are left out of the generated config", () => {
  const c = clone(example);
  c.categories.project[0].enabled = false;
  const pc = publicConfig(c);
  assert.ok(!pc.categories.project.some((x) => x.key === example.categories.project[0].key));
  assert.equal(pc.categories.project.length, example.categories.project.filter((x) => x.enabled !== false).length - 1);
  assert.ok(pc.categories.project.every((x) => !("enabled" in x)));
});

test("validateConfig: enabled must be boolean and each list keeps one enabled type", () => {
  const c = clone(example);
  c.categories.project[0].enabled = "no";
  assert.ok(validateConfig(c).some((p) => p.includes("categories.project[0].enabled")));
  const d = clone(example);
  d.categories.workpackage.forEach((x) => (x.enabled = false));
  assert.ok(validateConfig(d).some((p) => p.includes("categories.workpackage") && p.includes("enabled")));
});

test("example catalogue covers the common project and work types", () => {
  const p = example.categories.project.map((x) => x.key);
  for (const k of [
    "research",
    "product-development",
    "product-launch",
    "product-optimisation",
    "process-development",
    "process-implementation",
    "process-optimisation",
  ])
    assert.ok(p.includes(k), k);
  const w = example.categories.workpackage.map((x) => x.key);
  for (const k of ["coding", "research", "design", "testing", "pm", "docs", "rollout"]) assert.ok(w.includes(k), k);
  for (const list of [example.categories.project, example.categories.workpackage])
    for (const x of list) assert.ok(x.label.en && x.label.de, `${x.key} needs en and de labels`);
});

test("policy defaults applied when block missing", () => {
  const c = clone(example);
  delete c.policy;
  assert.deepEqual(validateConfig(c), []);
  const p = resolvePolicy(c);
  assert.deepEqual(p.admins, []);
  assert.equal(p.default_role, "editor");
  assert.deepEqual(p.locales, ["en", "de"]);
  assert.equal(p.stale_days, 14);
  assert.equal(p.schedule_strict_default, false);
  assert.deepEqual(p.target_date_required_categories, ["research", "product-development", "product-launch", "quality-regulatory"]);
  assert.deepEqual(p.gates, { require_decision: true });
  assert.equal(p.retention_days, 30);
  assert.equal(p.hide_empty_categories, "collapse");
  assert.deepEqual(p.report, { paper: "a4", pdf: true });
  for (const k of ["value", "quality", "risk", "effort", "token_efficiency"])
    for (const level of ["0", "5", "10"]) assert.ok(p.score_scales[k][level].en && p.score_scales[k][level].de, `${k}.${level}`);
  // German instance: its own locale comes first
  c.app.locale = "de";
  assert.deepEqual(resolvePolicy(c).locales, ["de", "en"]);
});

test("policy values override defaults; emails are normalised; unknown default keys are dropped", () => {
  const c = clone(example);
  c.policy = { admins: [" Boss@Example.com "], stale_days: 7, gates: {}, report: { paper: "letter" } };
  const p = resolvePolicy(c);
  assert.deepEqual(p.admins, ["boss@example.com"]);
  assert.equal(p.stale_days, 7);
  assert.deepEqual(p.gates, { require_decision: true });
  assert.deepEqual(p.report, { paper: "letter", pdf: true });
  const d = clone(example);
  delete d.policy;
  d.categories.project = d.categories.project.filter((x) => x.key !== "research");
  assert.ok(!resolvePolicy(d).target_date_required_categories.includes("research"));
});

test("example config carries the policy block with the defaults", () => {
  assert.ok(example.policy, "instance.example has a policy block");
  const c = clone(example);
  delete c.policy;
  const defaults = resolvePolicy(c);
  assert.deepEqual({ ...resolvePolicy(example), admins: [] }, defaults);
});

test("invalid default_role rejected with readable message", () => {
  const c = clone(example);
  c.policy = { ...c.policy, default_role: "owner" };
  const problems = validateConfig(c);
  assert.ok(
    problems.some((p) => p.includes("policy.default_role") && p.includes("viewer, editor, decider, admin")),
    problems.join("\n"),
  );
});

test("validateConfig checks the other policy fields", () => {
  const c = clone(example);
  c.policy = {
    admins: ["not-an-email"],
    locales: ["fr"],
    stale_days: 0,
    schedule_strict_default: "no",
    target_date_required_categories: ["unknown-type"],
    gates: { require_decision: "yes" },
    retention_days: -1,
    hide_empty_categories: "fold",
    report: { paper: "a3", pdf: 1 },
    score_scales: { value: { 5: "middle" } },
  };
  c.categories.project[0].stale_days = "soon";
  const problems = validateConfig(c).join("\n");
  for (const f of [
    "policy.admins",
    "policy.locales",
    "policy.stale_days",
    "policy.schedule_strict_default",
    "policy.target_date_required_categories",
    "policy.gates.require_decision",
    "policy.retention_days",
    "policy.hide_empty_categories",
    "policy.report.paper",
    "policy.report.pdf",
    "policy.score_scales.value.5",
    "categories.project[0].stale_days",
  ])
    assert.ok(problems.includes(f), `${f} missing in:\n${problems}`);
});
