import { t, fmtDate } from "./i18n.js";
import { api } from "./api.js";
import { h, clear, statusChip, progressBar, personBadge, toastError } from "./dom.js";
import { openProject } from "./project.js";
import { sortWpRows } from "./order.js";
import { lateness, lateChip } from "./lateness.js";

export const KPI_KEYS = [
  "overdue_milestones",
  "gates_awaiting_decision",
  "blocked",
  "stale",
  "schedule_issues",
  "open_high_risks",
  "missing_target_date",
  "missing_owner",
];

let mineSort = "project";
let mineAssignedOnly = false;

export async function loadSummary() {
  try {
    return await api.portfolioSummary();
  } catch (error) {
    toastError(error);
    return null;
  }
}

export function summaryBar(summary, activeKpi, onPick) {
  if (summary === null) {
    return null;
  }

  return h(
    "div.summary-bar",
    {
      role: "group",
      "aria-label": t("summaryBarLabel"),
    },
    KPI_KEYS.map((key) => {
      const count = summary[key]?.count ?? 0;
      const pressed = activeKpi === key;
      const classes = ["button.kpi", pressed ? "active" : null, count === 0 ? "zero" : null].filter(Boolean).join(".");

      return h(
        classes,
        {
          type: "button",
          "aria-pressed": String(pressed),
          on: {
            click: () => onPick(pressed ? "" : key),
          },
        },
        h("span.kpi-count", {}, String(count)),
        h("span.kpi-label", {}, t(`kpi.${key}`)),
      );
    }),
  );
}

/**
 * Splits date-ordered rows for the deadlines view: "overdue" (late today, UTC), "week" (today to today + 6 days),
 * "later" (day 7 on, or no date). Order inside a group is kept.
 */
export function groupDeadlines(rows, now = new Date()) {
  const today = utcDateString(now);
  const weekEnd = utcDateString(new Date(now.getTime() + 6 * 86400000));
  const groups = { overdue: [], week: [], later: [] };

  for (const row of rows) {
    const day = typeof row.end_date === "string" ? row.end_date.slice(0, 10) : "";

    if (lateness(row.end_date, row.status, now).late) {
      groups.overdue.push(row);
    } else if (day && day <= weekEnd) {
      groups.week.push(row);
    } else {
      groups.later.push(row);
    }
  }

  return { today, groups };
}

function wpTable(rows, showStart, grouped = null) {
  const headers = [t("ganttProject"), t("colWp"), t("colStatus")];

  if (showStart) {
    headers.push(t("start"));
  }

  headers.push(t("fEnd"));

  if (!showStart) {
    headers.push(t("fOwner"));
  }

  headers.push(t("colProgress"));

  const now = new Date();

  return h(
    "div.table-wrap",
    {},
    h(
      "table",
      {},
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          headers.map((label) => h("th", {}, label)),
        ),
      ),
      h("tbody", {}, grouped ? groupedRows(grouped, headers.length, rowEl) : rows.map(rowEl)),
    ),
  );

  function rowEl(row) {
    const cells = [
      h(
        "td",
        {},
        h(
          "button.linkbtn",
          {
            type: "button",
            on: {
              click: () => openProject(row.project_id),
            },
          },
          row.project_title,
        ),
      ),
      h("td", {}, row.title),
      h("td", {}, statusChip(row.status)),
    ];

    if (showStart) {
      cells.push(h("td", {}, fmtDate(row.start_date)));
    }

    const late = lateness(row.end_date, row.status, now);

    cells.push(h("td", {}, fmtDate(row.end_date), lateChip(late)));

    if (!showStart) {
      cells.push(h("td", {}, ownerContent(row.effective_owner)));
    }

    cells.push(h("td", {}, progressBar(row.progress)));

    return h(late.late ? "tr.overdue" : "tr", {}, cells);
  }
}

/** Table body rows for the deadlines view: group headings with counts, the Today divider after Overdue. */
function groupedRows({ today, groups }, colspan, rowEl) {
  const out = [];
  const heading = (key, label) =>
    out.push(
      h(
        "tr.group-head",
        {},
        h("th", { colspan: String(colspan), scope: "colgroup" }, `${label} (${groups[key].length})`),
      ),
    );

  if (groups.overdue.length > 0) {
    heading("overdue", t("deadlinesOverdue"));
    out.push(...groups.overdue.map(rowEl));
  }

  out.push(h("tr.today-divider", {}, h("td", { colspan: String(colspan) }, t("deadlinesToday", { date: fmtDate(today) }))));

  if (groups.week.length > 0) {
    heading("week", t("deadlinesWeek"));
    out.push(...groups.week.map(rowEl));
  }

  if (groups.later.length > 0) {
    heading("later", t("deadlinesLater"));
    out.push(...groups.later.map(rowEl));
  }

  return out;
}

function ownerContent(owner) {
  if (!owner) {
    return t("noOwner");
  }

  const name = owner.name || owner.text;

  return [personBadge(owner, { label: t("fOwner") }), " ", name];
}

/** The UTC date (YYYY-MM-DD) of `date`: the server and ageDays count overdue and ages in UTC too. */
export function utcDateString(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** Whether a work package ending on `endDate` is overdue: its end date is before today (UTC). */
export function isOverdue(endDate, now = new Date()) {
  return lateness(endDate, "open", now).late;
}

let renderSeq = 0;

/** Fetch rows for `view` and swap them in below its toolbar; a response that arrives after the route changed is dropped. */
async function renderList(main, view, makeToolbar, fetchRows, emptyKey, showStart, group = null) {
  const seq = ++renderSeq;
  const hasToolbar = main.firstElementChild?.dataset?.view === view;
  if (!hasToolbar) clear(main, h("p", {}, t("loading")));
  let rows;
  try {
    rows = await fetchRows();
  } catch (error) {
    if (seq === renderSeq) toastError(error);
    return;
  }
  if (seq !== renderSeq || !location.hash.startsWith(`#/${view}`)) return;
  const toolbar = hasToolbar ? main.firstElementChild : makeToolbar();
  toolbar.dataset.view = view;
  clear(main, toolbar, rows.length === 0 ? h("p.empty", {}, t(emptyKey)) : wpTable(rows, showStart, group ? group(rows) : null));
}

export function renderUpcoming(main) {
  return renderList(
    main,
    "upcoming",
    () => h("div.toolbar", {}, h("h2", {}, t("upcomingTitle")), h("p.meta", {}, t("upcomingHint"))),
    async () => sortWpRows(await api.upcomingWps({ limit: 100 }), "upcoming"),
    "upcomingEmpty",
    false,
    (rows) => groupDeadlines(rows),
  );
}

export function renderMyWps(main) {
  const again = () => renderMyWps(main);
  const makeToolbar = () =>
    h(
      "div.toolbar",
      {},
      h("h2", {}, t("mineTitle")),
      h(
        "select",
        {
          "aria-label": t("mineSortLabel"),
          on: { change: (event) => ((mineSort = event.currentTarget.value), again()) },
        },
        ["project", "in_progress", "start", "end"].map((value) =>
          h("option", { value, selected: mineSort === value }, t(`mineSort.${value}`)),
        ),
      ),
      h(
        "label.check",
        {},
        h("input", {
          type: "checkbox",
          checked: mineAssignedOnly,
          on: { change: (event) => ((mineAssignedOnly = event.currentTarget.checked), again()) },
        }),
        t("mineAssignedOnly"),
      ),
    );
  return renderList(
    main,
    "mine",
    makeToolbar,
    async () => sortWpRows(await api.myWps({ sort: mineSort, assigned_only: mineAssignedOnly ? 1 : "" }), mineSort),
    "mineEmpty",
    true,
  );
}
