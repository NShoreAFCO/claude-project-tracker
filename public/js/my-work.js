import { h, statusChip } from "./dom.js";
import { t, fmtDate, fmtDateTime } from "./i18n.js";
import { lateness, lateChip } from "./lateness.js";
import { compareCode } from "./order.js";

export const SECTIONS = ["decisions", "overdue", "due14", "blocked", "recent"];

const DAY_MS = 86400000;

const compareText = (a, b) => {
  const x = a ?? "";
  const y = b ?? "";
  return x < y ? -1 : x > y ? 1 : 0;
};

const addDays = (ymd, days) => {
  const [year, month, day] = ymd.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

/**
 * Pure: splits work packages into sections. A WP goes into the FIRST of overdue, due14, blocked that fits.
 * overdue: end_date before today. due14: end_date from today to today + 14 days (both included).
 * blocked: status "waiting" or "blocked". Rows with status "done" or "dropped" are left out. Others are left out too.
 * @param {Array<object>} wps rows of GET /api/workpackages/mine
 * @param {string} today "YYYY-MM-DD" (UTC)
 * @returns {{ overdue: object[], due14: object[], blocked: object[] }}
 * overdue and due14 sorted by end_date, then project_title, then code (compareCode); blocked by project_title, code
 */
export function splitWork(wps, today) {
  const result = {
    overdue: [],
    due14: [],
    blocked: [],
  };
  const lastDueDate = addDays(today, 14);

  for (const wp of wps ?? []) {
    if (wp.status === "done" || wp.status === "dropped") continue;

    const endDate = typeof wp.end_date === "string" ? wp.end_date.slice(0, 10) : null;
    if (endDate && endDate < today) {
      result.overdue.push(wp);
    } else if (endDate && endDate >= today && endDate <= lastDueDate) {
      result.due14.push(wp);
    } else if (wp.status === "waiting" || wp.status === "blocked") {
      result.blocked.push(wp);
    }
  }

  const byDate = (a, b) =>
    compareText(a.end_date, b.end_date) ||
    compareText(a.project_title, b.project_title) ||
    compareCode(a.code, b.code);
  const byProject = (a, b) =>
    compareText(a.project_title, b.project_title) || compareCode(a.code, b.code);

  result.overdue.sort(byDate);
  result.due14.sort(byDate);
  result.blocked.sort(byProject);

  return result;
}

const projectButton = (projectId, onOpen, ...children) =>
  h(
    "button.mw-link",
    {
      type: "button",
      on: { click: () => onOpen(projectId) },
    },
    children,
  );

const row = (projectId, button) =>
  h("li.mw-row", { dataset: { project: projectId } }, button);

const decisionRow = (gate, onOpen) =>
  row(
    gate.project_id,
    projectButton(
      gate.project_id,
      onOpen,
      h("span.mw-title", gate.title),
      h("span.mw-project", gate.project_title),
      h(
        "span.mw-date",
        gate.reached ? t("mw.reached") : fmtDate(gate.due_date),
      ),
      gate.reached ? null : lateChip(lateness(gate.due_date, "open")),
    ),
  );

const workPackageRow = (wp, onOpen) =>
  row(
    wp.project_id,
    projectButton(
      wp.project_id,
      onOpen,
      h("span.mw-code", wp.code),
      h("span.mw-title", wp.title),
      h("span.mw-project", wp.project_title),
      statusChip(wp.status),
      h("span.mw-date", fmtDate(wp.end_date)),
      lateChip(lateness(wp.end_date, wp.status)),
    ),
  );

const recentRow = (event, onOpen) =>
  row(
    event.project_id,
    projectButton(
      event.project_id,
      onOpen,
      h("span.mw-date", fmtDateTime(event.ts)),
      h("span.mw-person", event.person_name || event.actor),
      h("span.mw-project", event.project_title),
      event.wp_code ? h("span.mw-code", event.wp_code) : null,
      h("span.mw-summary", event.summary),
    ),
  );

const renderSection = (key, rows) =>
  h(
    "section.mw-section",
    { dataset: { section: key } },
    h("h3", t(`mw.${key}`), h("span.mw-count", String(rows.length))),
    rows.length
      ? h("ul.mw-list", rows)
      : h("p.empty", t(`mw.empty.${key}`)),
  );

/**
 * @param {{ gates: object[], wps: object[], recent: object[] }} data
 * @param {{ today: string, onOpen: (projectId: string) => void }} opts
 * @returns {HTMLElement} div.my-work with one section.mw-section per SECTIONS entry, in that order
 */
export function myWorkSections(data, { today, onOpen }) {
  const work = splitWork(data?.wps ?? [], today);

  const decisions = [...(data?.gates ?? [])].sort(
    (a, b) =>
      Number(Boolean(b.reached)) - Number(Boolean(a.reached)) ||
      Number(!a.due_date) - Number(!b.due_date) ||
      compareText(a.due_date, b.due_date) ||
      compareText(a.project_title, b.project_title),
  );

  const recent = [...(data?.recent ?? [])]
    .sort((a, b) => compareText(b.ts, a.ts))
    .slice(0, 20);

  const rows = {
    decisions: decisions.map((gate) => decisionRow(gate, onOpen)),
    overdue: work.overdue.map((wp) => workPackageRow(wp, onOpen)),
    due14: work.due14.map((wp) => workPackageRow(wp, onOpen)),
    blocked: work.blocked.map((wp) => workPackageRow(wp, onOpen)),
    recent: recent.map((event) => recentRow(event, onOpen)),
  };

  return h(
    "div.my-work",
    SECTIONS.map((key) => renderSection(key, rows[key])),
  );
}
