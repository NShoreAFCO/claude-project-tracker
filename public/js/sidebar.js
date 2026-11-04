// Sidebar model (no imports: DOM helpers and the document are passed in, so tests can supply their own). app.js wires it.

export const GRID_FILTER_KEY = "tracker.gridFilter";

/** Logout is a Cloudflare Access path of the app's own host; it does not exist on local dev. */
export const LOGOUT_HREF = "/cdn-cgi/access/logout";
export const showLogout = (hostname) => hostname !== "localhost" && hostname !== "127.0.0.1";

/**
 * Entries from the top: dashboard, my dashboard, a categories group, the other views, then logout.
 * `labelKey` is a locale key; category entries carry the config key in `category`.
 */
export function sidebarModel({ view, categories, filterCategory, inboxCount, hostname }) {
  const home = view === "grid" && !filterCategory;
  const entry = (id, href, labelKey, current, extra) => ({ id, href, labelKey, current, ...extra });
  return {
    top: [entry("dashboard", "#/", "navDashboard", home), entry("my", "#/my", "navMy", view === "my")],
    categories: categories.map((key) => ({
      id: `cat-${key}`,
      href: "#/",
      category: key,
      current: view === "grid" && filterCategory === key,
    })),
    views: [
      entry("gantt", "#/gantt", "navGantt", view === "gantt"),
      entry("upcoming", "#/upcoming", "navUpcoming", view === "upcoming"),
      entry("mine", "#/mine", "navMine", view === "mine"),
      entry("people", "#/people", "navPeople", view === "people"),
      entry("trash", "#/trash", "navTrash", view === "trash"),
      entry("inbox", "#/inbox", "navInbox", view === "inbox", { count: inboxCount || 0 }),
    ],
    logout: showLogout(hostname) ? { href: LOGOUT_HREF, labelKey: "navLogout" } : null,
  };
}

/** Home link: forget the saved grid filter and reset the in-memory one. */
export function resetGridFilter(filter, storage) {
  for (const k of Object.keys(filter)) filter[k] = "";
  try {
    storage?.removeItem(GRID_FILTER_KEY);
  } catch {
    // storage unavailable: nothing to forget
  }
}

/** Render the model into `nav`. `deps`: { h, clear, t, catLabel, onCategory(event, key) }. */
export function renderSidebar(nav, model, { h, clear, t, catLabel, onCategory }) {
  const link = (e, label, extra) =>
    h(
      "a",
      { href: e.href, "aria-current": e.current ? "page" : null, on: e.category ? { click: (ev) => onCategory(ev, e.category) } : {} },
      label,
      extra || null,
    );
  const count = (n) => (n ? h("span.count", { "aria-label": String(n) }, String(n)) : null);
  clear(
    nav,
    ...model.top.map((e) => link(e, t(e.labelKey))),
    h("div.nav-group", h("h2.nav-heading", t("navCategories")), ...model.categories.map((e) => link(e, catLabel("p", e.category)))),
    h("hr.nav-rule"),
    ...model.views.map((e) => link(e, t(e.labelKey), count(e.count))),
    model.logout ? h("a.nav-logout", { href: model.logout.href }, t(model.logout.labelKey)) : null,
  );
}

/** Mobile drawer: menu button toggles, Escape or a click outside or on a link closes it. Returns { set, close }. */
export function createDrawer({ doc, nav, toggle }) {
  const set = (open) => {
    doc.body.classList.toggle("nav-open", open);
    toggle.setAttribute("aria-expanded", String(open));
  };
  const close = () => set(false);
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    set(toggle.getAttribute("aria-expanded") !== "true");
  });
  doc.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && doc.body.classList.contains("nav-open")) {
      close();
      toggle.focus();
    }
  });
  doc.addEventListener("click", (e) => {
    if (doc.body.classList.contains("nav-open") && !nav.contains(e.target)) close();
  });
  nav.addEventListener("click", (e) => {
    if (e.target.closest("a")) close();
  });
  return { set, close };
}

/** Logo/title click: reset filters, close dialogs, scroll to top, close the drawer; `route` runs when already on the dashboard. */
export function goHome({ filter, getStorage, doc, win, closeDrawer, hash, route }) {
  let store = null;
  try {
    store = getStorage();
  } catch {
    // storage blocked: filters are reset in memory only
  }
  resetGridFilter(filter, store);
  doc.querySelectorAll("dialog[open]").forEach((d) => d.close());
  win.scrollTo(0, 0);
  closeDrawer();
  if (hash === "#/" || hash === "" || hash === "#") route();
}
