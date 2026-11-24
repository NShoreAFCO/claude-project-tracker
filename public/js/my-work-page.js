// "My work" page (#/work): a strip of saved views, then either the sections (scope and project filter, my-work.js)
// or one saved view's list (rendering shared with mydash.js), and a "Manage views" panel.
import { h, clear } from "./dom.js";
import { t } from "./i18n.js";
import { api } from "./api.js";
import { myWorkSections } from "./my-work.js";
import {
  KINDS,
  normalisePrefs,
  fetchViewRows,
  viewResults,
  activeProjectsPicker,
  createPrefsQueue,
  renderViewsPanel,
} from "./mydash.js";

const SCOPES = ["assigned", "all"];

let renderSeq = 0;

const storageKey = (personId) => `tracker.myWork.${personId ?? "none"}`;

function loadScope(personId) {
  try {
    const value = globalThis.localStorage.getItem(storageKey(personId));
    return SCOPES.includes(value) ? value : "assigned";
  } catch {
    return "assigned";
  }
}

function saveScope(personId, scope) {
  try {
    globalThis.localStorage.setItem(storageKey(personId), scope);
  } catch {
    // storage may be blocked; the choice then only lasts for this page view
  }
}

const onWorkRoute = () => String(globalThis.location?.hash ?? "#/work").startsWith("#/work");

/** `#/work?view=<id>` -> the saved view id ("" for none). */
export function viewIdFromHash(hash) {
  const query = String(hash ?? "").split("?")[1] ?? "";
  return new URLSearchParams(query).get("view") ?? "";
}

/**
 * The new hash for an old personal-view route, or null for any other hash. `#/my` and `#/mine` become `#/work`;
 * a query is kept, and a bare saved-view id (`#/my?<id>`) becomes `?view=<id>`.
 */
export function legacyWorkHash(hash) {
  const [path, query = ""] = String(hash ?? "").split("?");
  if (path !== "#/my" && path !== "#/mine") return null;
  let qs = query;
  if (query && !query.includes("=")) {
    let id = query;
    try {
      id = decodeURIComponent(query);
    } catch {
      // malformed escape: keep the raw text
    }
    qs = `view=${encodeURIComponent(id)}`;
  }
  return qs ? `#/work?${qs}` : "#/work";
}

/** Reflect the open view in the address bar without a route change (Back does not bounce). */
function setViewInUrl(id) {
  const hash = id ? `#/work?view=${encodeURIComponent(id)}` : "#/work";
  try {
    if (globalThis.history?.replaceState) globalThis.history.replaceState(null, "", hash);
  } catch {
    // the address bar stays as it is
  }
}

/** Render the page into `main`. An answer that arrives after the route changed or a newer render started is dropped. */
export async function renderMyWork(main, state) {
  const seq = ++renderSeq;
  const stale = () => seq !== renderSeq || !onWorkRoute();
  clear(main, h("p", {}, t("loading")));

  let personId = null;
  try {
    const who = await api.whoami();
    personId = who?.person?.id ?? null;
  } catch (error) {
    if (!stale()) clear(main, h("p.mydash-error", {}, t("mydLoadFailed", { error: error?.message || String(error) })));
    return;
  }
  if (stale()) return;

  // Saved views live in the person's dashboard prefs; a caller without them just gets no strip entries.
  let prefs = normalisePrefs(null);
  try {
    prefs = normalisePrefs((await api.getDashboardPrefs())?.prefs);
  } catch {
    // no prefs: the sections still work
  }
  if (stale()) return;

  const projects = state?.projects ?? [];
  let scope = loadScope(personId);
  let projectId = "";
  let currentViewId = viewIdFromHash(globalThis.location?.hash);
  if (!prefs.views.some((v) => v.id === currentViewId)) currentViewId = "";
  // What "Save current view" stores: the open view's option and project, or the picks in the panel.
  const draft = { kind: "my_tasks", projectId: "" };

  const strip = h("div.mw-views", { role: "group", "aria-label": t("mwShell.stripLabel") });
  const content = h("div.mw-content");
  const managePanel = h("section.mydash-views-panel");
  const draftBar = h("div.mydash-bar");
  const manage = h("details.mw-manage", {}, h("summary", {}, t("mwShell.manage")), draftBar, managePanel);

  const currentView = () => prefs.views.find((v) => v.id === currentViewId) ?? null;

  const persist = createPrefsQueue({
    getPrefs: () => prefs,
    setPrefs: (next) => {
      prefs = next;
    },
    onApplied: async () => {
      const gone = currentViewId && !currentView();
      if (gone) currentViewId = "";
      drawStrip();
      drawManage();
      if (gone) {
        setViewInUrl("");
        await showContent();
      } else if (currentView()?.kind === "active_projects") await showContent();
    },
    onFailed: async (error) => {
      drawManage(error);
      if (currentView()?.kind === "active_projects") await showContent();
    },
  });

  function openView(id) {
    currentViewId = id;
    const view = currentView();
    if (view) {
      draft.kind = KINDS.includes(view.kind) ? view.kind : "my_tasks";
      draft.projectId = draft.kind === "active_projects" ? "" : view.project_id || "";
    }
    setViewInUrl(id);
    drawStrip();
    drawDraft();
    void showContent();
  }

  function drawStrip() {
    const pick = (id, label) =>
      h(
        "button",
        {
          type: "button",
          class: id === currentViewId ? "active" : "",
          "aria-pressed": String(id === currentViewId),
          on: { click: () => id !== currentViewId && openView(id) },
        },
        label,
      );
    clear(strip, h("span.mw-views-label", {}, t("mw.title")), pick("", t("mwShell.sectionsView")), prefs.views.map((v) => pick(v.id, v.name)));
  }

  function drawDraft() {
    const kindSelect = h(
      "select.mydash-kind",
      { "aria-label": t("mwShell.draftKind") },
      KINDS.map((k) => h("option", { value: k }, t(`mydKind.${k}`))),
    );
    kindSelect.value = draft.kind;
    kindSelect.addEventListener("change", () => {
      draft.kind = KINDS.includes(kindSelect.value) ? kindSelect.value : "my_tasks";
      if (draft.kind === "active_projects") draft.projectId = "";
      drawDraft();
    });
    const projectSelect = h(
      "select.mydash-project",
      { "aria-label": t("mydProject"), disabled: draft.kind === "active_projects" },
      h("option", { value: "" }, t("mydAllProjects")),
      projects.map((p) => h("option", { value: p.id }, p.title)),
    );
    projectSelect.value = draft.projectId;
    projectSelect.addEventListener("change", () => {
      draft.projectId = projectSelect.value;
    });
    clear(draftBar, h("span.meta", {}, t("mwShell.draftHint")), kindSelect, projectSelect);
  }

  function drawManage(error) {
    renderViewsPanel(
      managePanel,
      { prefs, showDefault: false, current: () => ({ kind: draft.kind, projectId: draft.projectId }), persist, onOpen: (view) => openView(view.id) },
      error,
    );
  }

  async function showContent() {
    const view = currentView();
    if (view) await showView(view);
    else await showSections();
  }

  async function showView(view) {
    const mySeq = ++renderSeq;
    const droppedNow = () => mySeq !== renderSeq || !onWorkRoute();
    const kind = KINDS.includes(view.kind) ? view.kind : "my_tasks";
    const viewProject = kind === "active_projects" ? "" : view.project_id || "";
    const results = h("div.mydash-results", {}, h("p", {}, t("loading")));
    clear(content, kind === "active_projects" ? activeProjectsPicker(projects, prefs, persist) : null, results);
    try {
      const rows = await fetchViewRows(kind, viewProject, projects, prefs);
      if (droppedNow()) return;
      clear(results, viewResults(kind, rows));
    } catch (error) {
      if (!droppedNow()) clear(results, h("p.mydash-error", {}, t("mydLoadFailed", { error: error?.message || String(error) })));
    }
  }

  async function showSections() {
    const host = h("div.my-work-host");

    const scopeSelect = h(
      "select",
      { "aria-label": t("mw.scopeLabel") },
      SCOPES.map((value) => h("option", { value }, t(`mw.scope.${value}`))),
    );
    scopeSelect.value = scope;
    scopeSelect.addEventListener("change", () => {
      scope = SCOPES.includes(scopeSelect.value) ? scopeSelect.value : "assigned";
      saveScope(personId, scope);
      void load(host);
    });

    const projectSelect = h(
      "select",
      { "aria-label": t("mw.projectLabel") },
      h("option", { value: "" }, t("mw.allProjects")),
      projects.map((p) => h("option", { value: p.id }, p.title)),
    );
    projectSelect.value = projectId;
    projectSelect.addEventListener("change", () => {
      projectId = projectSelect.value;
      void load(host);
    });

    clear(content, h("div.toolbar", {}, h("h2", {}, t("mw.title")), scopeSelect, projectSelect), host);
    await load(host);
  }

  async function load(host) {
    const mySeq = ++renderSeq;
    const droppedNow = () => mySeq !== renderSeq || !onWorkRoute();
    const assigned = scope === "assigned";
    const withProject = (params) => (projectId ? { ...params, project_id: projectId } : params);
    let data;
    let recentError = null;
    try {
      const [gates, wps, recent] = await Promise.all([
        api.openGates(withProject({ scope: "me" })),
        api.myWps(withProject({ assigned_only: assigned ? 1 : "" })),
        api.myRecent(withProject({ assigned_only: assigned ? 1 : "", days: 7, limit: 20 })).catch((e) => ({ error: e })),
      ]);
      recentError = Array.isArray(recent) ? null : recent?.error || new Error("recent");
      data = { gates, wps, recent: recentError ? [] : recent };
    } catch (error) {
      if (!droppedNow()) clear(host, h("p.mydash-error", {}, t("mydLoadFailed", { error: error?.message || String(error) })));
      return;
    }
    if (droppedNow()) return;
    const today = new Date().toISOString().slice(0, 10);
    const sections = myWorkSections(data, {
      today,
      onOpen: (id) => {
        location.hash = `#/p/${encodeURIComponent(id)}`;
      },
    });
    if (recentError) {
      const empty = sections.querySelectorAll("section.mw-section")[4]?.querySelector("p.empty");
      if (empty) {
        empty.className = "mydash-error";
        empty.textContent = t("mydLoadFailed", { error: recentError?.message || String(recentError) });
      }
    }
    clear(host, sections);
  }

  if (currentView()) {
    draft.kind = KINDS.includes(currentView().kind) ? currentView().kind : "my_tasks";
    draft.projectId = draft.kind === "active_projects" ? "" : currentView().project_id || "";
  }
  drawStrip();
  drawDraft();
  drawManage();
  clear(main, strip, content, manage);
  await showContent();
}
