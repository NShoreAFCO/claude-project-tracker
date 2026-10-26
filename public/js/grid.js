// Grid view: one card per project (SPEC §9).
import { t, fmtDate, fmtDateTime, STRINGS } from "./i18n.js";
import { h, clear, statusChip, progressBar, personBadge, ageDays } from "./dom.js";
import { openProject } from "./project.js";
import { projectForm } from "./forms.js";
import { basisLabel, riskChip, staleChip } from "./progress-view.js";
import { summaryBar } from "./portfolio.js";
import { PROJECT_CATEGORIES, catVar, catDot, catLabel, knownCategory } from "./categories.js";

const PROJECT_STATUSES = ["idea", "active", "on_hold", "done", "abandoned"];

/** Red "Blocked" (with age), amber "Waiting (n)" and "Closure due" chips of a card (spec F3). */
function flagChips(p) {
  const chips = [];
  if (p.stalled_blocked) {
    const n = ageDays(p.blocked_since);
    chips.push(h("span.chip.flag-blocked.outline", t("chipBlocked"), n === null ? null : h("span.age", t("ageDays", { n }))));
  }
  if (p.waiting_count) chips.push(h("span.chip.flag-waiting", t("chipWaiting", { n: p.waiting_count })));
  if (p.closure_due) chips.push(h("span.chip.flag-closure", { title: t("closureDueHint") }, t("closureDue")));
  chips.push(riskChip(p.risk_summary), staleChip(p.stale));
  const shown = chips.filter(Boolean);
  return shown.length ? h("div.flags", shown) : null;
}

function card(p, persons) {
  const owner = p.owner_initials ? { initials: p.owner_initials, name: persons.get(p.owner_id) || p.owner_initials } : null;
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
    h("div.status-row", statusChip(p.status), personBadge(owner, { label: t("fOwner") })),
    flagChips(p),
    p.summary ? h("p.summary", p.summary) : null,
    progressBar(p.progress),
    h("div.meta", basisLabel(p.progress_basis)),
    h(
      "div.meta",
      h("span", t("target"), ": ", h("b", fmtDate(p.target_date))),
      h("span", t("openBranches"), ": ", h("b", String(p.open_branches))),
      h(
        "span.wp-counts",
        t("wpCountsLabel"),
        ": ",
        [
          ["wpOpen", p.wp_counts.open],
          ["wpInProgress", p.wp_counts.in_progress],
          ["wpWaitingBlocked", p.wp_counts.waiting_blocked],
          ["wpDone", p.wp_counts.done],
        ].map(([key, n]) => h("span.wp-count", t(key), " ", h("b", String(n)))),
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
          p.blocked.map((b) => h("span.badge.blocked", `${t("blockedBy")}: ${b.replace(/^ext:/, "")}`)),
        )
      : null,
    h(
      "div.card-actions",
      h(
        "a.btn.small.secondary",
        { href: `#/gantt?project=${encodeURIComponent(p.id)}`, on: { click: (e) => e.stopPropagation() } },
        t("cardGantt"),
      ),
    ),
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

  // Owner filter: people who own at least one project, plus "no owner"
  const persons = new Map((state.persons || []).map((p) => [p.id, p.name]));
  const ownerIds = [...new Set(state.projects.map((p) => p.owner_id).filter(Boolean))].sort((a, b) =>
    (persons.get(a) || a).localeCompare(persons.get(b) || b),
  );
  const ownerSel = h(
    "select",
    { "aria-label": t("filterOwner"), on: { change: (e) => ((filter.owner = e.target.value), renderGrid(main, state)) } },
    h("option", { value: "" }, `${t("filterOwner")}: ${t("filterAll")}`),
    ownerIds.map((id) => h("option", { value: id }, persons.get(id) || id)),
    h("option", { value: "none" }, t("noOwner")),
  );
  ownerSel.value = filter.owner || "";

  const tagSel = h(
    "select",
    { "aria-label": t("filterTag"), on: { change: (e) => ((filter.tag = e.target.value), renderGrid(main, state)) } },
    h("option", { value: "" }, `${t("filterTag")}: ${t("filterAll")}`),
    tags.map((x) => h("option", { value: x }, x)),
  );
  tagSel.value = filter.tag;

  // Portfolio filter: a KPI tile or the select narrows the grid to that counter's projects (spec F9).
  const kpi = filter.kpi || "";
  const kpiIds = kpi && state.summary?.[kpi] ? new Set(state.summary[kpi].project_ids ?? []) : null;
  const attentionSel = h(
    "select",
    { "aria-label": t("filterAttention"), on: { change: (e) => ((filter.kpi = e.target.value), renderGrid(main, state)) } },
    h("option", { value: "" }, `${t("filterAttention")}: ${t("filterAll")}`),
    ["gates_awaiting_decision", "stale"].map((k) => h("option", { value: k }, t(`filterKpi.${k}`))),
    ["gates_awaiting_decision", "stale"].includes(kpi) ? null : kpi ? h("option", { value: kpi }, t(`kpi.${kpi}`)) : null,
  );
  attentionSel.value = kpi;

  const shown = state.projects.filter(
    (p) =>
      (!kpiIds || kpiIds.has(p.id)) &&
      (!filter.status || p.status === filter.status) &&
      (!filter.tag || (p.tags || []).includes(filter.tag)) &&
      (!filter.owner || (filter.owner === "none" ? !p.owner_initials : p.owner_id === filter.owner)) &&
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
        h(
          "div.cards",
          projects.map((p) => card(p, persons)),
        ),
      );
    })
    .filter(Boolean);

  clear(
    main,
    summaryBar(state.summary || null, kpi, (key) => ((filter.kpi = key), renderGrid(main, state))),
    h(
      "div.toolbar",
      h("div", { style: { "min-width": "160px" } }, categorySel),
      h("div", { style: { "min-width": "180px" } }, statusSel),
      h("div", { style: { "min-width": "160px" } }, tagSel),
      h("div", { style: { "min-width": "160px" } }, ownerSel),
      h("div", { style: { "min-width": "200px" } }, attentionSel),
      h("span.spacer"),
      h("button.btn", { type: "button", on: { click: () => projectForm(null) } }, `+ ${t("newProject")}`),
    ),
    shown.length ? categoryBlocks : h("p.empty", t("noProjects")),
  );
}
