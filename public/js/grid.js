// Grid view: one card per project (SPEC §9).
import { t, fmtDate, fmtDateTime, STRINGS } from "./i18n.js";
import { h, clear, statusChip, progressBar } from "./dom.js";
import { openProject } from "./project.js";
import { projectForm } from "./forms.js";
import { PROJECT_CATEGORIES, catVar, catDot, catLabel, knownCategory } from "./categories.js";

const PROJECT_STATUSES = ["idea", "active", "on_hold", "done", "abandoned"];

function card(p) {
  return h(
    "article.card",
    {
      class: `st-${p.status}`,
      style: { "--stripe": catVar("p", p.category) },
      on: { click: () => openProject(p.id) },
    },
    h(
      "div.head",
      h("h2", h("button.card-link", { type: "button" }, p.title)),
      h(
        "span",
        { title: t(`origin.${p.origin}`), "aria-label": `${t("originLabel")}: ${t(`origin.${p.origin}`)}` },
        STRINGS.originIcon[p.origin] || "",
      ),
    ),
    h("div", statusChip(p.status)),
    p.summary ? h("p.summary", p.summary) : null,
    progressBar(p.progress),
    h(
      "div.meta",
      h("span", t("target"), ": ", h("b", fmtDate(p.target_date))),
      h("span", t("openBranches"), ": ", h("b", String(p.open_branches))),
      h(
        "span",
        t("wpCountsLabel"),
        ": ",
        h("b", { title: t("wpOpen") }, String(p.wp_counts.open)),
        " / ",
        h("b", { title: t("wpStarted") }, String(p.wp_counts.started)),
        " / ",
        h("b", { title: t("wpDone") }, String(p.wp_counts.done)),
      ),
      h("span", t("contextDocs"), ": ", h("b", String(p.context_docs))),
      h("span", t("lastActivity"), ": ", h("b", fmtDateTime(p.last_activity))),
    ),
    p.next_milestone
      ? h(
          "p.next-ms",
          t("nextMilestone"),
          ": ",
          h("b", p.next_milestone.title),
          p.next_milestone.due_date ? ` (${fmtDate(p.next_milestone.due_date)})` : null,
        )
      : null,
    p.blocked?.length
      ? h(
          "div",
          p.blocked.map((b) => h("span.badge.blocked", `${t("blockedBy")}: ${b}`)),
        )
      : null,
  );
}

export function renderGrid(main, state) {
  const { filter } = state;
  const category = filter.category || "";
  const tags = [...new Set(state.projects.flatMap((p) => p.tags || []))].sort();

  const categorySel = h(
    "select",
    { "aria-label": t("filterCategory"), on: { change: (e) => ((filter.category = e.target.value), renderGrid(main, state)) } },
    h("option", { value: "" }, t("allCategories")),
    PROJECT_CATEGORIES.map((key) => h("option", { value: key }, catLabel("p", key))),
    h("option", { value: "none" }, t("noCategory")),
  );
  categorySel.value = category;

  const statusSel = h(
    "select",
    { "aria-label": t("filterStatus"), on: { change: (e) => ((filter.status = e.target.value), renderGrid(main, state)) } },
    h("option", { value: "" }, `${t("filterStatus")}: ${t("filterAll")}`),
    PROJECT_STATUSES.map((s) => h("option", { value: s }, t(`status.${s}`))),
  );
  statusSel.value = filter.status;

  const tagSel = h(
    "select",
    { "aria-label": t("filterTag"), on: { change: (e) => ((filter.tag = e.target.value), renderGrid(main, state)) } },
    h("option", { value: "" }, `${t("filterTag")}: ${t("filterAll")}`),
    tags.map((x) => h("option", { value: x }, x)),
  );
  tagSel.value = filter.tag;

  const shown = state.projects.filter(
    (p) =>
      (!filter.status || p.status === filter.status) &&
      (!filter.tag || (p.tags || []).includes(filter.tag)) &&
      (!category || (category === "none" ? p.category === null : p.category === category)),
  );

  const categoryBlocks = [...PROJECT_CATEGORIES, null]
    .map((key) => {
      const projects = shown.filter((p) => knownCategory("p", p.category) === key);
      if (!projects.length) return null;

      const label = catLabel("p", key);
      return h(
        "section.cat-block",
        { "aria-label": label },
        h("header.cat-head", catDot("p", key), h("h2", label), h("span.count", String(projects.length))),
        h("div.cards", projects.map(card)),
      );
    })
    .filter(Boolean);

  clear(
    main,
    h(
      "div.toolbar",
      h("div", { style: { "min-width": "160px" } }, categorySel),
      h("div", { style: { "min-width": "180px" } }, statusSel),
      h("div", { style: { "min-width": "160px" } }, tagSel),
      h("span.spacer"),
      h("button.btn", { type: "button", on: { click: () => projectForm(null) } }, `+ ${t("newProject")}`),
    ),
    shown.length ? categoryBlocks : h("p.empty", t("noProjects")),
  );
}
