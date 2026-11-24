// "My work" page (#/work): toolbar with scope and project filter, sections from my-work.js.
import { h, clear } from "./dom.js";
import { t } from "./i18n.js";
import { api } from "./api.js";
import { myWorkSections } from "./my-work.js";

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

  let scope = loadScope(personId);
  let projectId = "";
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
    void load();
  });

  const projectSelect = h(
    "select",
    { "aria-label": t("mw.projectLabel") },
    h("option", { value: "" }, t("mw.allProjects")),
    (state?.projects ?? []).map((p) => h("option", { value: p.id }, p.title)),
  );
  projectSelect.value = projectId;
  projectSelect.addEventListener("change", () => {
    projectId = projectSelect.value;
    void load();
  });

  clear(main, h("div.toolbar", {}, h("h2", {}, t("mw.title")), scopeSelect, projectSelect), host);

  async function load() {
    const mySeq = ++renderSeq;
    const droppedNow = () => mySeq !== renderSeq || !onWorkRoute();
    const assigned = scope === "assigned";
    const withProject = (params) => (projectId ? { ...params, project_id: projectId } : params);
    let data;
    try {
      const [gates, wps, recent] = await Promise.all([
        api.openGates(withProject({ scope: "me" })),
        api.myWps(withProject({ assigned_only: assigned ? 1 : "" })),
        api.myRecent(withProject({ assigned_only: assigned ? 1 : "", days: 7, limit: 20 })),
      ]);
      data = { gates, wps, recent };
    } catch (error) {
      if (!droppedNow()) clear(host, h("p.mydash-error", {}, t("mydLoadFailed", { error: error?.message || String(error) })));
      return;
    }
    if (droppedNow()) return;
    const today = new Date().toISOString().slice(0, 10);
    clear(
      host,
      myWorkSections(data, {
        today,
        onOpen: (id) => {
          location.hash = `#/p/${encodeURIComponent(id)}`;
        },
      }),
    );
  }

  await load();
}
