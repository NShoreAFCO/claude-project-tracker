import { h, clear } from "./dom.js";
import { t, fmtDate } from "./i18n.js";
import { lateness, lateChip } from "./lateness.js";
import { api } from "./api.js";

export const KINDS = ["my_tasks", "my_human_tasks", "my_decisions", "all_decisions", "all_human_tasks", "active_projects"];

export function normalisePrefs(value) {
  return {
    version: 1,
    views: Array.isArray(value?.views) ? value.views.slice(0, 20) : [],
    active_projects: Array.isArray(value?.active_projects) ? [...value.active_projects] : [],
  };
}

function makeViewId() {
  return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.slice(0, 40);
}

/** The rows one saved view (or quick option) lists: `kind` with an optional project filter. */
export async function fetchViewRows(kind, projectId, projects, prefs) {
  const withProject = (base) => (projectId ? { ...base, project_id: projectId } : base);
  let rows;
  if (kind === "my_tasks") rows = await api.myWps(withProject({ sort: "end", assigned_only: 1 }));
  else if (kind === "my_human_tasks") rows = await api.myWps(withProject({ sort: "end", human_only: 1 }));
  else if (kind === "my_decisions") rows = await api.openGates(withProject({ scope: "me" }));
  else if (kind === "all_decisions") rows = await api.openGates(withProject({ scope: "all" }));
  else if (kind === "all_human_tasks") rows = await api.openWps(withProject({ human_only: 1, limit: 200 }));
  else rows = projects.filter((project) => prefs.active_projects.includes(project.id));
  return Array.isArray(rows) ? rows : [];
}

function personName(person) {
  return person?.name || person?.text || t("none");
}

function renderRow(kind, row, gateKind) {
  if (kind === "active_projects") {
    return h(
      "tr.mydash-row",
      h("td", h("a", { href: `#/p/${encodeURIComponent(row.id)}` }, row.title)),
      h("td", row.title),
      h("td", t(`status.${row.status}`)),
      h("td", fmtDate(row.target_date), lateChip(lateness(row.target_date, row.status === "active" ? "open" : "done"))),
      h("td", row.owner_initials || t("none")),
    );
  }

  if (gateKind) {
    return h(
      "tr.mydash-row",
      h(
        "td",
        h(
          "a",
          { href: `#/p/${encodeURIComponent(row.project_id)}` },
          row.wp_code == null ? row.title : `${row.wp_code} ${row.title}`,
        ),
      ),
      h("td", row.project_title),
      h("td", row.reached ? t("mydGateReached") : t("mydGateOpen")),
      h("td", fmtDate(row.due_date), lateChip(lateness(row.due_date, row.reached ? "reached" : "open"))),
      h("td", personName(row.decision_maker)),
    );
  }

  return h(
    "tr.mydash-row",
    h(
      "td",
      h("a", { href: `#/p/${encodeURIComponent(row.project_id)}` }, row.code == null ? row.title : `${row.code} ${row.title}`),
    ),
    h("td", row.project_title),
    h("td", t(`status.${row.status}`)),
    h("td", fmtDate(row.end_date), lateChip(lateness(row.end_date, row.status))),
    h("td", personName(row.effective_owner)),
  );
}

/** The list for one saved view's kind: a table, or the empty line. */
export function viewResults(kind, rows) {
  if (!rows.length) return h("p.empty", t("mydEmpty"));
  const gateKind = kind === "my_decisions" || kind === "all_decisions";
  return h(
    "table.mydash-table",
    h(
      "thead",
      h(
        "tr",
        h("th", t("mydColItem")),
        h("th", t("mydColProject")),
        h("th", t("mydColStatus")),
        h("th", t("mydColDue")),
        h("th", gateKind ? t("mydColDecisionMaker") : t("mydColOwner")),
      ),
    ),
    h(
      "tbody",
      rows.map((row) => renderRow(kind, row, gateKind)),
    ),
  );
}

/** Checkboxes for the projects the "active projects" option lists; `persist(mutate)` saves the change. */
export function activeProjectsPicker(projects, prefs, persist) {
  const picked = new Set(prefs.active_projects);
  return h(
    "div",
    h("h3", t("mydActiveProjects")),
    h(
      "div.mydash-projects",
      projects.map((project) =>
        h(
          "label",
          h("input.mydash-pick", {
            type: "checkbox",
            value: project.id,
            checked: picked.has(project.id),
            on: {
              change: async (event) => {
                const checked = Boolean(event.target.checked);
                await persist((current) => {
                  const next = new Set(current.active_projects);
                  if (checked) next.add(project.id);
                  else next.delete(project.id);
                  return { ...current, active_projects: [...next] };
                });
              },
            },
          }),
          project.title,
        ),
      ),
    ),
  );
}

/**
 * Preference writes are serialised: each mutation is applied to the latest acknowledged prefs when its turn
 * comes, with one PUT in flight at a time. On failure the prefs stay at the last acknowledged state.
 * `getPrefs()` / `setPrefs(next)` hold the state; `onApplied()` and `onFailed(error)` rebuild the UI.
 */
export function createPrefsQueue({ getPrefs, setPrefs, onApplied, onFailed }) {
  let queue = Promise.resolve();
  async function apply(mutate) {
    try {
      const next = mutate(getPrefs());
      if (next === getPrefs()) return;
      const result = await api.putDashboardPrefs({ version: 1, views: next.views, active_projects: next.active_projects });
      setPrefs(normalisePrefs(result?.prefs));
      await onApplied();
    } catch (e) {
      await onFailed(e);
    }
  }
  return (mutate) => {
    const run = () => apply(mutate);
    queue = queue.then(run, run);
    return queue;
  };
}

/**
 * The saved-views list with add, rename, reorder, make-default and delete.
 * `ctx`: { prefs, current() -> { kind, projectId } for "save current view", persist, onOpen(view) }.
 */
export function renderViewsPanel(host, ctx, error) {
  const { prefs, persist } = ctx;
  const showDefault = ctx.showDefault !== false;

  const moveView = (id, delta) =>
    persist((current) => {
      const from = current.views.findIndex((item) => item.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= current.views.length) return current;
      const views = current.views.slice();
      [views[from], views[to]] = [views[to], views[from]];
      return { ...current, views };
    });

  const renderView = (view, index) => {
    const first = index === 0;
    const last = index === prefs.views.length - 1;

    return h(
      "li",
      { class: first ? "is-default" : "" },
      h(
        "button.mydash-open",
        { type: "button", on: { click: () => ctx.onOpen(view) } },
        view.name,
      ),
      first && showDefault ? h("span", t("mydDefault")) : null,
      h(
        "button.mydash-rename",
        {
          type: "button",
          on: {
            click: async () => {
              const name = window.prompt(t("mydViewName"), view.name);
              if (!name || !name.trim()) return;
              await persist((current) => ({
                ...current,
                views: current.views.map((item) => (item.id === view.id ? { ...item, name: name.trim().slice(0, 80) } : item)),
              }));
            },
          },
        },
        t("mydRename"),
      ),
      h("button.mydash-up", { type: "button", disabled: first, on: { click: () => moveView(view.id, -1) } }, t("mydMoveUp")),
      h("button.mydash-down", { type: "button", disabled: last, on: { click: () => moveView(view.id, 1) } }, t("mydMoveDown")),
      h(
        "button.mydash-delete",
        {
          type: "button",
          on: {
            click: async () => {
              if (!window.confirm(t("mydConfirmDelete", { name: view.name }))) return;
              await persist((current) => ({
                ...current,
                views: current.views.filter((item) => item.id !== view.id),
              }));
            },
          },
        },
        t("delete"),
      ),
      first || !showDefault
        ? null
        : h(
            "button.mydash-default",
            {
              type: "button",
              on: {
                click: async () => {
                  await persist((current) => {
                    const at = current.views.findIndex((item) => item.id === view.id);
                    if (at < 0) return current;
                    const views = current.views.slice();
                    const [selected] = views.splice(at, 1);
                    views.unshift(selected);
                    return { ...current, views };
                  });
                },
              },
            },
            t("mydSetDefault"),
          ),
    );
  };

  clear(host, [
    h("h3", t("mydSavedViews")),
    prefs.views.length
      ? h(
          "ul.mydash-views",
          prefs.views.map((view, index) => renderView(view, index)),
        )
      : h("p", t("mydNoViews")),
    h(
      "button.mydash-save",
      {
        type: "button",
        on: {
          click: async () => {
            if (prefs.views.length >= 20) return;
            const name = window.prompt(t("mydViewName"), "");
            if (!name || !name.trim()) return;
            const { kind, projectId } = ctx.current();
            const view = {
              id: makeViewId(),
              name: name.trim().slice(0, 80),
              kind,
              project_id: kind === "active_projects" ? null : projectId || null,
            };
            await persist((current) => (current.views.length >= 20 ? current : { ...current, views: [...current.views, view] }));
          },
        },
      },
      t("mydSaveView"),
    ),
    error ? h("p.mydash-error", t("mydSaveFailed", { error: error.message })) : null,
  ]);
}

export async function renderMyDashboard(main, state) {
  void state;
  clear(main, h("p", t("loading")));

  let prefs;
  let projects;
  let kind = "my_tasks";
  let projectId = "";
  let requestId = 0;
  let resultsHost;
  let viewsPanel;

  try {
    const [prefsResult, projectRows] = await Promise.all([api.getDashboardPrefs(), api.projects()]);
    prefs = normalisePrefs(prefsResult?.prefs);
    projects = Array.isArray(projectRows) ? projectRows : [];

    const initial = prefs.views[0];
    if (initial && KINDS.includes(initial.kind)) {
      kind = initial.kind;
      projectId = initial.kind === "active_projects" ? "" : initial.project_id || "";
    }
  } catch (e) {
    showLoadError(e);
    return;
  }

  const persistPrefs = createPrefsQueue({
    getPrefs: () => prefs,
    setPrefs: (next) => {
      prefs = next;
    },
    onApplied: async () => {
      drawViewsPanel();
      if (kind === "active_projects") {
        renderShell();
        await loadRows();
      }
    },
    onFailed: async (e) => {
      // rebuild the shell so checkboxes fall back to the acknowledged preferences
      if (kind === "active_projects") {
        renderShell();
        await loadRows();
      }
      drawViewsPanel(e);
    },
  });

  renderShell();
  await loadRows();

  function showLoadError(e) {
    requestId += 1;
    clear(main, h("p.mydash-error", t("mydLoadFailed", { error: e.message })));
  }

  function renderShell() {
    resultsHost = h("div.mydash-results");
    viewsPanel = h("section.mydash-views-panel");

    clear(
      main,
      h("h2", t("mydTitle")),
      h(
        "div.mydash-kinds",
        KINDS.map((candidate) =>
          h(
            "button",
            {
              type: "button",
              class: candidate === kind ? "active" : "",
              "aria-pressed": String(candidate === kind),
              on: {
                click: () => {
                  if (candidate === kind) return;
                  kind = candidate;
                  renderShell();
                  loadRows();
                },
              },
            },
            t(`mydKind.${candidate}`),
          ),
        ),
      ),
      kind === "active_projects" ? activeProjectsPicker(projects, prefs, persistPrefs) : renderProjectBar(),
      resultsHost,
      viewsPanel,
    );

    drawViewsPanel();
  }

  function renderProjectBar() {
    return h(
      "div.mydash-bar",
      h(
        "select.mydash-project",
        {
          "aria-label": t("mydProject"),
          value: projectId,
          on: {
            change: (event) => {
              projectId = event.target.value;
              renderShell();
              loadRows();
            },
          },
        },
        h("option", { value: "", selected: projectId === "" }, t("mydAllProjects")),
        projects.map((project) =>
          h("option", { value: project.id, selected: project.id === projectId }, project.title),
        ),
      ),
    );
  }

  async function loadRows() {
    const currentRequest = ++requestId;
    clear(resultsHost, h("p", t("loading")));

    try {
      const rows = await fetchViewRows(kind, projectId, projects, prefs);
      if (currentRequest !== requestId) return;
      clear(resultsHost, viewResults(kind, rows));
    } catch (e) {
      if (currentRequest !== requestId) return;
      showLoadError(e);
    }
  }

  function drawViewsPanel(error) {
    renderViewsPanel(
      viewsPanel,
      {
        prefs,
        showDefault: true,
        current: () => ({ kind, projectId }),
        persist: persistPrefs,
        onOpen: (view) => {
          kind = KINDS.includes(view.kind) ? view.kind : "my_tasks";
          projectId = kind === "active_projects" ? "" : view.project_id || "";
          renderShell();
          loadRows();
        },
      },
      error,
    );
  }
}
