// UI strings. The locale comes from the instance config (app.locale); instance/strings.<locale>.json
// overrides single strings. t("key", { var }) fills {var} placeholders.
import config from "../instance/config.js";
import en from "./locales/en.js";
import de from "./locales/de.js";

const LOCALES = { en, de };
const INTL = { en: "en-GB", de: "de-AT" };

/** Deep-merge string overrides into a locale table (objects merge, strings replace). */
export function mergeStrings(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {}))
    out[k] = v && typeof v === "object" && base[k] && typeof base[k] === "object" ? mergeStrings(base[k], v) : v;
  return out;
}

export const LOCALE = LOCALES[config.app?.locale] ? config.app.locale : "en";
export const STRINGS = mergeStrings(LOCALES[LOCALE], { appTitle: config.app?.name, ...(config.strings?.[LOCALE] || {}) });

/** Look up a dotted key ("status.done") and fill {placeholders}. Missing keys render as the key itself. */
export function t(key, vars) {
  let s = key.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), STRINGS);
  if (typeof s !== "string") return key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

export const INTL_LOCALE = INTL[LOCALE];
const dtf = new Intl.DateTimeFormat(INTL[LOCALE], { dateStyle: "medium", timeStyle: "short" });
const df = new Intl.DateTimeFormat(INTL[LOCALE], { dateStyle: "medium" });
const nf = new Intl.NumberFormat(INTL[LOCALE]);

export const fmtDateTime = (iso) => (iso ? dtf.format(new Date(iso)) : t("none"));
/** YYYY-MM-DD → local date without timezone shift. */
export const fmtDate = (ymd) => {
  if (!ymd) return t("none");
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return df.format(new Date(y, m - 1, d));
};
export const fmtNum = (n) => (n === null || n === undefined ? t("none") : nf.format(n));
export const fmtPct = (n) => `${nf.format(Math.round((n ?? 0) * 10) / 10)} %`;
export function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${nf.format(Math.round(b / 102.4) / 10)} KB`;
  return `${nf.format(Math.round(b / 104857.6) / 10)} MB`;
}
