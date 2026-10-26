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
  } catch {
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
      const count = summary[key].count;
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

export async function renderUpcoming(main, state) {
  clear(main, h("p", {}, t("loading")));

  let rows;
  try {
    rows = await api.upcomingWps({ limit: 100 });
  } catch (error) {
    toastError(error);
    return;
  }

  const toolbar = h("div.toolbar", {}, h("h2", {}, t("upcomingTitle")), h("p.meta", {}, t("upcomingHint")));

  if (rows.length === 0) {
    clear(main, toolbar, h("p.empty", {}, t("upcomingEmpty")));
    return;
  }

  clear(main, toolbar, wpTable(rows, false));
}

export async function renderMyWps(main, state) {
  clear(main, h("p", {}, t("loading")));

  let rows;
  try {
    rows = await api.myWps({
      sort: mineSort,
      assigned_only: mineAssignedOnly ? 1 : "",
    });
  } catch (error) {
    toastError(error);
    return;
  }

  const sortValues = ["project", "in_progress", "start", "end"];

  const sortSelect = h(
    "select",
    {
      "aria-label": t("mineSortLabel"),
      on: {
        change: (event) => {
          mineSort = event.currentTarget.value;
          renderMyWps(main, state);
        },
      },
    },
    sortValues.map((value) =>
      h(
        "option",
        {
          value,
          selected: mineSort === value,
        },
        t(`mineSort.${value}`),
      ),
    ),
  );

  const assignedCheckbox = h("input", {
    type: "checkbox",
    checked: mineAssignedOnly,
    on: {
      change: (event) => {
        mineAssignedOnly = event.currentTarget.checked;
        renderMyWps(main, state);
      },
    },
  });

  const toolbar = h(
    "div.toolbar",
    {},
    h("h2", {}, t("mineTitle")),
    sortSelect,
    h("label.check", {}, assignedCheckbox, t("mineAssignedOnly")),
  );

  if (rows.length === 0) {
    clear(main, toolbar, h("p.empty", {}, t("mineEmpty")));
    return;
  }

  clear(main, toolbar, wpTable(rows, true));
}
