// Shell model (QoL D8/D9): sidebar entries, active mark, logout visibility, home reset.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser module without types
import { sidebarModel, resetGridFilter, showLogout, GRID_FILTER_KEY, LOGOUT_HREF } from "../public/js/sidebar.js";

const base = { view: "grid", categories: ["a", "b", "c"], filterCategory: "", inboxCount: 2, hostname: "tracker.example.com" };

describe("sidebar model", () => {
  it("lists dashboard, my dashboard, every category, the views and logout", () => {
    const m = sidebarModel(base);
    expect(m.top.map((e: any) => e.href)).toEqual(["#/", "#/my"]);
    expect(m.categories.map((e: any) => e.category)).toEqual(["a", "b", "c"]);
    expect(m.views.map((e: any) => e.id)).toEqual(["gantt", "upcoming", "mine", "people", "trash", "inbox"]);
    expect(m.views.at(-1).count).toBe(2);
    expect(m.logout).toEqual({ href: LOGOUT_HREF, labelKey: "navLogout" });
  });

  it("marks exactly one entry active", () => {
    const current = (m: any) => [...m.top, ...m.categories, ...m.views].filter((e) => e.current).map((e) => e.id);
    expect(current(sidebarModel(base))).toEqual(["dashboard"]);
    expect(current(sidebarModel({ ...base, filterCategory: "b" }))).toEqual(["cat-b"]);
    expect(current(sidebarModel({ ...base, view: "my" }))).toEqual(["my"]);
    expect(current(sidebarModel({ ...base, view: "inbox" }))).toEqual(["inbox"]);
  });

  it("hides logout on localhost only", () => {
    expect(showLogout("localhost")).toBe(false);
    expect(showLogout("127.0.0.1")).toBe(false);
    expect(showLogout("tracker.example.com")).toBe(true);
    expect(sidebarModel({ ...base, hostname: "localhost" }).logout).toBeNull();
    expect(LOGOUT_HREF).toBe("/cdn-cgi/access/logout");
  });

  it("home reset clears filters and the stored key", () => {
    const removed: string[] = [];
    const filter = { status: "active", tag: "x", category: "a", owner: "me" };
    resetGridFilter(filter, { removeItem: (k: string) => removed.push(k) });
    expect(filter).toEqual({ status: "", tag: "", category: "", owner: "" });
    expect(removed).toEqual([GRID_FILTER_KEY]);
    expect(GRID_FILTER_KEY).toBe("tracker.gridFilter");
  });
});
