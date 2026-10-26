import { t, fmtDate } from "./i18n.js";
import { api } from "./api.js";
import { h, clear, statusChip, progressBar, personBadge, toastError } from "./dom.js";
import { openProject } from "./project.js";

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

function wpTable(rows, showStart) {
  const headers = [t("ganttProject"), t("colWp"), t("colStatus")];

  if (showStart) {
    headers.push(t("start"));
  }

  headers.push(t("fEnd"));

  if (!showStart) {
    headers.push(t("fOwner"));
  }

  headers.push(t("colProgress"));

  const today = localDateString(new Date());

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
      h(
        "tbody",
        {},
        rows.map((row) => {
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

          cells.push(h("td", {}, fmtDate(row.end_date)));

          if (!showStart) {
            cells.push(h("td", {}, ownerContent(row.effective_owner)));
          }

          cells.push(h("td", {}, progressBar(row.progress)));

          const overdue = row.end_date && row.end_date < today;

          return h(overdue ? "tr.overdue" : "tr", {}, cells);
        }),
      ),
    ),
  );
}

function ownerContent(owner) {
  if (!owner) {
    return t("noOwner");
  }

  const name = owner.name || owner.text;

  return [personBadge(owner, { label: t("fOwner") }), " ", name];
}

function localDateString(date) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

let renderSeq = 0;

/** Fetch rows for `view` and swap them in below its toolbar; a response that arrives after the route changed is dropped. */
async function renderList(main, view, makeToolbar, fetchRows, emptyKey, showStart) {
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
  clear(main, toolbar, rows.length === 0 ? h("p.empty", {}, t(emptyKey)) : wpTable(rows, showStart));
}

export function renderUpcoming(main) {
  return renderList(
    main,
    "upcoming",
    () => h("div.toolbar", {}, h("h2", {}, t("upcomingTitle")), h("p.meta", {}, t("upcomingHint"))),
    () => api.upcomingWps({ limit: 100 }),
    "upcomingEmpty",
    false,
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
    () => api.myWps({ sort: mineSort, assigned_only: mineAssignedOnly ? 1 : "" }),
    "mineEmpty",
    true,
  );
}
