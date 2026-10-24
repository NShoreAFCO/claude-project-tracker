// Category keys, labels and colour marks from the instance config (instance.config.json → /instance/config.js;
// colours → /instance/categories.css). Keys stored in D1 that the instance no longer lists render neutrally.
import config from "../instance/config.js";
import { t, LOCALE } from "./i18n.js";
import { h } from "./dom.js";

const lists = { p: config.categories.project, w: config.categories.workpackage };
export const PROJECT_CATEGORIES = lists.p.map((c) => c.key);
export const WP_CATEGORIES = lists.w.map((c) => c.key);

const find = (kind, key) => lists[kind].find((c) => c.key === key);

/** The key if the instance still lists it, else null (used to group legacy keys with "no category"). */
export const knownCategory = (kind, key) => (key && find(kind, key) ? key : null);

/** CSS colour for a category mark; kind "p" = project, "w" = work package; null or unknown → neutral. */
export const catVar = (kind, key) => (knownCategory(kind, key) ? `var(--cat-${kind}-${key})` : "var(--cat-none)");

/** Category label in the UI locale (falls back to English, then the raw key); null → "No category". */
export function catLabel(kind, key) {
  if (!key) return t("noCategory");
  const c = find(kind, key);
  return c ? (c.label[LOCALE] ?? c.label.en) : key;
}

/** Small colour dot (decorative; the label next to it carries the meaning). */
export const catDot = (kind, key) => h("span.cat-dot", { "aria-hidden": "true", style: { background: catVar(kind, key) } });

/** Dot + label chip; inherited = category comes from the parent WP. */
export const catChip = (kind, key, inherited = false) =>
  h("span.cat-chip", catDot(kind, key), catLabel(kind, key), inherited ? h("span.meta", ` (${t("inherited")})`) : null);
