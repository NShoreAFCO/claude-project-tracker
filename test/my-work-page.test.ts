// "My work" page: scope stored per person, storage failures, stale answers.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch, installFakeDom, type FDoc, type FEl } from "./fake-dom";

const api = vi.hoisted(() => ({
  whoami: vi.fn(),
  openGates: vi.fn(),
  myWps: vi.fn(),
  myRecent: vi.fn(),
}));
vi.mock("../public/js/api.js", () => ({ api }));
// @ts-expect-error plain browser module without types
import { renderMyWork } from "../public/js/my-work-page.js";

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

  it("shows the server message when the caller has no person", async () => {
    api.whoami.mockResolvedValue({ person: null });
    api.openGates.mockRejectedValue(new Error("this is for people with a dashboard login"));
    await renderMyWork(main, { projects: [] });
    expect(main.querySelector("p.mydash-error")?.textContent).toContain("dashboard login");
  });
});
