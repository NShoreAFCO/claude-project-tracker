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
        if (cat.stale_days !== undefined && !isPositiveInt(cat.stale_days))
          p.push(`${at}.stale_days must be a whole number of days, 1 or more`);
      });
      if (list.every((cat) => cat && cat.enabled === false))
        p.push(`categories.${kind} needs at least one type with enabled not set to false`);
    }
  if (c.deploy !== undefined && !isObj(c.deploy)) p.push("deploy must be an object");
  if (c.checks !== undefined && !isObj(c.checks)) p.push("checks must be an object");
  p.push(...validatePolicy(c));
  return p;
}

// ---- policy block (spec §4.3): per-deployment rules; every field optional, defaults below.

export const ROLES = ["viewer", "editor", "decider", "admin"];
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const isPositiveInt = (v) => Number.isInteger(v) && v >= 1;
const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Default project types that need a target date before they can become active (filtered to the catalogue). */
const DEFAULT_TARGET_DATE_CATEGORIES = ["research", "product-development", "product-launch", "quality-regulatory"];

/** What 0, 5 and 10 mean for the default score criteria (labels per locale). */
export const DEFAULT_SCORE_SCALES = {
  value: {
    0: { en: "No noticeable benefit", de: "Kein erkennbarer Nutzen" },
    5: { en: "Clear benefit for one team or use", de: "Deutlicher Nutzen für ein Team oder einen Einsatz" },
    10: { en: "Large benefit across the organisation", de: "Großer Nutzen für die ganze Organisation" },
  },
  quality: {
    0: { en: "Not usable yet", de: "Noch nicht brauchbar" },
    5: { en: "Usable with known gaps", de: "Brauchbar mit bekannten Lücken" },
    10: { en: "Complete, reviewed and reliable", de: "Vollständig, geprüft und verlässlich" },
  },
  risk: {
    0: { en: "No relevant risk", de: "Kein relevantes Risiko" },
    5: { en: "Noticeable risk, under control", de: "Spürbares Risiko, beherrscht" },
    10: { en: "High risk that could stop the project", de: "Hohes Risiko, das das Projekt stoppen kann" },
  },
  effort: {
    0: { en: "Minimal effort", de: "Minimaler Aufwand" },
    5: { en: "Several days to weeks of work", de: "Einige Tage bis Wochen Arbeit" },
    10: { en: "Very large effort over months", de: "Sehr großer Aufwand über Monate" },
  },
  token_efficiency: {
    0: { en: "Token use far above the result", de: "Tokenverbrauch weit über dem Ergebnis" },
    5: { en: "Token use in line with the result", de: "Tokenverbrauch angemessen zum Ergebnis" },
    10: { en: "Very lean token use for the result", de: "Sehr sparsamer Tokenverbrauch für das Ergebnis" },
  },
};
const SCALE_LEVELS = ["0", "5", "10"];

/** Problems in the optional policy block, [] when valid. */
export function validatePolicy(c) {
  const p = [];
  if (!isObject(c) || c.policy === undefined) return p;
  const pol = c.policy;
  if (!isObject(pol)) return ["policy must be an object"];
  const keys = new Set(
    isObject(c.categories) && Array.isArray(c.categories.project) ? c.categories.project.map((x) => x && x.key).filter(Boolean) : [],
  );
  if (pol.admins !== undefined) {
    if (!Array.isArray(pol.admins) || pol.admins.some((e) => typeof e !== "string" || !EMAIL.test(e.trim())))
      p.push("policy.admins must be a list of email addresses");
  }
  if (pol.default_role !== undefined && !ROLES.includes(pol.default_role)) p.push(`policy.default_role must be one of ${ROLES.join(", ")}`);
  if (pol.locales !== undefined) {
    if (!Array.isArray(pol.locales) || !pol.locales.length || pol.locales.some((l) => !LOCALES.includes(l)))
      p.push(`policy.locales must be a non-empty list of ${LOCALES.join(", ")}`);
  }
  for (const f of ["stale_days", "retention_days"])
    if (pol[f] !== undefined && !isPositiveInt(pol[f])) p.push(`policy.${f} must be a whole number of days, 1 or more`);
  if (pol.schedule_strict_default !== undefined && typeof pol.schedule_strict_default !== "boolean")
    p.push("policy.schedule_strict_default must be true or false");
  if (pol.target_date_required_categories !== undefined) {
    const list = pol.target_date_required_categories;
    if (!Array.isArray(list) || list.some((k) => typeof k !== "string"))
      p.push("policy.target_date_required_categories must be a list of project type keys");
    else {
      const unknown = list.filter((k) => !keys.has(k));
      if (unknown.length) p.push(`policy.target_date_required_categories names unknown project types: ${unknown.join(", ")}`);
    }
  }
  if (pol.gates !== undefined) {
    if (!isObject(pol.gates)) p.push("policy.gates must be an object");
    else if (pol.gates.require_decision !== undefined && typeof pol.gates.require_decision !== "boolean")
      p.push("policy.gates.require_decision must be true or false");
  }
  if (pol.hide_empty_categories !== undefined && !["hide", "collapse"].includes(pol.hide_empty_categories))
    p.push("policy.hide_empty_categories must be hide or collapse");
  if (pol.report !== undefined) {
    if (!isObject(pol.report)) p.push("policy.report must be an object");
    else {
      if (pol.report.paper !== undefined && !["a4", "letter"].includes(pol.report.paper))
        p.push("policy.report.paper must be a4 or letter");
      if (pol.report.pdf !== undefined && typeof pol.report.pdf !== "boolean") p.push("policy.report.pdf must be true or false");
    }
  }
  if (pol.score_scales !== undefined) {
    if (!isObject(pol.score_scales)) p.push("policy.score_scales must be an object (criterion → 0/5/10 → labels)");
    else
      for (const [crit, scale] of Object.entries(pol.score_scales)) {
        if (!isObject(scale)) {
          p.push(`policy.score_scales.${crit} must be an object with the levels 0, 5 and 10`);
          continue;
        }
        if (!DEFAULT_SCORE_SCALES[crit] && SCALE_LEVELS.some((l) => !(l in scale)))
          p.push(`policy.score_scales.${crit} is a new criterion and needs all levels 0, 5 and 10`);
        for (const [level, labels] of Object.entries(scale)) {
          if (!SCALE_LEVELS.includes(level)) p.push(`policy.score_scales.${crit}.${level} is not a level (use 0, 5 or 10)`);
          else if (!isObject(labels) || Object.entries(labels).some(([l, t]) => !LOCALES.includes(l) || typeof t !== "string"))
            p.push(`policy.score_scales.${crit}.${level} must map ${LOCALES.join(", ")} to a text`);
        }
      }
  }
  return p;
}

/** The policy block with defaults applied (assumes a valid config). */
export function resolvePolicy(c) {
  const pol = isObject(c.policy) ? c.policy : {};
  const appLocale = LOCALES.includes(c.app?.locale) ? c.app.locale : LOCALES[0];
  const keys = new Set((c.categories?.project ?? []).map((x) => x.key));
  const scales = structuredClone(DEFAULT_SCORE_SCALES);
  for (const [crit, scale] of Object.entries(isObject(pol.score_scales) ? pol.score_scales : {}))
    for (const level of SCALE_LEVELS)
      if (scale?.[level]) scales[crit] = { ...scales[crit], [level]: { ...scales[crit]?.[level], ...scale[level] } };
  return {
    admins: normaliseEmails(pol.admins ?? []),
    default_role: pol.default_role ?? "editor",
    locales: pol.locales ?? [appLocale, ...LOCALES.filter((l) => l !== appLocale)],
    stale_days: pol.stale_days ?? 14,
    schedule_strict_default: pol.schedule_strict_default ?? false,
    target_date_required_categories: pol.target_date_required_categories ?? DEFAULT_TARGET_DATE_CATEGORIES.filter((k) => keys.has(k)),
    gates: { require_decision: pol.gates?.require_decision ?? true },
    retention_days: pol.retention_days ?? 30,
    hide_empty_categories: pol.hide_empty_categories ?? "collapse",
    report: { paper: pol.report?.paper ?? "a4", pdf: pol.report?.pdf ?? true },
    score_scales: scales,
  };
}

/** Split on , ; or whitespace, trim, lower-case, dedupe, drop empty. */
export function normaliseEmails(input) {
  const parts = Array.isArray(input) ? input.flatMap((s) => String(s).split(/[,;\s]+/)) : String(input ?? "").split(/[,;\s]+/);
  return [...new Set(parts.map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

/** Fill ${deploy.x.y} placeholders. Arrays join with ","; empty ids become a dummy id so dev/tests run. */
export function renderWrangler(template, config) {
  const deploy = config.deploy ?? {};
  if (config.policy?.report?.pdf === false) {
    template = template.replace(/[ \t]*\/\/ @browser-begin[\s\S]*?\/\/ @browser-end\n/, "");
  }
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
  const { locales, hide_empty_categories, target_date_required_categories } = resolvePolicy(config);
  // only the policy keys the dashboard needs (role-independent display rules); never admins or emails
  return {
    app: config.app,
    categories: enabledCategories(config),
    policy: { locales, hide_empty_categories, target_date_required_categories },
    strings: overrides,
  };
}
