// Progress transparency, risk and staleness chips shared by the cards and the project page (spec F6-F8).
import { t, fmtPct, fmtDateTime } from "./i18n.js";
import { h } from "./dom.js";
import { riskBand } from "./risk-band.js";

/** Plain-text basis of a project percentage: derived from done/total work packages, or set by hand with a reason. */
export function basisText(basis) {
  if (!basis) return "";
  if (basis.mode === "manual") return t("basisManual", { reason: basis.reason || t("none") });
  return t("basisDerived", { done: basis.done, total: basis.total, pct: fmtPct(basis.weighted_percent) });
}

/** Visible "Derived"/"Manual" label with the basis as tooltip. */
export function basisLabel(basis) {
  if (!basis) return null;
  const mode = basis.mode === "manual" ? "manual" : "derived";
  return h(`span.basis.basis-${mode}`, { title: basisText(basis) }, t(`basisLabel.${mode}`), " ", h("span.basis-text", basisText(basis)));
}

/** Risk chip coloured by the highest open score; null without open risks. */
export function riskChip(summary) {
  if (!summary?.open) return null;
  const band = riskBand(summary.max_score ?? 0);
  const tip = t("riskChipTip", { open: summary.open, max: summary.max_score, noAction: summary.high_without_action });
  return h(`span.chip.risk-chip.band-${band}`, { title: tip }, t("chipRisks", { n: summary.open, max: summary.max_score }));
}

/** Amber "No progress" chip for a stale active project. */
export const staleChip = (stale) => (stale ? h("span.chip.flag-stale", { title: t("staleHint") }, t("chipStale")) : null);

/** "Last activity: <date>" span (shared by card and project page). */
export const lastActivity = (iso) => h("span", t("lastActivity"), ": ", h("b", fmtDateTime(iso)));
