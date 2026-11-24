// Cards / List toggle: URL key wins over the remembered choice, the choice is kept per person, the card is trimmed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch, installFakeDom, type FDoc, type FEl } from "./fake-dom";

const who = vi.hoisted(() => ({ me: null as { id: string } | null }));
vi.mock("../public/js/access.js", async (orig) => ({ ...(await orig<object>()), getMe: () => who.me }));
vi.mock("../public/js/project.js", () => ({ openProject: vi.fn() }));
vi.mock("../public/js/forms.js", () => ({ projectForm: vi.fn() }));
vi.mock("../public/js/portfolio.js", () => ({ summaryBar: () => null, KPI_KEYS: ["blocked", "stale"] }));
// @ts-expect-error plain browser module without types
import { renderGrid, applyGridQuery, filterToQuery, gridViewKey, loadGridView, saveGridView } from "../public/js/grid.js";

const mem = () => {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};

const project = (id: string) => ({
  id,
  title: `Project ${id}`,
  status: "active",
  origin: "manual",
  category: null,
  tags: [],
  target_date: "2099-12-01",
  owner_id: null,
  owner_initials: null,
  progress: 40,
  progress_basis: "wp",
  wp_counts: { open: 1, in_progress: 2, waiting_blocked: 0, done: 3 },
  next_milestone: { title: "Kickoff", due_date: "2099-11-20" },
  current_gate: null,
  open_branches: 3,
  context_docs: 4,
  last_activity: null,
  blocked: [],
  summary: "",
  health: null,
});

describe("grid view toggle", () => {
  let doc: FDoc;
  let main: FEl;
  let store: ReturnType<typeof mem>;
  let state: any;
  const fresh = (over: Record<string, unknown> = {}) => ({
    filter: { status: "", tag: "", category: "", owner: "", ...over },
    projects: [project("a"), project("b")],
    persons: [],
    summary: null,
  });
  const toggleButtons = () => main.querySelector(".view-toggle")!.querySelectorAll("button");
  const pressed = (label: string) =>
    toggleButtons()
      .find((b: FEl) => b.textContent === label)!
      .getAttribute("aria-pressed");

  beforeEach(() => {
    doc = installFakeDom();
    main = doc.createElement("main");
    doc.body.append(main);
    store = mem();
    who.me = null;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    state = fresh();
  });
  afterEach(() => {
    delete (globalThis as any).localStorage;
  });

  it("renders cards by default and the list after a click on the List button", () => {
    renderGrid(main as any, state);
    expect(main.querySelectorAll("article.card")).toHaveLength(2);
    expect(main.querySelectorAll("table.list-view")).toHaveLength(0);
    expect(pressed("Cards")).toBe("true");
    expect(pressed("List")).toBe("false");

    dispatch(doc, toggleButtons()[1], "click");
    expect(main.querySelectorAll("article.card")).toHaveLength(0);
    expect(main.querySelectorAll("tr.list-row")).toHaveLength(2);
    expect(pressed("List")).toBe("true");
    expect(state.filter.view).toBe("list");
  });

  it("renders one list table per category block, filtered like the cards", () => {
    state.projects = [project("a"), { ...project("b"), status: "done" }];
    state.filter.view = "list";
    renderGrid(main as any, state);
    expect(main.querySelector("section.cat-block")!.querySelectorAll("table.list-view")).toHaveLength(1);
    expect(main.querySelectorAll("tr.list-row").map((r: FEl) => r.dataset.id)).toEqual(["a"]);
  });

  it("view=list in the URL wins over a stored cards choice, and the URL mirrors it", () => {
    store.setItem(gridViewKey(), "cards");
    const filter: any = { status: "", tag: "", category: "", owner: "" };
    expect(applyGridQuery(filter, new URLSearchParams("view=list"))).toBe(true);
    expect(filterToQuery(filter).get("view")).toBe("list");
    renderGrid(main as any, { ...state, filter });
    expect(main.querySelectorAll("table.list-view")).toHaveLength(1);
  });

  it("view=cards in the URL wins over a stored list choice", () => {
    store.setItem(gridViewKey(), "list");
    const filter: any = { status: "", tag: "", category: "", owner: "" };
    applyGridQuery(filter, new URLSearchParams("view=cards"));
    renderGrid(main as any, { ...state, filter });
    expect(main.querySelectorAll("article.card")).toHaveLength(2);
  });

  it("without a URL key the stored choice applies", () => {
    store.setItem(gridViewKey(), "list");
    renderGrid(main as any, state);
    expect(main.querySelectorAll("table.list-view")).toHaveLength(1);
  });

  it("stores the choice per person id and uses anon without one", () => {
    expect(gridViewKey()).toBe("tracker.gridView.anon");
    who.me = { id: "p-1" };
    renderGrid(main as any, state);
    dispatch(doc, toggleButtons()[1], "click");
    expect(store.m.get("tracker.gridView.p-1")).toBe("list");
    expect(store.m.has("tracker.gridView.p-2")).toBe(false);

    who.me = { id: "p-2" };
    expect(loadGridView()).toBe("cards");
    who.me = { id: "p-1" };
    expect(loadGridView()).toBe("list");
  });

  it("a throwing localStorage falls back to cards and never throws", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("blocked");
      },
    });
    expect(loadGridView()).toBe("cards");
    expect(() => saveGridView("list")).not.toThrow();
    renderGrid(main as any, fresh());
    expect(main.querySelectorAll("article.card")).toHaveLength(2);
  });

  it("the card no longer shows branches, documents or the Gantt button", () => {
    renderGrid(main as any, state);
    const text = main.querySelector("article.card")!.textContent;
    expect(text).not.toContain("Open branches");
    expect(text).not.toContain("Context documents");
    expect(main.querySelector(".card-actions")).toBeNull();
    expect(main.querySelector("article.card")!.querySelectorAll("a")).toHaveLength(0);
  });
});
