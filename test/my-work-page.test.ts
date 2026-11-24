// "My work" page: scope stored per person, storage failures, stale answers.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch, installFakeDom, type FDoc, type FEl } from "./fake-dom";

const api = vi.hoisted(() => ({
  whoami: vi.fn(),
  openGates: vi.fn(),
  myWps: vi.fn(),
  myRecent: vi.fn(),
  getDashboardPrefs: vi.fn(),
  putDashboardPrefs: vi.fn(),
}));
vi.mock("../public/js/api.js", () => ({ api }));
// @ts-expect-error plain browser module without types
import { renderMyWork, legacyWorkHash, viewIdFromHash } from "../public/js/my-work-page.js";

const g = globalThis as any;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const mem = () => {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
};

let doc: FDoc;
let main: FEl;
beforeEach(() => {
  doc = installFakeDom();
  main = doc.createElement("main");
  doc.body.append(main);
  g.location = { hash: "#/work" };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: mem() });
  api.whoami.mockReset().mockResolvedValue({ person: { id: "p1" } });
  api.openGates.mockReset().mockResolvedValue([]);
  api.myWps.mockReset().mockResolvedValue([]);
  api.myRecent.mockReset().mockResolvedValue([]);
  api.getDashboardPrefs.mockReset().mockResolvedValue({ prefs: { version: 1, views: [], active_projects: [] } });
  api.putDashboardPrefs.mockReset();
  g.history = { replaceState: vi.fn((_s: unknown, _t: string, url: string) => void (g.location.hash = url)) };
});

const scopeSelect = () => main.querySelectorAll("select")[0];

describe("renderMyWork", () => {
  it("loads assigned work by default and renders five sections", async () => {
    await renderMyWork(main, { projects: [] });
    expect(main.querySelectorAll("section.mw-section")).toHaveLength(5);
    expect(api.myWps).toHaveBeenCalledWith({ assigned_only: 1 });
    expect(api.myRecent).toHaveBeenCalledWith({ assigned_only: 1, days: 7, limit: 20 });
    expect(api.openGates).toHaveBeenCalledWith({ scope: "me" });
  });

  it("stores the scope per person and restores it", async () => {
    await renderMyWork(main, { projects: [] });
    const select = scopeSelect();
    select.value = "all";
    dispatch(doc, select, "change");
    await tick();
    expect(g.localStorage.m.get("tracker.myWork.p1")).toBe("all");
    expect(api.myWps).toHaveBeenLastCalledWith({ assigned_only: "" });

    await renderMyWork(main, { projects: [] });
    expect(scopeSelect().value).toBe("all");

    api.whoami.mockResolvedValue({ person: { id: "p2" } });
    await renderMyWork(main, { projects: [] });
    expect(scopeSelect().value).toBe("assigned");
  });

  it("still renders when storage throws", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    await renderMyWork(main, { projects: [] });
    expect(main.querySelectorAll("section.mw-section")).toHaveLength(5);
    const select = scopeSelect();
    select.value = "all";
    dispatch(doc, select, "change");
    await tick();
    expect(api.myWps).toHaveBeenLastCalledWith({ assigned_only: "" });
  });

  it("drops an answer that arrives after the route changed", async () => {
    let release: (v: unknown[]) => void = () => {};
    api.myWps.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const pending = renderMyWork(main, { projects: [] });
    await tick();
    g.location.hash = "#/gantt";
    release([{ id: "w", project_id: "x", project_title: "X", code: "A", title: "T", status: "doing", end_date: "2000-01-01" }]);
    await pending;
    expect(main.querySelectorAll("section.mw-section")).toHaveLength(0);
  });

  it("drops an older answer when a newer render started", async () => {
    let releaseOld: (v: unknown[]) => void = () => {};
    api.myWps.mockReturnValueOnce(new Promise((resolve) => (releaseOld = resolve)));
    const first = renderMyWork(main, { projects: [] });
    await tick();
    const second = renderMyWork(main, { projects: [] });
    await second;
    releaseOld([{ id: "w", project_id: "x", project_title: "X", code: "OLD", title: "T", status: "doing", end_date: "2000-01-01" }]);
    await first;
    expect(main.querySelectorAll("li.mw-row")).toHaveLength(0);
  });

  it("keeps four sections when only the recent feed fails", async () => {
    api.myRecent.mockRejectedValue(new Error("recent down"));
    await renderMyWork(main, { projects: [] });
    expect(main.querySelectorAll("section.mw-section")).toHaveLength(5);
    expect(main.querySelectorAll("p.mydash-error")).toHaveLength(1);
    expect(main.querySelector("p.mydash-error")?.textContent).toContain("recent down");
  });

  it("shows the server message when the caller has no person", async () => {
    api.whoami.mockResolvedValue({ person: null });
    api.openGates.mockRejectedValue(new Error("this is for people with a dashboard login"));
    await renderMyWork(main, { projects: [] });
    expect(main.querySelector("p.mydash-error")?.textContent).toContain("dashboard login");
  });
});

const VIEWS = [
  { id: "va", name: "Alpha", kind: "my_decisions", project_id: null },
  { id: "vb", name: "Beta", kind: "my_tasks", project_id: "p9" },
];
const stripButtons = () => main.querySelector("div.mw-views")!.querySelectorAll("button");

describe("legacyWorkHash", () => {
  it("sends both old routes to #/work, with and without a query", () => {
    expect(legacyWorkHash("#/my")).toBe("#/work");
    expect(legacyWorkHash("#/mine")).toBe("#/work");
    expect(legacyWorkHash("#/my?view=va")).toBe("#/work?view=va");
    expect(legacyWorkHash("#/mine?x=1")).toBe("#/work?x=1");
  });

  it("maps a bare saved-view id to ?view=", () => {
    expect(legacyWorkHash("#/my?va")).toBe("#/work?view=va");
    expect(legacyWorkHash("#/my?a%20b")).toBe("#/work?view=a%20b");
  });

  it("leaves every other hash alone", () => {
    for (const hash of ["#/", "#/work", "#/work?view=va", "#/upcoming", "#/mystery", ""]) expect(legacyWorkHash(hash)).toBeNull();
  });

  it("reads the view id from the hash", () => {
    expect(viewIdFromHash("#/work?view=va")).toBe("va");
    expect(viewIdFromHash("#/work")).toBe("");
  });
});

describe("saved views on My work", () => {
  beforeEach(() => {
    api.getDashboardPrefs.mockResolvedValue({ prefs: { version: 1, views: VIEWS, active_projects: [] } });
  });

  it("renders the saved views in prefs order after the overview button", async () => {
    await renderMyWork(main, { projects: [] });
    expect(stripButtons().map((b) => b.textContent)).toEqual(["Overview", "Alpha", "Beta"]);
    expect(stripButtons().map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
    expect(main.querySelectorAll("section.mw-section")).toHaveLength(5);
  });

  it("opens the view named in the URL and shows its list", async () => {
    g.location.hash = "#/work?view=vb";
    api.myWps.mockResolvedValue([{ id: "w", project_id: "p9", project_title: "Nine", code: "A1", title: "Task", status: "doing", end_date: "2030-01-01" }]);
    await renderMyWork(main, { projects: [] });
    expect(stripButtons().map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
    expect(api.myWps).toHaveBeenCalledWith({ sort: "end", assigned_only: 1, project_id: "p9" });
    expect(main.querySelectorAll("section.mw-section")).toHaveLength(0);
    expect(main.querySelectorAll("tr.mydash-row")).toHaveLength(1);
  });

  it("picking a view shows its list and puts it in the address bar without a route change", async () => {
    await renderMyWork(main, { projects: [] });
    api.openGates.mockClear();
    dispatch(doc, stripButtons()[1], "click");
    await tick();
    expect(g.history.replaceState).toHaveBeenCalledWith(null, "", "#/work?view=va");
    expect(api.openGates).toHaveBeenCalledWith({ scope: "me" });
    expect(stripButtons()[1].getAttribute("aria-pressed")).toBe("true");
    expect(main.querySelectorAll("section.mw-section")).toHaveLength(0);
    dispatch(doc, stripButtons()[0], "click");
    await tick();
    expect(g.history.replaceState).toHaveBeenLastCalledWith(null, "", "#/work");
    expect(main.querySelectorAll("section.mw-section")).toHaveLength(5);
  });

  it("falls back to the sections for an unknown view id", async () => {
    g.location.hash = "#/work?view=nope";
    await renderMyWork(main, { projects: [] });
    expect(main.querySelectorAll("section.mw-section")).toHaveLength(5);
    expect(stripButtons().map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
  });

  it("manages views on the same page: delete saves the prefs and drops the strip entry", async () => {
    api.putDashboardPrefs.mockResolvedValue({ prefs: { version: 1, views: [VIEWS[1]], active_projects: [] } });
    g.window = { confirm: () => true, prompt: () => null };
    await renderMyWork(main, { projects: [] });
    expect(main.querySelectorAll("button.mydash-open").map((b) => b.textContent)).toEqual(["Alpha", "Beta"]);
    dispatch(doc, main.querySelectorAll("button.mydash-delete")[0], "click");
    await tick();
    await tick();
    expect(api.putDashboardPrefs).toHaveBeenCalledWith({ version: 1, views: [VIEWS[1]], active_projects: [] });
    expect(stripButtons().map((b) => b.textContent)).toEqual(["Overview", "Beta"]);
  });

  it("hides the default label and button in the manage panel but keeps reordering", async () => {
    await renderMyWork(main, { projects: [] });
    expect(main.querySelectorAll("button.mydash-default")).toHaveLength(0);
    expect(main.querySelectorAll("ul.mydash-views")[0].textContent).not.toContain("Default");
    expect(main.querySelectorAll("button.mydash-up")).toHaveLength(2);
    expect(main.querySelectorAll("button.mydash-down")).toHaveLength(2);
  });

  it("still shows the sections when the prefs cannot be loaded", async () => {
    api.getDashboardPrefs.mockRejectedValue(new Error("nope"));
    await renderMyWork(main, { projects: [] });
    expect(main.querySelectorAll("section.mw-section")).toHaveLength(5);
    expect(stripButtons().map((b) => b.textContent)).toEqual(["Overview"]);
  });
});
