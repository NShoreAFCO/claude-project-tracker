// Hand-rolled SVG Gantt (SPEC §9). Only work packages with dates get a bar; dates are never invented.
import { t, fmtDate, fmtPct, INTL_LOCALE } from "./i18n.js";
import { api } from "./api.js";
import { h, clear, statusChip, toastError } from "./dom.js";
import { openProject } from "./project.js";
import { WP_CATEGORIES, catVar, catDot, catLabel } from "./categories.js";
import { collectIssues } from "./schedule-ui.js";
import { issueEdgeKeys, ghostBar, ghostDiamond, gateRing, issueMark, slipMark, barTooltip } from "./gantt-marks.js";

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
const months = new Intl.DateTimeFormat(INTL_LOCALE, { month: "short", year: "2-digit", timeZone: "UTC" });

let selected = "";
let level = "all";
let showDeps = true;
let showBaseline = false;
let showCritical = false;

/** Query of the current hash route (#/gantt?project=<id>): the project filter lives in the URL. */
const hashParams = () => new URLSearchParams(location.hash.split("?")[1] || "");

const milestoneDate = (m) => m.due_date || (m.done && m.reached_at ? m.reached_at.slice(0, 10) : null);

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

  const rows = [];
  const undated = [];
  const visibleByWp = new Map();
  const allWps = [];
  const milestones = [];
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

    const walkAll = (w, depth, top) => {
      allWps.push(w);
      const validOwn = w.start_date && w.end_date && w.end_date >= w.start_date;

      if (level === "main") {
        if (depth === 0) {
          const span = validOwn ? { start_date: w.start_date, end_date: w.end_date } : collectDescendantSpan(w);
          if (span) {
            const row = { type: "wp", w, depth: 0, p, start_date: span.start_date, end_date: span.end_date };
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

      if (validOwn) {
        const row = {
          type: "wp",
          w,
          depth,
          p,
          start_date: w.start_date,
          end_date: w.end_date,
        };
        projectRows.push(row);
        visibleByWp.set(w.id, row);
      } else {
        undated.push({ type: "wp", w, p });
      }

      for (const child of w.children || []) walkAll(child, depth + 1, null);
    };

    for (const w of roots) walkAll(w, 0, null);

    for (const m of projectMilestones) {
      const date = milestoneDate(m);
      const entry = { m, p };
      milestones.push(entry);
      if (date) projectRows.push({ type: "milestone", m, p, date });
      else undated.push({ type: "milestone", m, p });
    }

    if (projectRows.length) rows.push({ type: "project", p }, ...projectRows);
  }

  const body = [];
  if (!rows.length) {
    body.push(h("p.empty", t("ganttEmpty")));
  } else {
    body.push(
      showBaseline && noBaseline ? h("p.meta", { role: "status" }, t("ganttNoBaseline")) : null,
      h("div.gantt-wrap", chart(rows, visibleByWp, allWps, milestones, opts)),
      legend(),
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

function chart(rows, visibleByWp, allWps, milestones, { titleOf, issueKeys }) {
  const datedRows = rows.filter((r) => r.type === "wp" || r.type === "milestone");
  const today = Math.floor(Date.now() / DAY);

  let min = Math.min(...datedRows.map((r) => (r.type === "wp" ? toDay(r.start_date) : toDay(r.date))));
  let max = Math.max(...datedRows.map((r) => (r.type === "wp" ? toDay(r.end_date) + 1 : toDay(r.date) + 1)));

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
        s("text", { x: x(day) + 3, y: 18 }, dm.format(new Date(day * DAY))),
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
      s("text", { x: x(day) + 4, y: 18 }, months.format(d)),
    );
  }

  const rowIndex = new Map();
  rows.forEach((r, i) => rowIndex.set(r, i));

  const milestoneRows = new Map();
  for (const r of rows) {
    if (r.type === "milestone") milestoneRows.set(r.m.id, r);
  }

  const wpPoint = (row, side) => {
    const day = side === "right" ? toDay(row.end_date) + 1 : toDay(row.start_date);
    return {
      x: x(day),
      y: TOP + rowIndex.get(row) * ROW + ROW / 2,
    };
  };

  const msPoint = (row, side) => {
    const state = milestoneState(row.m, today);
    const half = state === "done" ? 10 : 8;
    const center = x(toDay(row.date) + 0.5);
    return {
      x: center + (side === "right" ? half : -half),
      y: TOP + rowIndex.get(row) * ROW + ROW / 2,
    };
  };

  const pointFor = (row, side) => (row.type === "milestone" ? msPoint(row, side) : wpPoint(row, side));

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

    for (const { m } of milestones) {
      const msRow = milestoneRows.get(m.id);
      if (!msRow) continue;

      for (const wpId of m.requires || []) {
        const source = visibleByWp.get(wpId);
        if (source && source !== msRow) edges.push([source, msRow, wpId, m.id]);
      }

      for (const wpId of m.unlocks || []) {
        const target = visibleByWp.get(wpId);
        if (target && target !== msRow) edges.push([msRow, target, m.id, wpId]);
      }
    }

    const isCritical = (row) => (row.type === "milestone" ? row.m.critical : row.w.critical);
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

  rows.forEach((r, i) => {
    const y = TOP + i * ROW;

    if (r.type === "project") {
      svg.append(
        s("rect", { class: "proj-row", x: 0, y, width, height: ROW }),
        s("text", { class: "proj-label", x: 8, y: y + 20 }, truncate(r.p.title, 34)),
      );
      return;
    }

    if (r.type === "milestone") {
      const state = milestoneState(r.m, today);
      const half = state === "done" ? 10 : 8;
      const cx = x(toDay(r.date) + 0.5);
      const cy = y + ROW / 2;
      const gateText = r.m.gate ? ` · ${t("ganttGate")}: ${t(`decisionState.${r.m.decision_state}`)}` : "";
      const diamond = s(
        "polygon",
        {
          class: `ms ms-${state}${showCritical && r.m.critical ? " critical" : ""}`,
          points: `${cx},${cy - half} ${cx + half},${cy} ${cx},${cy + half} ${cx - half},${cy}`,
        },
        s("title", {}, barTooltip(`${r.m.title}: ${fmtDate(r.date)} · ${milestoneStateLabel(state)}${gateText}`, r.m, titleOf)),
      );

      svg.append(
        ...[
          s("text", { x: 16, y: y + 20 }, truncate(r.m.title, 28)),
          issueMark(s, { x: LABEL - 16, y: y + 20, entity: r.m, titleOf }),
        ].filter(Boolean),
      );
      if (showBaseline && r.m.baseline_end && r.m.baseline_end !== r.date) {
        svg.append(ghostDiamond(s, { cx: x(toDay(r.m.baseline_end) + 0.5), cy, half: 5 }));
      }
      if (r.m.gate) {
        const ring = gateRing(s, { cx, cy, half });
        ring.classList.add(`decision-${r.m.decision_state}`);
        svg.append(ring);
      }
      svg.append(diamond);
      return;
    }

    const w = r.w;
    const x1 = x(toDay(r.start_date));
    const x2 = x(toDay(r.end_date) + 1);
    const pct = w.status === "done" ? 100 : Math.max(0, Math.min(100, w.progress || 0));
    const title = s("title", {}, barTooltip(`${w.title}: ${fmtDate(r.start_date)} – ${fmtDate(r.end_date)} · ${fmtPct(pct)}`, w, titleOf));
    const colour = catVar("w", w.bar_category);

    const bg = s(
      "rect",
      {
        class: "bar-bg",
        x: x1,
        y: y + 7,
        width: Math.max(2, x2 - x1),
        height: ROW - 14,
        rx: 3,
        "fill-opacity": 0.3,
      },
      title,
    );
    if (showCritical && w.critical) bg.classList.add("critical");
    bg.style.setProperty("fill", colour);
    bg.style.setProperty("stroke", colour);

    const fill = s("rect", {
      class: "bar-fill",
      x: x1,
      y: y + 7,
      width: Math.max(0, ((x2 - x1) * pct) / 100),
      height: ROW - 14,
      rx: 3,
    });
    fill.style.setProperty("fill", colour);

    svg.append(
      ...[
        s("text", { x: 16 + r.depth * 14, y: y + 20 }, truncate(w.title, 28 - r.depth * 2)),
        issueMark(s, { x: LABEL - 16, y: y + 20, entity: w, titleOf }),
      ].filter(Boolean),
    );
    if (showBaseline && w.baseline_start && w.baseline_end) {
      svg.append(ghostBar(s, { x1: x(toDay(w.baseline_start)), x2: x(toDay(w.baseline_end) + 1), y: y + ROW - 6, height: 4 }));
      const slip = slipMark(s, { x: x2 + 4, y: y + 20, days: w.slip_days });
      if (slip) svg.append(slip);
    }
    svg.append(bg, fill);
  });

  if (today >= min && today <= max) {
    svg.append(
      s("line", { class: "today", x1: x(today), x2: x(today), y1: TOP - 6, y2: height }),
      s("text", { x: x(today) + 3, y: TOP - 8 }, t("ganttToday")),
    );
  }

  return svg;
}

function legend() {
  return h(
    "div.gantt-legend",
    h("strong", `${t("legend")}:`),
    ...WP_CATEGORIES.map((key) => h("span", catDot("w", key), catLabel("w", key))),
    h("span", h("span.ms-diamond.done"), t("reached")),
    h("span", h("span.ms-diamond.open"), t("msOpen")),
    h("span", h("span.ms-diamond.overdue"), t("overdue")),
    h("span", h("span.ms-diamond.gate"), t("ganttGate")),
    h("span", h("span.legend-ghost"), t("ganttBaseline")),
    h("span", h("span.legend-critical"), t("ganttCritical")),
    h("span", h("span.legend-issue", { "aria-hidden": "true" }, "⚠"), t("ganttIssues")),
  );
}

const truncate = (str, n) => (str.length > n ? `${str.slice(0, Math.max(1, n - 1))}…` : str);
