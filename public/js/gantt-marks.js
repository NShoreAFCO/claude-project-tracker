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
    if (actualFrom < planned.to) parts.actual = { from: actualFrom, to: Math.min(actualTo, planned.to) };
    if (actualTo > planned.to) {
      parts.overdue = { from: Math.max(actualFrom, planned.to), to: actualTo, closed: hasEnd };
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

// qol:t11
const linkId = (x) => (typeof x === "string" ? x : (x?.workpackage_id ?? x?.id ?? null));

/** Date a milestone is drawn at: due date, else the reached date of a done one. */
export function markDate(m) {
  return m.due_date || (m.done && m.reached_at ? m.reached_at.slice(0, 10) : null);
}

/**
 * Decide on which Gantt row each milestone / gate is drawn (pure).
 * `rows`: the visible work package rows (`{ w: { id } }`); `topOf`: Map wpId -> top-level wpId;
 * `entries`: `{ m, p }` per milestone (m.requires / m.unlocks are WP ids, m.workpackage_id the attached WP).
 * Milestones go on the row of their main WP (attached, else last `requires`); gates on the row of the WP they
 * unlock (that WP's row, else its main WP's row), falling back to the milestone rule. Labels `M<n>` / `G<n>` count
 * per project by date (ties keep input order). Returns `{ placed: Map(row -> marks[]), unplaced: marks[] }`,
 * a mark being `{ m, p, kind, label, date, row }`.
 */
export function placeMarks(rows, entries, topOf = new Map()) {
  const rowOf = new Map();
  for (const r of rows) if (r.w) rowOf.set(r.w.id, r);
  const ownOrMain = (id) => rowOf.get(id) ?? rowOf.get(topOf.get(id)) ?? null;
  const mainRow = (id) => rowOf.get(topOf.get(id) ?? id) ?? null;

  const counters = new Map();
  const order = entries
    .map((e, i) => ({ e, i, date: markDate(e.m) }))
    .sort((a, b) => (a.date === b.date ? a.i - b.i : a.date === null ? 1 : b.date === null ? -1 : a.date < b.date ? -1 : 1));

  const placed = new Map();
  const unplaced = [];
  for (const { e, date } of order) {
    const { m, p } = e;
    const kind = m.gate ? "gate" : "milestone";
    const key = `${p?.id ?? m.project_id ?? ""}|${kind}`;
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    const base = { m, p, kind, label: `${kind === "gate" ? "G" : "M"}${n}`, date };

    const requires = (m.requires || []).map(linkId).filter(Boolean);
    let target = null;
    if (kind === "gate") {
      for (const id of (m.unlocks || []).map(linkId)) {
        target = id ? ownOrMain(id) : null;
        if (target) break;
      }
    }
    if (!target && m.workpackage_id) target = mainRow(m.workpackage_id);
    if (!target && requires.length) target = mainRow(requires[requires.length - 1]);

    if (!target) {
      unplaced.push({ ...base, row: null });
      continue;
    }
    if (!placed.has(target)) placed.set(target, []);
    placed.get(target).push({ ...base, row: target });
  }
  return { placed, unplaced };
}
// /qol:t11
