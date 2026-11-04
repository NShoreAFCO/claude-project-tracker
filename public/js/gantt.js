// Hand-rolled SVG Gantt (SPEC §9). Only work packages with dates get a bar; dates are never invented.
import { t, fmtDate, fmtPct, INTL_LOCALE } from "./i18n.js";
import { api } from "./api.js";
import { h, clear, statusChip, toastError } from "./dom.js";
import { openProject } from "./project.js";
import { WP_CATEGORIES, catVar, catDot, catLabel } from "./categories.js";
import { collectIssues } from "./schedule-ui.js";
import { issueEdgeKeys, ghostBar, ghostDiamond, issueMark, slipMark, barTooltip, barParts, placeMarks, markDate, markEdges, markArrowPath, markHalf } from "./gantt-marks.js";

const NS = "http://www.w3.org/2000/svg";
const s = (tag, attrs = {}, ...children) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  for (const c of children) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
};
const DAY = 86400000;
const toDay = (ymd) => {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY;
};
const monthFmt = () => new Intl.DateTimeFormat(INTL_LOCALE, { month: "short", year: "2-digit", timeZone: "UTC" });

let selected = "";
let level = "all";
let showDeps = true;
let showBaseline = false;
let showCritical = false;

/** Query of the current hash route (#/gantt?project=<id>): the project filter lives in the URL. */
const hashParams = () => new URLSearchParams(location.hash.split("?")[1] || "");

const milestoneDate = markDate;

const milestoneState = (m, today) => {
  if (m.done) return "done";
  if (m.due_date && toDay(m.due_date) < today) return "overdue";
  return "open";
};

const milestoneStateLabel = (state) => (state === "done" ? t("reached") : state === "overdue" ? t("overdue") : t("msOpen"));

export async function renderGantt(main, state) {
  const wanted = hashParams().get("project") || "";
  selected = state.projects.some((p) => p.id === wanted) ? wanted : "";
  const rerender = () => renderGantt(main, state);
  clear(main, h("h2", t("ganttTitle")), h("p", t("loading")));
  const projects = state.projects.filter((p) => !selected || p.id === selected);
  let detailsBy;
  try {
    detailsBy = await Promise.all(projects.map(async (p) => [p, await api.project(p.id)]));
  } catch (e) {
    toastError(e);
    return;
  }

  const picker = h(
    "select",
    {
      "aria-label": t("ganttProject"),
      on: {
        change: (e) => {
          selected = e.target.value;
          history.replaceState(null, "", selected ? `#/gantt?project=${encodeURIComponent(selected)}` : "#/gantt");
          rerender();
        },
      },
    },
    h("option", { value: "" }, t("ganttAllProjects")),
    state.projects.map((p) => h("option", { value: p.id }, p.title)),
  );
  picker.value = selected;

  const levelPicker = h(
    "select",
    { "aria-label": t("levelLabel"), on: { change: (e) => ((level = e.target.value), rerender()) } },
    h("option", { value: "main" }, t("levelMain")),
    h("option", { value: "all" }, t("levelAll")),
  );
  levelPicker.value = level;

  const depsCheck = h("input", {
    type: "checkbox",
    checked: showDeps,
    on: { change: (e) => ((showDeps = e.target.checked), rerender()) },
  });
  const baselineCheck = h("input", {
    type: "checkbox",
    checked: showBaseline,
    on: { change: (e) => ((showBaseline = e.target.checked), rerender()) },
  });
  const criticalCheck = h("input", {
    type: "checkbox",
    checked: showCritical,
    on: { change: (e) => ((showCritical = e.target.checked), rerender()) },
  });

  const todayYmd = new Date().toISOString().slice(0, 10);
  const rows = [];
  const undated = [];
  const visibleByWp = new Map();
  const allWps = [];
  const milestones = [];
  const topOf = new Map();
  const titles = new Map();
  const issues = [];

  for (const [, detail] of detailsBy) {
    const walk = (w) => (titles.set(w.id, w.title), (w.children || []).forEach(walk));
    (detail.workpackages || []).forEach(walk);
    (detail.milestones || []).forEach((m) => titles.set(m.id, m.title));
    issues.push(...collectIssues(detail));
  }
  const opts = { titleOf: (id) => titles.get(id), issueKeys: issueEdgeKeys(issues) };
  const noBaseline = detailsBy.filter(([, d]) => !d.baseline).length;

  for (const [p, detail] of detailsBy) {
    const projectRows = [];
    const roots = detail.workpackages || [];
    const projectMilestones = detail.milestones || [];

    const collectDescendantSpan = (root) => {
      let start = null;
      let end = null;

      const scan = (w) => {
        if (w.start_date && w.end_date && w.end_date >= w.start_date) {
          if (!start || w.start_date < start) start = w.start_date;
          if (!end || w.end_date > end) end = w.end_date;
        }
        for (const child of w.children || []) scan(child);
      };

      for (const child of root.children || []) scan(child);
      return start && end ? { start_date: start, end_date: end } : null;
    };

    const actualSpan = (w) => {
      const from = w.actual_start || w.actual_end;
      if (!from) return null;
      return { start_date: from, end_date: w.actual_end || (from > todayYmd ? from : todayYmd) };
    };

    const walkAll = (w, depth, top) => {
      allWps.push(w);
      const validOwn = w.start_date && w.end_date && w.end_date >= w.start_date;

      if (level === "main") {
        if (depth === 0) {
          const ownActual = validOwn ? null : actualSpan(w);
          const descendants = validOwn || ownActual ? null : collectDescendantSpan(w);
          const span = validOwn ? { start_date: w.start_date, end_date: w.end_date } : ownActual || descendants;
          if (span) {
            const row = {
              type: "wp",
              w,
              depth: 0,
              p,
              start_date: span.start_date,
              end_date: span.end_date,
              actualOnly: !validOwn && !descendants,
            };
            projectRows.push(row);
            visibleByWp.set(w.id, row);
            top = row;
          } else {
            undated.push({ type: "wp", w, p });
            top = null;
          }
        } else if (top) {
          visibleByWp.set(w.id, top);
        }

        for (const child of w.children || []) walkAll(child, depth + 1, top);
        return;
      }

      const own = validOwn ? { start_date: w.start_date, end_date: w.end_date } : actualSpan(w);
      if (own) {
        const row = {
          type: "wp",
          w,
          depth,
          p,
          start_date: own.start_date,
          end_date: own.end_date,
          actualOnly: !validOwn,
        };
        projectRows.push(row);
        visibleByWp.set(w.id, row);
      } else {
        undated.push({ type: "wp", w, p });
      }

      for (const child of w.children || []) walkAll(child, depth + 1, null);
    };

    const markTop = (w, rootId) => (topOf.set(w.id, rootId), (w.children || []).forEach((c) => markTop(c, rootId)));
    for (const w of roots) markTop(w, w.id);
    for (const w of roots) walkAll(w, 0, null);

    for (const m of projectMilestones) {
      milestones.push({ m, p });
    }

    if (projectRows.length) rows.push({ type: "project", p }, ...projectRows);
  }

  // milestones and gates ride on WP rows (D14); undated plain milestones go to the table, the rest unplaced
  const { placed, unplaced } = placeMarks(
    rows.filter((r) => r.type === "wp"),
    milestones,
    topOf,
  );
  // an undated gate is only drawn when it unlocks a WP (it sits at that WP's start); other undated gates are legend-only (G2 R5)
  const drawable = (mk) => mk.date || (mk.kind === "gate" && (mk.m.unlocks || []).length > 0);
  const legendOnly = [];
  const skip = (mk) => (mk.kind === "gate" ? legendOnly.push(mk) : undated.push({ type: "milestone", m: mk.m, p: mk.p }));
  for (const [row, marks] of placed) {
    for (const mk of marks.filter((x) => !drawable(x))) skip(mk);
    placed.set(row, marks.filter(drawable));
  }
  const unplacedDated = [];
  for (const mk of unplaced) (mk.date ? unplacedDated.push(mk) : skip(mk));
  if (unplacedDated.length) rows.push({ type: "unplaced", marks: unplacedDated });
  // a gate drawn on several rows is listed once
  const allMarks = [...new Map([...[...placed.values()].flat(), ...unplacedDated, ...legendOnly].map((mk) => [mk.m.id, mk])).values()].sort((a, b) =>
    a.kind === b.kind ? Number(a.label.slice(1)) - Number(b.label.slice(1)) : a.kind === "milestone" ? -1 : 1,
  );
  const marksCtx = { placed };

  const body = [];
  if (!rows.length) {
    body.push(h("p.empty", t("ganttEmpty")));
  } else {
    body.push(
      showBaseline && noBaseline ? h("p.meta", { role: "status" }, t("ganttNoBaseline")) : null,
      h("div.gantt-wrap", chart(rows, visibleByWp, allWps, { ...opts, ...marksCtx })),
      legend(allMarks),
    );
  }

  if (undated.length) {
    const today = Math.floor(Date.now() / DAY);
    body.push(
      h(
        "section.undated",
        h("h3", t("ganttUndated", { n: undated.length })),
        h("p.meta", t("ganttUndatedHint")),
        h(
          "div.table-wrap",
          h(
            "table",
            h(
              "thead",
              h(
                "tr",
                [t("ganttProject"), t("colWp"), t("colStatus"), t("start"), t("fEnd")].map((x) => h("th", x)),
              ),
            ),
            h(
              "tbody",
              undated.map((item) => {
                const { p } = item;
                if (item.type === "milestone") {
                  const msState = milestoneState(item.m, today);
                  return h(
                    "tr",
                    h("td", h("button.linkbtn", { type: "button", on: { click: () => openProject(p.id) } }, p.title)),
                    h("td", `◆ ${item.m.title}`),
                    h("td", milestoneStateLabel(msState)),
                    h("td", fmtDate(null)),
                    h("td", fmtDate(null)),
                  );
                }

                const { w } = item;
                return h(
                  "tr",
                  h("td", h("button.linkbtn", { type: "button", on: { click: () => openProject(p.id) } }, p.title)),
                  h("td", w.title),
                  h("td", statusChip(w.status)),
                  h("td", fmtDate(w.start_date)),
                  h("td", fmtDate(w.end_date)),
                );
              }),
            ),
          ),
        ),
      ),
    );
  }

  clear(
    main,
    h(
      "div.toolbar",
      h("h2", { style: { margin: 0, flex: 1 } }, t("ganttTitle")),
      h("div", { style: { "min-width": "220px" } }, picker),
      h("div", { style: { "min-width": "180px" } }, levelPicker),
      h("label.check", depsCheck, t("dependencies")),
      h("label.check", baselineCheck, t("ganttBaseline")),
      h("label.check", criticalCheck, t("ganttCritical")),
    ),
    ...body,
  );
}

function chart(rows, visibleByWp, allWps, { titleOf, issueKeys, placed }) {
  const datedRows = rows.filter((r) => r.type === "wp");
  const today = Math.floor(Date.now() / DAY);

  const partsOf = (r) =>
    barParts(
      r.actualOnly ? { ...r.w, start_date: null, end_date: null } : { ...r.w, start_date: r.start_date, end_date: r.end_date },
      today,
    );
  const extents = datedRows.map((r) => partsOf(r)?.extent ?? { from: toDay(r.start_date), to: toDay(r.end_date) + 1 });
  for (const r of rows) {
    if (r.type === "unplaced") for (const mk of r.marks) extents.push({ from: toDay(mk.date), to: toDay(mk.date) + 1 });
  }
  for (const marks of placed.values()) {
    for (const mk of marks) if (mk.date) extents.push({ from: toDay(mk.date), to: toDay(mk.date) + 1 });
  }

  let min = Math.min(...extents.map((e) => e.from));
  let max = Math.max(...extents.map((e) => e.to));

  min -= 3;
  max += 3;
  if (max - min < 42) {
    // short ranges: widen symmetrically so bars stay readable
    const pad = Math.ceil((42 - (max - min)) / 2);
    min -= pad;
    max += pad;
  }

  const span = max - min;
  const LABEL = 240;
  const ROW = 30;
  const TOP = 34;
  const dayW = Math.max(4, Math.min(40, 900 / span));
  const width = LABEL + span * dayW + 10;
  const height = TOP + rows.length * ROW + 10;
  const x = (day) => LABEL + (day - min) * dayW;

  const svg = s("svg", {
    class: "gantt",
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": t("ganttTitle"),
  });

  // week grid (Mondays) for short ranges, month grid otherwise
  if (span <= 120) {
    const dm = new Intl.DateTimeFormat(INTL_LOCALE, { day: "2-digit", month: "2-digit", timeZone: "UTC" });
    // 1970-01-01 was a Thursday → Monday = day % 7 === 4
    for (let day = min + ((4 - (min % 7) + 7) % 7); day <= max; day += 7) {
      svg.append(
        s("line", { class: "grid-line", x1: x(day), x2: x(day), y1: TOP - 6, y2: height }),
        s("text", { x: x(day) + 3, y: 13 }, dm.format(new Date(day * DAY))),
      );
    }
  }

  const first = new Date(min * DAY);
  for (
    let d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
    d.getTime() / DAY <= max;
    d.setUTCMonth(d.getUTCMonth() + 1)
  ) {
    const day = d.getTime() / DAY;
    if (day < min || span <= 120) continue;
    svg.append(
      s("line", { class: "grid-line", x1: x(day), x2: x(day), y1: TOP - 6, y2: height }),
      s("text", { x: x(day) + 4, y: 13 }, monthFmt().format(d)),
    );
  }

  const rowIndex = new Map();
  rows.forEach((r, i) => rowIndex.set(r, i));

  const wpPoint = (row, side) => {
    const day = side === "right" ? toDay(row.end_date) + 1 : toDay(row.start_date);
    return {
      x: x(day),
      y: TOP + rowIndex.get(row) * ROW + ROW / 2,
    };
  };

  const pointFor = wpPoint;
  const markX = (mk) =>
    mk.kind === "gate" ? x((partsOf(mk.row)?.extent ?? { from: toDay(mk.row.start_date) }).from) - 4 : x(toDay(mk.date) + 0.5);

  if (showDeps) {
    const defs = s(
      "defs",
      {},
      s(
        "marker",
        {
          id: "gantt-arrow",
          viewBox: "0 0 6 6",
          refX: 6,
          refY: 3,
          markerWidth: 6,
          markerHeight: 6,
          orient: "auto",
          markerUnits: "userSpaceOnUse",
        },
        s("path", { class: "dep-head", d: "M 0 0 L 6 3 L 0 6 z" }),
      ),
      s(
        "marker",
        {
          id: "gantt-arrow-issue",
          viewBox: "0 0 6 6",
          refX: 6,
          refY: 3,
          markerWidth: 6,
          markerHeight: 6,
          orient: "auto",
          markerUnits: "userSpaceOnUse",
        },
        s("path", { class: "dep-head issue", d: "M 0 0 L 6 3 L 0 6 z" }),
      ),
    );
    svg.append(defs);

    const edges = [];

    for (const w of allWps) {
      const target = visibleByWp.get(w.id);
      if (!target) continue;
      for (const depId of w.depends_ids || []) {
        const source = visibleByWp.get(depId);
        if (source && source !== target) edges.push([source, target, depId, w.id]);
      }
    }

    const isCritical = (row) => row.w.critical;
    const arrow = (d, conflict, crit) =>
      svg.append(
        s("path", {
          class: `dep${conflict ? " issue" : ""}${crit ? " critical" : ""}`,
          d,
          "marker-end": conflict ? "url(#gantt-arrow-issue)" : "url(#gantt-arrow)",
        }),
      );
    // R6: WP -> milestone diamond / gate flags
    for (const { from, mark, fromId, toId } of markEdges(placed, (id) => visibleByWp.get(id))) {
      const start = pointFor(from, "right");
      const cy = TOP + rowIndex.get(mark.row) * ROW + ROW / 2;
      const half = markHalf(mark.kind, milestoneState(mark.m, today) === "done");
      arrow(
        markArrowPath(start.x, start.y, markX(mark), cy, half),
        issueKeys.has(`${fromId}>${toId}`),
        showCritical && isCritical(from) && mark.m.critical,
      );
    }
    for (const [sourceRow, targetRow, fromId, toId] of edges) {
      const start = pointFor(sourceRow, "right");
      const end = pointFor(targetRow, "left");
      const conflict = issueKeys.has(`${fromId}>${toId}`);
      const crit = showCritical && isCritical(sourceRow) && isCritical(targetRow);
      svg.append(
        s("path", {
          class: `dep${conflict ? " issue" : ""}${crit ? " critical" : ""}`,
          d: `M ${start.x} ${start.y} H ${start.x + 6} V ${end.y} H ${end.x}`,
          "marker-end": conflict ? "url(#gantt-arrow-issue)" : "url(#gantt-arrow)",
        }),
      );
    }
  }

  const drawMark = (mk, cx, y) => {
    const cy = y + ROW / 2;
    const m = mk.m;
    const state = milestoneState(m, today);
    const crit = showCritical && m.critical ? " critical" : "";
    const gateText = m.gate ? ` · ${t("ganttGate")}: ${t(`decisionState.${m.decision_state}`)}` : "";
    const tip = () =>
      s(
        "title",
        {},
        barTooltip(
          `${mk.label} ${m.title}${mk.date ? `: ${fmtDate(mk.date)}` : ""} · ${milestoneStateLabel(state)}${gateText}`,
          m,
          titleOf,
        ),
      );
    if (mk.kind === "gate") {
      const top = cy - 9;
      const bot = cy + 9;
      svg.append(
        s(
          "g",
          { class: `gate-mark decision-${m.decision_state}${crit}` },
          s("path", { class: "gate-pole", d: `M${cx},${bot} V${top}` }),
          s("path", { class: "gate-flag", d: `M${cx},${top} h8 l-3,4 l3,4 h-8 z` }),
          s("text", { class: "mark-label", x: cx - 3, y: cy + 4, "text-anchor": "end" }, mk.label),
          tip(),
        ),
      );
      return;
    }
    const half = state === "done" ? 10 : 8;
    if (showBaseline && m.baseline_end && m.baseline_end !== mk.date)
      svg.append(ghostDiamond(s, { cx: x(toDay(m.baseline_end) + 0.5), cy, half: 5 }));
    svg.append(
      s(
        "g",
        {},
        s("polygon", {
          class: `ms ms-${state}${crit}`,
          points: `${cx},${cy - half} ${cx + half},${cy} ${cx},${cy + half} ${cx - half},${cy}`,
        }),
        s("text", { class: "mark-label", x: cx + half + 3, y: cy + 4 }, mk.label),
        tip(),
      ),
    );
  };

  const drawRow = (r, i) => {
    const y = TOP + i * ROW;

    if (r.type === "project") {
      svg.append(
        s("rect", { class: "proj-row", x: 0, y, width, height: ROW }),
        s("text", { class: "proj-label", x: 8, y: y + 20 }, truncate(r.p.title, 34)),
      );
      return;
    }

    if (r.type === "unplaced") {
      svg.append(s("text", { x: 16, y: y + 20 }, t("ganttUnplaced")));
      for (const mk of r.marks) drawMark(mk, x(toDay(mk.date) + 0.5), y);
      return;
    }

    const w = r.w;
    const parts = partsOf(r);
    const x1 = x(toDay(r.start_date));
    const x2 = x(toDay(r.end_date) + 1);
    const pct = w.status === "done" ? 100 : Math.max(0, Math.min(100, w.progress || 0));
    const range = r.actualOnly
      ? `${fmtDate(w.actual_start || w.actual_end)} – ${w.actual_end ? fmtDate(w.actual_end) : t("ganttOngoing")}`
      : `${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}`;
    const title = () => s("title", {}, barTooltip(`${w.code ? `${w.code} ${w.title}` : w.title}: ${range} · ${fmtPct(pct)}`, w, titleOf));
    const colour = catVar("w", w.bar_category);
    const barY = y + 7;
    const barH = ROW - 14;
    const rect = (cls, span, extra = {}) => {
      const el = s(
        "rect",
        { class: cls, x: x(span.from), y: barY, width: Math.max(2, x(span.to) - x(span.from)), height: barH, rx: 3, ...extra },
        title(),
      );
      const outline = cls === "bar-actual";
      el.style.setProperty("fill", outline ? "none" : colour);
      el.style.setProperty("stroke", cls.startsWith("bar-fill") ? "none" : colour);
      return el;
    };

    svg.append(
      ...[
        s("text", { x: 16 + r.depth * 14, y: y + 20 }, truncate(w.code ? `${w.code} ${w.title}` : w.title, 28 - r.depth * 2)),
        issueMark(s, { x: LABEL - 16, y: y + 20, entity: w, titleOf }),
      ].filter(Boolean),
    );
    if (showBaseline && w.baseline_start && w.baseline_end) {
      svg.append(ghostBar(s, { x1: x(toDay(w.baseline_start)), x2: x(toDay(w.baseline_end) + 1), y: y + ROW - 6, height: 4 }));
      const slip = slipMark(s, { x: x2 + 4, y: y + 20, days: w.slip_days });
      if (slip) svg.append(slip);
    }
    if (!parts) return;
    if (parts.planned) {
      const bg = rect("bar-bg", parts.planned);
      if (showCritical && w.critical) bg.classList.add("critical");
      svg.append(bg);
    }
    if (parts.progress && parts.progress.to > parts.progress.from) svg.append(rect("bar-fill", parts.progress));
    for (const [key, cls] of [
      ["solid", "bar-fill bar-actual-solid"],
      ["block", "bar-fill bar-actual-block"],
    ]) {
      if (!parts[key]) continue;
      const el = rect(cls, parts[key]);
      if (showCritical && w.critical) {
        el.classList.add("critical");
        el.style.setProperty("stroke", "var(--status-blocked)");
        el.style.setProperty("stroke-width", "3");
      }
      svg.append(el);
    }
    if (parts.actual) svg.append(rect("bar-actual", parts.actual));
    if (parts.overdue) {
      const { from, to, closed } = parts.overdue;
      const yTop = barY;
      const yBot = barY + barH;
      const d = closed
        ? `M${x(from)},${yTop} H${x(to)} V${yBot} H${x(from)}`
        : `M${x(from)},${yTop} H${x(to)} M${x(from)},${yBot} H${x(to)}`;
      const od = s("path", { class: "bar-overdue", d }, title());
      od.style.setProperty("stroke", colour);
      svg.append(od);
    }
  };

  rows.forEach((r, i) => {
    drawRow(r, i);
    const marks = r.type === "wp" ? placed.get(r) : null;
    if (!marks) return;
    const y = TOP + i * ROW;
    for (const mk of marks) drawMark(mk, markX(mk), y);
  });

  if (today >= min && today <= max) {
    svg.append(
      s("line", { class: "today", x1: x(today), x2: x(today), y1: TOP - 6, y2: height }),
      s("text", { x: x(today) + 3, y: TOP - 4 }, t("ganttToday")),
    );
  }

  return svg;
}

function legend(allMarks = []) {
  return h(
    "div.gantt-legend",
    h("strong", `${t("legend")}:`),
    ...WP_CATEGORIES.map((key) => h("span", catDot("w", key), catLabel("w", key))),
    h("span", h("span.ms-diamond.done"), t("reached")),
    h("span", h("span.ms-diamond.open"), t("msOpen")),
    h("span", h("span.ms-diamond.overdue"), t("overdue")),
    h("span", h("span.ms-diamond.gate"), t("ganttGate")),
    h("span", h("span.legend-planned"), t("ganttLegendPlanned")),
    h("span", h("span.legend-actual"), t("ganttLegendActual")),
    h("span", h("span.legend-progress"), t("ganttLegendProgress")),
    h("span", h("span.legend-overdue"), t("ganttLegendOverdue")),
    h("span", h("span.legend-ghost"), t("ganttBaseline")),
    h("span", h("span.legend-critical"), t("ganttCritical")),
    h("span", h("span.legend-issue", { "aria-hidden": "true" }, "⚠"), t("ganttIssues")),
    allMarks.length
      ? h(
          "ul.gantt-marklist",
          allMarks.map((mk) => h("li", `${mk.label} ${mk.m.title}${mk.date ? ` (${fmtDate(mk.date)})` : ""}`)),
        )
      : null,
  );
}

const truncate = (str, n) => (str.length > n ? `${str.slice(0, Math.max(1, n - 1))}…` : str);
