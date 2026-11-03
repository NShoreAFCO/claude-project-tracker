// Grid view: one card per project (SPEC §9).
import { can, POLICY } from "./access.js";
import { t, fmtDate, fmtDateTime, STRINGS } from "./i18n.js";
import { h, clear, statusChip, progressBar, personBadge, ageDays } from "./dom.js";
import { openProject } from "./project.js";
import { projectForm } from "./forms.js";
import { basisLabel, riskChip, staleChip } from "./progress-view.js";
import { summaryBar } from "./portfolio.js";
import { GRID_FILTER_KEY } from "./sidebar.js";
import { PROJECT_CATEGORIES, catVar, catDot, catLabel, knownCategory } from "./categories.js";

const PROJECT_STATUSES = ["idea", "active", "on_hold", "done", "abandoned"];
const COMPLETED = ["done", "abandoned"];
const COMPLETED_MODES = ["hide", "only", "all"];
const PERSISTED = ["completed", "tags", "status", "owner"];

/** Completed mode of a filter; anything unknown (incl. the home reset's empty string) is the default `hide`. */
export function completedMode(filter) {
  return COMPLETED_MODES.includes(filter.completed) ? filter.completed : "hide";
}

/** Checked tags as an array (tolerates the home reset's empty string). */
export function checkedTags(filter) {
  return Array.isArray(filter.tags) ? filter.tags : [];
}

/** Status select options that cannot contradict the completed mode. */
export function statusOptions(mode) {
  return PROJECT_STATUSES.filter((s) => (mode === "all" ? true : mode === "only" ? COMPLETED.includes(s) : !COMPLETED.includes(s)));
}

/** Tags with the checked ones first, then the rest; each group alphabetical. */
export function orderTags(all, checked) {
  const set = new Set(checked);
  const sorted = [...new Set(all)].sort((a, b) => a.localeCompare(b));
  return [...sorted.filter((x) => set.has(x)), ...sorted.filter((x) => !set.has(x))];
}

/** Pure grid filter. `kpiIds` is a Set of project ids or null. Tags use AND semantics. */
export function filterProjects(projects, filter, kpiIds = null) {
  const mode = completedMode(filter);
  const tags = checkedTags(filter);
  const category = filter.category || "";
  return projects.filter(
    (p) =>
      (!kpiIds || kpiIds.has(p.id)) &&
      (mode === "all" || (mode === "only") === COMPLETED.includes(p.status)) &&
      (!filter.status || p.status === filter.status) &&
      tags.every((x) => (p.tags || []).includes(x)) &&
      (!filter.owner || (filter.owner === "none" ? !p.owner_initials : p.owner_id === filter.owner)) &&
      (!category || (category === "none" ? p.category === null : p.category === category)),
  );
}

export function saveGridFilter(filter, storage) {
  try {
    (storage ?? globalThis.localStorage)?.setItem(
      GRID_FILTER_KEY,
      JSON.stringify(Object.fromEntries(PERSISTED.map((k) => [k, filter[k]]))),
    );
  } catch {
    // storage unavailable: the filter just is not remembered
  }
}

/** Merge the saved filter into `filter` (only keys still unset). Returns the filter. */
export function loadGridFilter(filter, storage) {
  try {
    const saved = JSON.parse((storage ?? globalThis.localStorage)?.getItem(GRID_FILTER_KEY) || "null");
    if (saved && typeof saved === "object") {
      if (COMPLETED_MODES.includes(saved.completed) && !filter.completed) filter.completed = saved.completed;
      if (Array.isArray(saved.tags) && !checkedTags(filter).length) filter.tags = saved.tags.filter((x) => typeof x === "string");
      for (const k of ["status", "owner"]) if (typeof saved[k] === "string" && !filter[k]) filter[k] = saved[k];
    }
  } catch {
    // unreadable saved filter: ignore
  }
  return filter;
}
let hydrated = false;
/** Removes the open tag popover's document listener; a rerender discards that popover, so it must run first. */
let disposePop = null;
const FOCUS = "data-focus";

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

function gateBox(g) {
  if (!g) return null;
  return h(
    "div.underlay-gate.card-box.card-gate",
    h("div.box-label", t("gateMark")),
    h("div.box-title", g.title),
    h("div.box-sub", g.due_date ? fmtDate(g.due_date) : t("noDate"), " · ", t(`decisionState.${g.decision_state}`)),
  );
}

function card(p, persons) {
  const owner = p.owner_initials ? { initials: p.owner_initials, name: persons.get(p.owner_id) || p.owner_initials } : null;
  const noTarget = noTargetChip(p);
  const ms = p.next_milestone;
  const wp = p.wp_counts;
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
      statusChip(p.status),
      h(
        "span",
        { title: t(`origin.${p.origin}`), "aria-label": `${t("originLabel")}: ${t(`origin.${p.origin}`)}` },
        STRINGS.originIcon[p.origin] || "",
      ),
    ),
    h("div.card-target", noTarget || [t("target"), ": ", h("b", fmtDate(p.target_date))]),
    h(
      "div.underlay-wp.card-box.wp-counts",
      h("div.box-label", t("wpCountsLabel")),
      h(
        "div.box-sub",
        [
          ["wpOpen", wp.open],
          ["wpInProgress", wp.in_progress],
          ["wpWaitingBlocked", wp.waiting_blocked],
          ["wpDone", wp.done],
        ].map(([key, n]) => h("span.wp-count", t(key), " ", h("b", String(n)))),
      ),
    ),
    ms
      ? h(
          "div.underlay-milestone.card-box.next-ms",
          h("div.box-label", t("nextMilestone")),
          h("div.box-title", ms.title),
          h("div.box-sub", ms.due_date ? fmtDate(ms.due_date) : t("noDate")),
        )
      : null,
    gateBox(p.current_gate),
    h(
      "div.card-minor",
      h("div.status-row", personBadge(owner, { label: t("fOwner") })),
      flagChips(p),
      p.summary ? h("p.summary", p.summary) : null,
      progressBar(p.progress),
      h("div.meta", basisLabel(p.progress_basis)),
      h(
        "div.meta",
        h("span", t("openBranches"), ": ", h("b", String(p.open_branches))),
        h("span", t("contextDocs"), ": ", h("b", String(p.context_docs))),
        h("span", t("lastActivity"), ": ", h("b", fmtDateTime(p.last_activity))),
      ),
    ),
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

function noTargetChip(p) {
  if (p.status !== "active" || p.target_date || !POLICY.target_date_required_categories.includes(p.category)) {
    return null;
  }

  return h("span.chip.flag-waiting.flag-no-target", { title: t("noTargetDateHint") }, t("noTargetDate"));
}

/** `all` = the unfiltered project list: a category is empty only when it has no projects at all. */
function categoryBlocks(shown, persons, filter, all = shown) {
  return [...PROJECT_CATEGORIES, null]
    .map((key) => {
      const projects = shown.filter((p) => knownCategory("p", p.category) === key);
      const label = catLabel("p", key);

      if (projects.length) {
        return h(
          "section.cat-block",
          { "aria-label": label },
          h("header.cat-head", catDot("p", key), h("h2", label), h("span.count", String(projects.length))),
          h(
            "div.cards",
            projects.map((p) => card(p, persons)),
          ),
        );
      }

      // a category that has projects, hidden only by a filter, is never shown as empty
      if (all.some((p) => knownCategory("p", p.category) === key)) return null;
      if (filter.category || POLICY.hide_empty_categories === "hide" || key === null) {
        return null;
      }

      return h(
        "details.cat-block.cat-empty",
        { "aria-label": label },
        h("summary.cat-head", catDot("p", key), h("h2", label), h("span.count", "0")),
        h("p.meta", t("categoryEmpty")),
      );
    })
    .filter((block) => block !== null);
}

/**
 * `restore` = { key, popOpen }: after a rebuild, focus the control whose data-focus equals `key` (and reopen the tag
 * popover when the key belongs to it), so keyboard users keep their place.
 */
export function renderGrid(main, state, restore = null) {
  const { filter } = state;
  disposePop?.();
  disposePop = null;
  if (!hydrated) {
    hydrated = true;
    loadGridFilter(filter);
  }
  const mode = completedMode(filter);
  const checked = checkedTags(filter);
  const change = (fn) => {
    const key = document.activeElement?.getAttribute?.(FOCUS) || null;
    fn();
    if (filter.status && !statusOptions(completedMode(filter)).includes(filter.status)) filter.status = "";
    saveGridFilter(filter);
    renderGrid(main, state, key ? { key, popOpen: key.startsWith("tag-") } : null);
  };
  const category = filter.category || "";
  const tags = orderTags(
    state.projects.flatMap((p) => p.tags || []),
    checked,
  );

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
    { "aria-label": t("filterStatus"), [FOCUS]: "status", on: { change: (e) => change(() => (filter.status = e.target.value)) } },
    h("option", { value: "" }, `${t("filterStatus")}: ${t("filterAll")}`),
    statusOptions(mode).map((s) => h("option", { value: s }, t(`status.${s}`))),
  );
  statusSel.value = filter.status;

  const completedCtl = h(
    "div.seg-control",
    { role: "group", "aria-label": t("filterCompleted") },
    COMPLETED_MODES.map((m) =>
      h(
        "button.seg",
        {
          type: "button",
          [FOCUS]: `completed-${m}`,
          "aria-pressed": String(m === mode),
          on: { click: () => change(() => (filter.completed = m)) },
        },
        t(`completed.${m}`),
      ),
    ),
  );

  // Owner filter: people who own at least one project, plus "no owner"
  const persons = new Map((state.persons || []).map((p) => [p.id, p.name]));
  const ownerIds = [...new Set(state.projects.map((p) => p.owner_id).filter(Boolean))].sort((a, b) =>
    (persons.get(a) || a).localeCompare(persons.get(b) || b),
  );
  const ownerSel = h(
    "select",
    { "aria-label": t("filterOwner"), [FOCUS]: "owner", on: { change: (e) => change(() => (filter.owner = e.target.value)) } },
    h("option", { value: "" }, `${t("filterOwner")}: ${t("filterAll")}`),
    ownerIds.map((id) => h("option", { value: id }, persons.get(id) || id)),
    h("option", { value: "none" }, t("noOwner")),
  );
  ownerSel.value = filter.owner || "";

  const tagBtn = h(
    "button.btn.secondary.tag-filter-btn",
    { type: "button", [FOCUS]: "tag-btn", "aria-haspopup": "true", "aria-expanded": "false" },
    t("filterTagsBtn", { n: checked.length }),
  );
  const tagPop = h("div.tag-pop", { hidden: true, role: "group", "aria-label": t("filterTag") });
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closePop();
      tagBtn.focus();
    }
  };
  const closePop = () => {
    disposePop = null;
    tagPop.hidden = true;
    tagBtn.setAttribute("aria-expanded", "false");
    document.removeEventListener("keydown", onKey, true);
  };
  const openPop = () => {
    tagPop.hidden = false;
    tagBtn.setAttribute("aria-expanded", "true");
    document.addEventListener("keydown", onKey, true);
    disposePop = () => document.removeEventListener("keydown", onKey, true);
  };
  tagBtn.addEventListener("click", () => {
    if (!tagPop.hidden) return closePop();
    openPop();
    tagPop.querySelector("input")?.focus();
  });
  clear(
    tagPop,
    checked.length
      ? h(
          "button.btn.small.secondary.tag-clear",
          { type: "button", [FOCUS]: "tag-clear", on: { click: () => change(() => (filter.tags = [])) } },
          t("filterTagsClear"),
        )
      : null,
    tags.length ? null : h("p.meta", t("filterTagsNone")),
    tags.map((x) =>
      h(
        "label.tag-opt",
        h("input", {
          type: "checkbox",
          [FOCUS]: `tag-opt:${x}`,
          checked: checked.includes(x),
          on: {
            change: (e) => change(() => (filter.tags = e.target.checked ? [...checked, x] : checked.filter((c) => c !== x))),
          },
        }),
        " ",
        x,
      ),
    ),
  );
  const tagWrap = h("div.tag-filter", tagBtn, tagPop);

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

  const shown = filterProjects(state.projects, filter, kpiIds);

  clear(
    main,
    summaryBar(state.summary || null, kpi, (key) => ((filter.kpi = key), renderGrid(main, state))),
    h(
      "div.toolbar",
      completedCtl,
      h("div", { style: { "min-width": "160px" } }, categorySel),
      h("div", { style: { "min-width": "180px" } }, statusSel),
      tagWrap,
      h("div", { style: { "min-width": "160px" } }, ownerSel),
      h("div", { style: { "min-width": "200px" } }, attentionSel),
      h("span.spacer"),
      can("write") ? h("button.btn", { type: "button", on: { click: () => projectForm(null) } }, `+ ${t("newProject")}`) : null,
    ),
    shown.length ? categoryBlocks(shown, persons, filter, state.projects) : h("p.empty", t("noProjects")),
  );

  if (restore?.key) {
    if (restore.popOpen) openPop();
    // a control that vanished (the clear button after clearing) falls back to the tag button
    const target =
      [...main.querySelectorAll(`[${FOCUS}]`)].find((el) => el.getAttribute(FOCUS) === restore.key) ?? (restore.popOpen ? tagBtn : null);
    target?.focus();
  }
}
