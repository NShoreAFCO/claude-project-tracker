// Entry point: hash router (#/, #/gantt, #/inbox, #/search?q=…, #/p/<id>[/kontext]), nav and search.
import config from "../instance/config.js";
import { t, setLocale } from "./i18n.js";
import { loadMe, POLICY } from "./access.js";
import { renderUserBar } from "./userbar.js";
import { api } from "./api.js";
import { h, clear, toastError } from "./dom.js";
import { renderGrid } from "./grid.js";
import { renderGantt } from "./gantt.js";
import { renderMyDashboard } from "./mydash.js";
import { renderUpcoming, renderMyWps, loadSummary } from "./portfolio.js";
import { renderInbox } from "./inbox.js";
import { openProject } from "./project.js";
import { renderPeople } from "./people.js";
import { renderTrash } from "./trash.js";
import { sidebarModel, resetGridFilter } from "./sidebar.js";
import { PROJECT_CATEGORIES, catLabel } from "./categories.js";

document.getElementById("logo").src = `/instance/${config.app.logo}`;
document.getElementById("favicon").href = `/instance/${config.app.favicon}`;
const main = document.getElementById("main");
const nav = document.getElementById("nav");
const navToggle = document.getElementById("nav-toggle");
const searchForm = document.getElementById("search");
const userbar = document.getElementById("userbar");

/** Shared state: the project list (cards) is reused by forms, inbox and gantt. */
export const state = {
  projects: [],
  summary: null,
  persons: [],
  filter: { status: "", tag: "", category: "", owner: "" },
  inboxCount: 0,
  view: "grid",
};

export async function loadProjects() {
  // persons are only needed for owner names on cards; a failure must not block the grid
  const [projects, persons, summary] = await Promise.all([api.projects(), api.persons().catch(() => state.persons), loadSummary()]);
  state.projects = projects;
  state.summary = summary;
  state.persons = persons;
  return state.projects;
}

/** Re-render the current base view (after any write). */
export async function refresh() {
  try {
    await loadProjects();
    await renderView();
    updateInboxCount();
  } catch (e) {
    toastError(e);
  }
}

async function updateInboxCount() {
  try {
    state.inboxCount = (await api.inbox()).length;
  } catch {
    state.inboxCount = 0;
  }
  renderNav();
}

function renderNav() {
  const model = sidebarModel({
    view: state.view,
    categories: PROJECT_CATEGORIES,
    filterCategory: state.filter.category,
    inboxCount: state.inboxCount,
    hostname: location.hostname,
  });
  const link = (e, label, extra) =>
    h("a", { href: e.href, "aria-current": e.current ? "page" : null, on: e.category ? { click: (ev) => pickCategory(ev, e.category) } : {} }, label, extra || null);
  const count = (n) => (n ? h("span.count", { "aria-label": String(n) }, String(n)) : null);
  clear(
    nav,
    ...model.top.map((e) => link(e, t(e.labelKey))),
    h("div.nav-group", h("h2.nav-heading", t("navCategories")), ...model.categories.map((e) => link(e, catLabel("p", e.category)))),
    h("hr.nav-rule"),
    ...model.views.map((e) => link(e, t(e.labelKey), count(e.count))),
    model.logout ? h("a.nav-logout", { href: model.logout.href }, t(model.logout.labelKey)) : null,
  );
  navToggle.textContent = t("navMenu");
}

/** Category entry: set the grid category filter and show the grid. */
function pickCategory(ev, key) {
  ev.preventDefault();
  state.filter.category = key;
  closeDrawer();
  if (location.hash === "#/" || location.hash === "" || location.hash === "#") route();
  else location.hash = "#/";
}

function setDrawer(open) {
  document.body.classList.toggle("nav-open", open);
  navToggle.setAttribute("aria-expanded", String(open));
}
function closeDrawer() {
  setDrawer(false);
}
navToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  setDrawer(navToggle.getAttribute("aria-expanded") !== "true");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("nav-open")) {
    closeDrawer();
    navToggle.focus();
  }
});
document.addEventListener("click", (e) => {
  if (document.body.classList.contains("nav-open") && !nav.contains(e.target)) closeDrawer();
});
nav.addEventListener("click", (e) => {
  if (e.target.closest("a")) closeDrawer();
});

// Logo/title: home. Reset filters, close dialogs, scroll to top (also when already on #/).
document.getElementById("home").addEventListener("click", () => {
  let store = null;
  try {
    store = localStorage;
  } catch {
    // storage blocked: filters are reset in memory only
  }
  resetGridFilter(state.filter, store);
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  window.scrollTo(0, 0);
  closeDrawer();
  if (location.hash === "#/" || location.hash === "" || location.hash === "#") route();
});

/** Shell texts come from the instance config and the UI locale (index.html carries no brand text). Re-run after a language switch. */
function renderShell() {
  document.title = t("appTitle");
  document.getElementById("app-title").textContent = t("appTitle");
  nav.setAttribute("aria-label", t("navMain"));
  renderSearch();
  renderNav();
  renderUserBar(userbar, onLocaleChange);
}

/** Runtime language switch: no reload; the shell and the current view render again (open dialogs close). */
async function onLocaleChange() {
  renderShell();
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  await route();
}

function renderSearch() {
  const input = h("input", { type: "search", name: "q", placeholder: t("searchPlaceholder"), "aria-label": t("searchLabel") });
  clear(searchForm, input, h("button.btn.secondary", { type: "submit" }, t("searchButton")));
  searchForm.onsubmit = (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (q.length < 2) return toastError(new Error(t("searchTooShort")));
    location.hash = `#/search?q=${encodeURIComponent(q)}`;
  };
}

async function renderSearchResults(q) {
  clear(main, h("h2", t("searchResults", { q })), h("p", t("loading")));
  const hits = await api.search(q);
  const list = h("ul.timeline");
  for (const hit of hits) {
    const label = { project: t("ownerKind.project"), workpackage: t("ownerKind.workpackage"), context_doc: t("tabContext") }[hit.kind];
    list.append(
      h(
        "li",
        h("span.who", label),
        h(
          "div",
          h(
            "button.linkbtn",
            {
              type: "button",
              on: { click: () => openProject(hit.project_id, hit.kind === "context_doc" ? { tab: "context", openDoc: hit.id } : {}) },
            },
            `${hit.title} (${hit.project_id})`,
          ),
          h("div.meta", hit.snippet),
        ),
      ),
    );
  }
  clear(main, h("h2", t("searchResults", { q })), hits.length ? list : h("p.empty", t("searchNone")));
}

function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, query = ""] = raw.split("?");
  return { parts: path.split("/").filter(Boolean).map(decodeURIComponent), params: new URLSearchParams(query) };
}

async function renderView() {
  const { parts, params } = parseHash();
  const view = ["gantt", "inbox", "search", "people", "trash", "upcoming", "mine", "my"].includes(parts[0]) ? parts[0] : "grid";
  state.view = view;
  renderNav();
  if (view === "people") await renderPeople(main, state);
  else if (view === "trash") await renderTrash(main, state);
  else if (view === "upcoming") await renderUpcoming(main);
  else if (view === "mine") await renderMyWps(main);
  else if (view === "my") await renderMyDashboard(main, state);
  else if (view === "gantt") await renderGantt(main, state);
  else if (view === "inbox") await renderInbox(main, state);
  else if (view === "search") await renderSearchResults(params.get("q") || "");
  else renderGrid(main, state);
}

async function route() {
  const { parts } = parseHash();
  try {
    if (!state.projects.length) await loadProjects();
    if (parts[0] === "p" && parts[1]) {
      // deep link to a project: show the grid underneath, then the modal
      if (state.view !== "grid" || !main.childElementCount) {
        state.view = "grid";
        renderNav();
        renderGrid(main, state);
      }
      document.querySelectorAll("dialog[open]").forEach((d) => d.close());
      openProject(parts[1], { tab: parts[2] === "kontext" ? "context" : parts[2] === "risks" ? "risks" : "overview" });
      return;
    }
    // navigating to a base view closes any open popup (project, forms, dialogs)
    document.querySelectorAll("dialog[open]").forEach((d) => d.close());
    await renderView();
  } catch (e) {
    clear(main, h("div.callout.conflict", e?.isAuth ? t("errorAuth") : t("errorGeneric", { msg: e?.message || String(e) })));
  }
}

window.addEventListener("hashchange", route);
// A language saved in the profile form changes the shell too.
window.addEventListener("tracker:locale", () => onLocaleChange());
// Any successful write anywhere (forms, context panel, inbox) → reload cards and the current view.
window.addEventListener("tracker:changed", () => refresh());
// The person's saved language wins over the browser's remembered one, which wins over the instance default.
loadMe().then((me) => {
  if (me?.locale && POLICY.locales.includes(me.locale)) setLocale(me.locale);
  renderShell();
  return route().then(updateInboxCount);
});
