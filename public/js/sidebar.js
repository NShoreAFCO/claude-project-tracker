// Sidebar model (no imports: testable without the DOM). app.js renders it.

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
