import { h, clear } from "./dom.js";
import { t, fmtDate } from "./i18n.js";
import { api } from "./api.js";

const KINDS = ["my_tasks", "my_human_tasks", "my_decisions", "all_decisions", "all_human_tasks", "active_projects"];

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

  renderShell();
  await loadRows();

  function normalisePrefs(value) {
    return {
      version: 1,
      views: Array.isArray(value?.views) ? value.views.slice(0, 20) : [],
      active_projects: Array.isArray(value?.active_projects) ? [...value.active_projects] : [],
    };
  }

  function showLoadError(e) {
    requestId += 1;
    clear(main, h("p.mydash-error", t("mydLoadFailed", { error: e.message })));
  }

  function paramsWithProject(base) {
    return projectId ? { ...base, project_id: projectId } : base;
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
      kind === "active_projects" ? renderActiveProjects() : renderProjectBar(),
      resultsHost,
      viewsPanel,
    );

    renderViewsPanel();
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

  function renderActiveProjects() {
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
                  await persistPrefs((current) => {
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

  async function loadRows() {
    const currentRequest = ++requestId;
    clear(resultsHost, h("p", t("loading")));

    try {
      let rows;
      if (kind === "my_tasks") rows = await api.myWps(paramsWithProject({ sort: "end", assigned_only: 1 }));
      else if (kind === "my_human_tasks") rows = await api.myWps(paramsWithProject({ sort: "end", human_only: 1 }));
      else if (kind === "my_decisions") rows = await api.openGates(paramsWithProject({ scope: "me" }));
      else if (kind === "all_decisions") rows = await api.openGates(paramsWithProject({ scope: "all" }));
      else if (kind === "all_human_tasks")
        rows = await api.openWps(paramsWithProject({ human_only: 1, limit: 200 }));
      else rows = projects.filter((project) => prefs.active_projects.includes(project.id));

      if (currentRequest !== requestId) return;
      renderResults(Array.isArray(rows) ? rows : []);
    } catch (e) {
      if (currentRequest !== requestId) return;
      showLoadError(e);
    }
  }

  function renderResults(rows) {
    if (!rows.length) {
      clear(resultsHost, h("p.empty", t("mydEmpty")));
      return;
    }

    const gateKind = kind === "my_decisions" || kind === "all_decisions";
    clear(
      resultsHost,
      h(
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
          rows.map((row) => renderRow(row, gateKind)),
        ),
      ),
    );
  }

  function renderRow(row, gateKind) {
    if (kind === "active_projects") {
      return h(
        "tr.mydash-row",
        h("td", h("a", { href: `#/p/${encodeURIComponent(row.id)}` }, row.title)),
        h("td", row.title),
        h("td", t(`status.${row.status}`)),
        h("td", fmtDate(row.end_date)),
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
        h("td", fmtDate(row.due_date)),
        h("td", personName(row.decision_maker)),
      );
    }

    return h(
      "tr.mydash-row",
      h(
        "td",
        h(
          "a",
          { href: `#/p/${encodeURIComponent(row.project_id)}` },
          row.code == null ? row.title : `${row.code} ${row.title}`,
        ),
      ),
      h("td", row.project_title),
      h("td", t(`status.${row.status}`)),
      h("td", fmtDate(row.end_date)),
      h("td", personName(row.effective_owner)),
    );
  }

  function personName(person) {
    return person?.name || person?.text || t("none");
  }

  function renderViewsPanel(error) {
    const content = [
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
              const view = {
                id: makeViewId(),
                name: name.trim().slice(0, 80),
                kind,
                project_id: kind === "active_projects" ? null : projectId || null,
              };
              await persistPrefs((current) =>
                current.views.length >= 20 ? current : { ...current, views: [...current.views, view] },
              );
            },
          },
        },
        t("mydSaveView"),
      ),
      error ? h("p.mydash-error", t("mydSaveFailed", { error: error.message })) : null,
    ];
    clear(viewsPanel, content);
  }

  function renderView(view, index) {
    const first = index === 0;
    const last = index === prefs.views.length - 1;

    return h(
      "li",
      { class: first ? "is-default" : "" },
      h(
        "button.mydash-open",
        {
          type: "button",
          on: {
            click: () => {
              kind = KINDS.includes(view.kind) ? view.kind : "my_tasks";
              projectId = kind === "active_projects" ? "" : view.project_id || "";
              renderShell();
              loadRows();
            },
          },
        },
        view.name,
      ),
      first ? h("span", t("mydDefault")) : null,
      h(
        "button.mydash-rename",
        {
          type: "button",
          on: {
            click: async () => {
              const name = window.prompt(t("mydViewName"), view.name);
              if (!name || !name.trim()) return;
              await persistPrefs((current) => ({
                ...current,
                views: current.views.map((item) => (item.id === view.id ? { ...item, name: name.trim().slice(0, 80) } : item)),
              }));
            },
          },
        },
        t("mydRename"),
      ),
      h(
        "button.mydash-up",
        {
          type: "button",
          disabled: first,
          on: { click: () => moveView(view.id, -1) },
        },
        t("mydMoveUp"),
      ),
      h(
        "button.mydash-down",
        {
          type: "button",
          disabled: last,
          on: { click: () => moveView(view.id, 1) },
        },
        t("mydMoveDown"),
      ),
      h(
        "button.mydash-delete",
        {
          type: "button",
          on: {
            click: async () => {
              if (!window.confirm(t("mydConfirmDelete", { name: view.name }))) return;
              await persistPrefs((current) => ({
                ...current,
                views: current.views.filter((item) => item.id !== view.id),
              }));
            },
          },
        },
        t("delete"),
      ),
      first
        ? null
        : h(
            "button.mydash-default",
            {
              type: "button",
              on: {
                click: async () => {
                  await persistPrefs((current) => {
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
  }

  async function moveView(id, delta) {
    await persistPrefs((current) => {
      const from = current.views.findIndex((item) => item.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= current.views.length) return current;
      const views = current.views.slice();
      [views[from], views[to]] = [views[to], views[from]];
      return { ...current, views };
    });
  }

  // Preference writes are serialised: each mutation is applied to the latest
  // acknowledged prefs when its turn comes, with one PUT in flight at a time.
  // On failure `prefs` stays at the last acknowledged state and the UI is rebuilt from it.
  let prefsQueue = Promise.resolve();
  function persistPrefs(mutate) {
    const run = () => applyMutation(mutate);
    prefsQueue = prefsQueue.then(run, run);
    return prefsQueue;
  }

  async function applyMutation(mutate) {
    try {
      const next = mutate(prefs);
      if (next === prefs) return;
      const payload = {
        version: 1,
        views: next.views,
        active_projects: next.active_projects,
      };
      const result = await api.putDashboardPrefs(payload);
      prefs = normalisePrefs(result?.prefs);
      renderViewsPanel();
      if (kind === "active_projects") {
        renderShell();
        await loadRows();
      }
    } catch (e) {
      // rebuild the shell so checkboxes fall back to the acknowledged preferences
      if (kind === "active_projects") {
        renderShell();
        await loadRows();
      }
      renderViewsPanel(e);
    }
  }

  function makeViewId() {
    return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.slice(0, 40);
  }
}
