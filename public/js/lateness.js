// One answer to "is this late, and by how much?" for every dashboard view.
// Same rule as the server: a date before today in UTC is late (string compare of YYYY-MM-DD).
import { h } from "./dom.js";
import { t } from "./i18n.js";

const NEVER_LATE = new Set(["done", "dropped", "reached"]);
const DAY_MS = 86400000;

const utcDay = (ymd) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};

/** lateness("2026-05-01", "doing") -> { late, days, date }. days = whole UTC days past the date (0 when not late). */
export function lateness(date, status, now = new Date()) {
  const day = typeof date === "string" ? date.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || NEVER_LATE.has(status)) return { late: false, days: 0, date: day || null };
  const today = now.toISOString().slice(0, 10);
  if (day >= today) return { late: false, days: 0, date: day };
  return { late: true, days: Math.round((utcDay(today) - utcDay(day)) / DAY_MS), date: day };
}

/** The "Overdue · 7 d" chip, or null when not late. The words carry the meaning; colour is extra. */
export function lateChip(info) {
  if (!info || !info.late) return null;
  return h(
    "span.chip.late",
    { title: t("lateChipTitle", { date: info.date, n: info.days }) },
    h("span.late-icon", { "aria-hidden": "true" }, "⚠"),
    t("lateChip", { n: info.days }),
  );
}
