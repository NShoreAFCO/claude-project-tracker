import { h, statusChip, personBadge, progressBar } from "./dom.js";
import { t, fmtDate, fmtDateTime } from "./i18n.js";
import { lateness, lateChip } from "./lateness.js";
import { healthChip, healthLine } from "./health.js";
import { catDot } from "./categories.js";

export const LIST_COLUMNS = ["health", "project", "status", "target", "next", "progress", "owner", "wps", "activity"];

const cell = (...children) => h("td", ...children);

function wpCounts(counts = {}) {
  const open = counts.open ?? 0;
  const inProgress = counts.in_progress ?? 0;
  const waitingBlocked = counts.waiting_blocked ?? 0;
  const done = counts.done ?? 0;

  return h(
    "span.wp-counts",
    {
      title: [
        t("list.wp.open", { n: open }),
        t("list.wp.in_progress", { n: inProgress }),
        t("list.wp.waiting_blocked", { n: waitingBlocked }),
        t("list.wp.done", { n: done }),
      ].join(" / "),
    },
    `${open} / ${inProgress} / ${waitingBlocked} / ${done}`,
  );
}

function projectRow(project, persons, onOpen) {
  const open = () => onOpen(project.id);
  const title = h(
    "button.list-link",
    {
      type: "button",
      on: {
        click: (event) => {
          event.stopPropagation();
          open();
        },
      },
    },
    project.title,
  );

  const projectCell = cell(
    h(
      "div.list-project",
      catDot("p", project.category),
      title,
    ),
    healthLine(project.health),
  );

  const targetInfo = lateness(project.target_date, project.status === "active" ? "open" : "done");
  const milestone = project.next_milestone;
  const owner =
    project.owner_id || project.owner_initials
      ? personBadge({
          initials: project.owner_initials,
          name: persons.get(project.owner_id) || project.owner_initials,
        })
      : null;

  return h(
    "tr.list-row",
    {
      dataset: { id: project.id },
      on: { click: open },
    },
    cell(healthChip(project.health)),
    projectCell,
    cell(statusChip(project.status)),
    cell(fmtDate(project.target_date), lateChip(targetInfo)),
    milestone
      ? cell(
          h("div.list-next-title", milestone.title),
          h("div.list-next-date", fmtDate(milestone.due_date), lateChip(lateness(milestone.due_date, "open"))),
        )
      : cell(t("none")),
    cell(progressBar(project.progress)),
    cell(owner),
    h("td.num", wpCounts(project.wp_counts)),
    cell(fmtDateTime(project.last_activity)),
  );
}

/**
 * @param {Array<object>} projects dashboard project cards, already filtered and sorted by the caller
 * @param {{ persons: Map<string,string>, onOpen: (id: string) => void }} opts
 * @returns {HTMLElement} table.list-view
 */
export function listView(projects, { persons, onOpen }) {
  const head = h(
    "thead",
    h(
      "tr",
      LIST_COLUMNS.map((key) => h("th", { scope: "col" }, t(`list.col.${key}`))),
    ),
  );

  const body = h("tbody");
  if (projects.length) {
    body.append(...projects.map((project) => projectRow(project, persons, onOpen)));
  } else {
    body.append(h("tr", h("td.empty", { colspan: LIST_COLUMNS.length }, t("list.empty"))));
  }

  return h("table.list-view", head, body);
}
