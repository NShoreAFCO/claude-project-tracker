// Instance layer: everything that makes a deployment "yours" lives in instance/ (falls back to
// instance.example/). Core code reads it only through the files build-instance.mjs generates.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export class InstanceError extends Error {}

const KEY = /^[a-z][a-z0-9_-]{0,31}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
export const LOCALES = ["en", "de"];
const PLACEHOLDER_ID = "00000000000000000000000000000000";

/** root/instance if it exists, else root/instance.example. */
export function instanceDir(root) {
  const own = join(root, "instance");
  return existsSync(own) ? own : join(root, "instance.example");
}

/** Load and validate the instance config; throws InstanceError with every problem listed. */
export function loadInstance(root) {
  const dir = instanceDir(root);
  const file = join(dir, "instance.config.json");
  if (!existsSync(file))
    throw new InstanceError(`No instance config found at ${file}. Run "npm run setup" or copy instance.example to instance.`);
  let config;
  try {
    config = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new InstanceError(`${file} is not valid JSON: ${e.message}`);
  }
  const problems = validateConfig(config);
  if (problems.length) throw new InstanceError(`${file} has problems:\n  - ${problems.join("\n  - ")}`);
  return { dir, config, isExample: dir.endsWith("instance.example") };
}

/** Problems in a config, [] when valid. Messages name the field path. */
export function validateConfig(c) {
  const p = [];
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(c)) return ["config must be a JSON object"];
  if (!isObj(c.app)) p.push("app is missing");
  else {
    if (typeof c.app.name !== "string" || !c.app.name.trim()) p.push("app.name must be a non-empty text");
    if (!LOCALES.includes(c.app.locale)) p.push(`app.locale must be one of ${LOCALES.join(", ")}`);
    for (const f of ["logo", "favicon"])
      if (typeof c.app[f] !== "string" || !c.app[f]) p.push(`app.${f} must be a file path inside the instance folder`);
  }
  if (!isObj(c.categories)) p.push("categories is missing");
  else
    for (const kind of ["project", "workpackage"]) {
      const list = c.categories[kind];
      if (!Array.isArray(list) || list.length === 0) {
        p.push(`categories.${kind} must be a non-empty list`);
        continue;
      }
      const seen = new Set();
      list.forEach((cat, i) => {
        const at = `categories.${kind}[${i}]`;
        if (!isObj(cat)) return p.push(`${at} must be an object`);
        if (typeof cat.key !== "string" || !KEY.test(cat.key)) p.push(`${at}.key must be lower-case letters, digits, - or _ (max 32)`);
        else if (seen.has(cat.key)) p.push(`${at}.key "${cat.key}" is a duplicate`);
        else seen.add(cat.key);
        if (typeof cat.color !== "string" || !HEX.test(cat.color)) p.push(`${at}.color must look like #1a2b3c`);
        if (!isObj(cat.label) || typeof cat.label.en !== "string" || !cat.label.en) p.push(`${at}.label.en is required`);
        if (kind === "workpackage" && cat.human !== undefined && typeof cat.human !== "boolean")
          p.push(`${at}.human must be true or false`);
        if (cat.enabled !== undefined && typeof cat.enabled !== "boolean") p.push(`${at}.enabled must be true or false`);
      });
      if (list.every((cat) => cat && cat.enabled === false))
        p.push(`categories.${kind} needs at least one type with enabled not set to false`);
    }
  if (c.deploy !== undefined && !isObj(c.deploy)) p.push("deploy must be an object");
  if (c.checks !== undefined && !isObj(c.checks)) p.push("checks must be an object");
  return p;
}

/** Split on , ; or whitespace, trim, lower-case, dedupe, drop empty. */
export function normaliseEmails(input) {
  const parts = Array.isArray(input) ? input.flatMap((s) => String(s).split(/[,;\s]+/)) : String(input ?? "").split(/[,;\s]+/);
  return [...new Set(parts.map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

/** Fill ${deploy.x.y} placeholders. Arrays join with ","; empty ids become a dummy id so dev/tests run. */
export function renderWrangler(template, config) {
  const deploy = config.deploy ?? {};
  return template.replace(/\$\{deploy\.([a-zA-Z0-9_.]+)\}/g, (_, path) => {
    let v = path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), deploy);
    if (Array.isArray(v)) v = v.join(",");
    if ((v === undefined || v === "") && /(^|\.)id$/.test(path)) v = PLACEHOLDER_ID;
    if (v === undefined || v === null) v = "";
    if (path === "workerName" && !v) v = "project-tracker";
    if (path === "d1.name" && !v) v = "tracker-db";
    if (path === "publicUrl" && !v) v = "http://localhost:8787"; // loopback: accepted by the OAuth provider for local dev
    return String(v).replace(/[\\"]/g, "");
  });
}

/** The categories in use: entries with "enabled": false are left out; the flag itself is dropped. */
export function enabledCategories(config) {
  const pick = (list) => list.filter((c) => c.enabled !== false).map(({ enabled, ...c }) => c);
  return { project: pick(config.categories.project), workpackage: pick(config.categories.workpackage) };
}

/** What the dashboard may see: never the deploy section. */
export function publicConfig(config, overrides = {}) {
  return { app: config.app, categories: enabledCategories(config), strings: overrides };
}
