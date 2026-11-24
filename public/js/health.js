// Project health (REST `health: { state, reasons } | null`): chip, reason text and line, shared by grid and list.
import { t, fmtDate } from "./i18n.js";
import { h } from "./dom.js";

/** Worst first: the order of the grid filter row. */
export const HEALTH_ORDER = ["on_hold", "late", "at_risk", "stalled", "on_track"];

/** CSS class suffix of a state (`at_risk` -> `at-risk`). */
const cls = (state) => state.replace(/_/g, "-");

/** Chip with the localised state name (words, not colour only); `null` for a project without health. */
export function healthChip(health) {
  if (!health || !HEALTH_ORDER.includes(health.state)) return null;
  return h(`span.chip.health.h-${cls(health.state)}`, t(`healthState.${health.state}`));
}

const label = (r) => [r.code, r.title].filter(Boolean).join(" ");

/** One localised string for one reason. */
export function healthReasonText(reason) {
  switch (reason.kind) {
    case "on_hold":
      return t("healthReason.on_hold");
    case "milestone_overdue":
      return t(reason.gate ? "healthReason.gate_overdue" : "healthReason.milestone_overdue", { label: label(reason), n: reason.days });
    case "target_passed":
      return t("healthReason.target_passed", { date: fmtDate(reason.date), n: reason.days });
    case "high_risk":
      return t("healthReason.high_risk", { title: reason.title });
    case "wp_blocked":
      return t("healthReason.wp_blocked", { label: label(reason) });
    case "gate_due": {
      const key = reason.days < 0 ? "gate_overdue" : reason.days === 0 ? "gate_today" : reason.days === 1 ? "gate_tomorrow" : "gate_in";
      return t(`healthReason.${key}`, { label: label(reason), n: Math.abs(reason.days) });
    }
    case "wp_late":
      return t("healthReason.wp_late", { label: label(reason), n: reason.days });
    case "no_activity":
      return reason.days === null || reason.days === undefined
        ? t("healthReason.no_activity_unknown")
        : t("healthReason.no_activity", { n: reason.days });
    case "next_milestone":
      return reason.due_date
        ? t("healthReason.next_milestone", { label: label(reason), date: fmtDate(reason.due_date) })
        : t("healthReason.next_milestone_undated", { label: label(reason) });
    default:
      return "";
  }
}

/** `div.health-reason` with up to two reasons joined by " · "; `null` without reasons. */
export function healthLine(health) {
  const texts = (health?.reasons || []).slice(0, 2).map(healthReasonText).filter(Boolean);
  return texts.length ? h("div.health-reason", texts.join(" · ")) : null;
}
