// Shell model (QoL D8/D9): sidebar entries, active mark, logout visibility, home reset.
import { beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error vite ?raw import
import indexHtml from "../public/index.html?raw";
import { dispatch, installFakeDom, type FDoc, type FEl } from "./fake-dom";
// @ts-expect-error plain browser module without types
// prettier-ignore
import { sidebarModel, resetGridFilter, showLogout, GRID_FILTER_KEY, LOGOUT_HREF, renderSidebar, createDrawer, goHome } from "../public/js/sidebar.js";

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

// ---- render: the real h/clear helpers on a minimal fake DOM
describe("shell render", () => {
  let doc: FDoc;
  let nav: FEl;
  let toggle: FEl;
  let deps: any;
  const render = (over: Record<string, unknown> = {}) => {
    const model = sidebarModel({ ...base, ...over } as any);
    renderSidebar(nav as any, model, deps);
    return model;
  };
  const links = () => nav.querySelectorAll("a");
  const labels = () => links().map((a) => a.textContent);

  beforeEach(async () => {
    doc = installFakeDom();
    nav = doc.createElement("nav");
    toggle = doc.createElement("button");
    toggle.setAttribute("aria-expanded", "false");
    doc.body.append(nav, toggle);
    // @ts-expect-error plain browser module without types
    const { h, clear } = await import("../public/js/dom.js");
    deps = { h, clear, t: (k: string) => k, catLabel: (_: string, k: string) => `cat:${k}`, onCategory: () => {} };
  });

  it("renders dashboard, my dashboard, categories, views and logout in order", () => {
    render();
    expect(labels()).toEqual([
      "navDashboard",
      "navMy",
      "cat:a",
      "cat:b",
      "cat:c",
      "navGantt",
      "navUpcoming",
      "navMine",
      "navPeople",
      "navTrash",
      "navInbox2",
      "navLogout",
    ]);
    expect(nav.querySelector("h2.nav-heading")?.textContent).toBe("navCategories");
  });

  it("marks the current entry with aria-current on exactly one link", () => {
    render({ filterCategory: "b" });
    const cur = links().filter((a) => a.getAttribute("aria-current") === "page");
    expect(cur.map((a) => a.textContent)).toEqual(["cat:b"]);
    render({ view: "my" });
    expect(
      links()
        .filter((a) => a.getAttribute("aria-current") === "page")
        .map((a) => a.textContent),
    ).toEqual(["navMy"]);
  });

  it("a category link calls back with its key and the default navigation is the callback's to cancel", () => {
    const picked: string[] = [];
    deps.onCategory = (ev: any, key: string) => (ev.preventDefault(), picked.push(key));
    render();
    const e = dispatch(doc, links()[3], "click");
    expect(picked).toEqual(["b"]);
    expect(e.defaultPrevented).toBe(true);
  });

  it("hides logout on localhost", () => {
    render({ hostname: "localhost" });
    expect(nav.querySelector(".nav-logout")).toBeNull();
  });

  it("logo click resets the filter, forgets the saved one, closes dialogs and the drawer, and re-routes at home", () => {
    const dialog = doc.createElement("dialog");
    dialog.setAttribute("open", "");
    doc.body.append(dialog);
    const drawer = createDrawer({ doc, nav, toggle } as any);
    drawer.set(true);
    const filter: any = { status: "active", tag: "x", category: "a", owner: "me", kpi: "stale" };
    const removed: string[] = [];
    let scrolled = false;
    let routed = 0;
    goHome({
      filter,
      getStorage: () => ({ removeItem: (k: string) => removed.push(k) }),
      doc,
      win: { scrollTo: () => (scrolled = true) },
      closeDrawer: drawer.close,
      hash: "#/",
      route: () => routed++,
    } as any);
    expect(Object.values(filter).every((v) => v === "")).toBe(true);
    expect(removed).toEqual([GRID_FILTER_KEY]);
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(scrolled).toBe(true);
    expect(doc.body.classList.contains("nav-open")).toBe(false);
    expect(routed).toBe(1);
    goHome({
      filter,
      getStorage: () => {
        throw new Error("blocked");
      },
      doc,
      win: { scrollTo() {} },
      closeDrawer: drawer.close,
      hash: "#/p/x",
      route: () => routed++,
    } as any);
    expect(routed).toBe(1);
  });

  describe("drawer keyboard", () => {
    it("menu button toggles aria-expanded and nav-open", () => {
      createDrawer({ doc, nav, toggle } as any);
      dispatch(doc, toggle, "click");
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(doc.body.classList.contains("nav-open")).toBe(true);
      dispatch(doc, toggle, "click");
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
    });
    it("Escape closes the open drawer and returns focus to the menu button", () => {
      createDrawer({ doc, nav, toggle } as any);
      dispatch(doc, toggle, "click");
      render();
      links()[0].focus();
      dispatch(doc, doc, "keydown", { key: "Escape" });
      expect(doc.body.classList.contains("nav-open")).toBe(false);
      expect(doc.activeElement).toBe(toggle);
    });
    it("Escape with the drawer closed does nothing; other keys keep it open", () => {
      createDrawer({ doc, nav, toggle } as any);
      dispatch(doc, doc, "keydown", { key: "Escape" });
      expect(doc.activeElement).toBe(doc.body);
      dispatch(doc, toggle, "click");
      dispatch(doc, doc, "keydown", { key: "a" });
      expect(doc.body.classList.contains("nav-open")).toBe(true);
    });
    it("a click outside the nav or on a nav link closes it; a click inside the nav does not", () => {
      createDrawer({ doc, nav, toggle } as any);
      render();
      dispatch(doc, toggle, "click");
      dispatch(doc, nav, "click");
      expect(doc.body.classList.contains("nav-open")).toBe(true);
      dispatch(doc, links()[1], "click");
      expect(doc.body.classList.contains("nav-open")).toBe(false);
      dispatch(doc, toggle, "click");
      dispatch(doc, doc.body, "click");
      expect(doc.body.classList.contains("nav-open")).toBe(false);
    });
  });

  it("375 px: the page scales to the viewport and the narrow layout hooks exist (menu button controls #nav, nav-open class)", () => {
    // layout itself needs a browser; here the structure the narrow-screen rules rely on is pinned
    expect(indexHtml).toContain('<meta name="viewport" content="width=device-width, initial-scale=1"');
    expect(indexHtml).toMatch(
      /<button[^>]*class="[^"]*nav-toggle[^"]*"[^>]*id="nav-toggle"[^>]*aria-controls="nav"[^>]*aria-expanded="false"/,
    );
    expect(indexHtml).toMatch(/<nav id="nav" class="sidebar">/);
    createDrawer({ doc, nav, toggle } as any);
    dispatch(doc, toggle, "click");
    expect(doc.body.classList.contains("nav-open")).toBe(true); // the class the @media (max-width: 900px) rules key on
  });
});
