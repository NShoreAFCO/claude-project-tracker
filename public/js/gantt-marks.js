import { t, fmtDate } from "./i18n.js";
import { parseIssues, issueText, slipText } from "./schedule-ui.js";

/** Return dependency edge keys that are in conflict. */
export function issueEdgeKeys(issues) {
  const keys = new Set();

  for (const issue of issues) {
    if (
      issue.code === "DEP_START_BEFORE_PRED_END" ||
      issue.code === "START_BEFORE_GATE" ||
      issue.code === "MILESTONE_BEFORE_REQUIRED_END"
    ) {
      keys.add(`${issue.related_id}>${issue.entity_id}`);
    }
  }

  return keys;
}

/** Create a baseline ghost bar. */
export function ghostBar(s, { x1, x2, y, height }) {
  return s("rect", {
    class: "baseline-ghost",
    x: x1,
    y,
    width: Math.max(2, x2 - x1),
    height,
    rx: 3,
  });
}

/** Create a baseline ghost milestone diamond. */
export function ghostDiamond(s, { cx, cy, half }) {
  return s("polygon", {
    class: "baseline-ghost",
    points: `${cx},${cy - half} ${cx + half},${cy} ${cx},${cy + half} ${cx - half},${cy}`,
  });
}

/** Create a gate ring diamond. */
export function gateRing(s, { cx, cy, half }) {
  const ringHalf = half + 4;

  return s("polygon", {
    class: "gate-ring",
    points: `${cx},${cy - ringHalf} ${cx + ringHalf},${cy} ${cx},${cy + ringHalf} ${cx - ringHalf},${cy}`,
  });
}

/** Create an issue marker when the entity has schedule issues. */
export function issueMark(s, { x, y, entity, titleOf }) {
  const issues = parseIssues(entity.schedule_issues);

  if (issues.length === 0) {
    return null;
  }

  return s("text", { class: "issue-mark", x, y }, "⚠", s("title", {}, issues.map((issue) => issueText(issue, titleOf)).join("\n")));
}

/** Create a schedule slip marker when there is a non-zero slip. */
export function slipMark(s, { x, y, days }) {
  const text = slipText(days);

  if (text === null || days === 0 || days === null) {
    return null;
  }

  return s("text", { class: days > 0 ? "slip-mark late" : "slip-mark", x, y }, t("slipShort", { n: `${days > 0 ? "+" : ""}${days}` }));
}

/** Build the tooltip text for a Gantt bar. */
export function barTooltip(base, entity, titleOf) {
  const lines = [base];

  for (const issue of parseIssues(entity.schedule_issues)) {
    lines.push(`⚠ ${issueText(issue, titleOf)}`);
  }

  if (entity.baseline_end != null) {
    lines.push(
      entity.baseline_start
        ? t("baselineRange", { start: fmtDate(entity.baseline_start), end: fmtDate(entity.baseline_end) })
        : t("baselineDue", { date: fmtDate(entity.baseline_end) }),
    );
  }

  const slip = slipText(entity.slip_days);

  if (slip !== null) {
    lines.push(slip);
  }

  if (entity.critical === true) {
    lines.push(t("criticalMark"));
  }

  return lines.join("\n");
}

const DAY_MS = 86400000;

/** Day number (days since epoch, UTC) of a YYYY-MM-DD string. */
export function dayOf(ymd) {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

/**
 * Pure bar geometry for one work package. Spans are `{ from, to }` in day numbers, `to` exclusive.
 * `today` is a YYYY-MM-DD string or a day number. Returns null when there is nothing to draw
 * (dates are never invented).
 */
export function barParts(wp, today) {
  const todayDay = typeof today === "number" ? today : dayOf(today);
  const hasPlan = Boolean(wp.start_date && wp.end_date && wp.end_date >= wp.start_date);
  const hasStart = Boolean(wp.actual_start);
  const hasEnd = Boolean(wp.actual_end);

  if (!hasPlan && !hasStart && !hasEnd) return null;

  const planned = hasPlan ? { from: dayOf(wp.start_date), to: dayOf(wp.end_date) + 1 } : null;
  const actualFrom = hasStart ? dayOf(wp.actual_start) : null;
  const actualTo = hasStart ? Math.max(actualFrom + 1, hasEnd ? dayOf(wp.actual_end) + 1 : todayDay + 1) : null;

  const parts = { planned, actual: null, progress: null, overdue: null, solid: null, block: null, extent: null };

  if (hasStart && !hasPlan) {
    parts.solid = { from: actualFrom, to: actualTo };
  } else if (hasStart) {
    parts.actual = { from: actualFrom, to: Math.max(actualFrom, Math.min(actualTo, planned.to)) };
    if (actualTo > planned.to) {
      parts.overdue = { from: planned.to, to: actualTo, closed: hasEnd };
    }
  } else if (hasEnd) {
    const at = dayOf(wp.actual_end);
    parts.block = { from: at, to: at + 1 };
  }

  if (hasPlan) {
    const pct = wp.status === "done" ? 100 : Math.max(0, Math.min(100, wp.progress || 0));
    const to = Math.min(planned.to, planned.from + ((planned.to - planned.from) * pct) / 100);
    parts.progress = { from: planned.from, to };
  }

  const spans = [parts.planned, parts.actual, parts.overdue, parts.solid, parts.block].filter(Boolean);
  parts.extent = { from: Math.min(...spans.map((p) => p.from)), to: Math.max(...spans.map((p) => p.to)) };
  return parts;
}
