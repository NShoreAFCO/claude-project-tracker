// UI strings. The locale comes from the instance config (app.locale); instance/strings.<locale>.json overrides single strings.
import config from "../instance/config.js";
import en from "./locales/en.js";
import de from "./locales/de.js";

const LOCALES = { en, de };
const INTL = { en: "en-GB", de: "de-AT" };

export const AVAILABLE = Object.keys(LOCALES);

export function mergeStrings(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {}))
    out[k] = v && typeof v === "object" && base[k] && typeof base[k] === "object" ? mergeStrings(base[k], v) : v;
  return out;
}

export let LOCALE;
export let STRINGS;
export let INTL_LOCALE;

let dtf;
let df;
let nf;

export function setLocale(code) {
  if (!LOCALES[code]) return false;

  LOCALE = code;
  STRINGS = mergeStrings(LOCALES[LOCALE], {
    appTitle: config.app?.name,
    ...(config.strings?.[LOCALE] || {}),
  });
  INTL_LOCALE = INTL[LOCALE];

  dtf = new Intl.DateTimeFormat(INTL_LOCALE, { dateStyle: "medium", timeStyle: "short" });
  df = new Intl.DateTimeFormat(INTL_LOCALE, { dateStyle: "medium" });
  nf = new Intl.NumberFormat(INTL_LOCALE);

  if (typeof document !== "undefined") {
    document.documentElement.lang = LOCALE;
  }

  return true;
}

export function storedLocale() {
  try {
    const code = localStorage.getItem("tracker.locale");
    return LOCALES[code] ? code : null;
  } catch {
    return null;
  }
}

export function rememberLocale(code) {
  try {
    localStorage.setItem("tracker.locale", code);
  } catch {
    // Ignore storage errors.
  }
}

setLocale(storedLocale() ?? (LOCALES[config.app?.locale] ? config.app.locale : "en"));

export function t(key, vars) {
  let s = key.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), STRINGS);
  if (typeof s !== "string") return key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

export const fmtDateTime = (iso) => (iso ? dtf.format(new Date(iso)) : t("none"));
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
