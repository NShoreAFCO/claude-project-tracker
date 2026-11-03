// Grid filters (QoL D10) and the card (D11): pure filter logic and the card markup.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch, installFakeDom, type FDoc, type FEl } from "./fake-dom";

vi.mock("../public/js/project.js", () => ({ openProject: vi.fn() }));
vi.mock("../public/js/forms.js", () => ({ projectForm: vi.fn() }));
vi.mock("../public/js/portfolio.js", () => ({ summaryBar: () => null }));
// @ts-expect-error plain browser module without types
import { filterProjects, orderTags, statusOptions, completedMode, saveGridFilter, loadGridFilter, renderGrid } from "../public/js/grid.js";
// @ts-expect-error plain browser module without types
import { GRID_FILTER_KEY, resetGridFilter } from "../public/js/sidebar.js";

const P = (id: string, status: string, tags: string[] = []) => ({ id, status, tags, category: null, owner_id: null, owner_initials: null });
const projects = [P("a", "active", ["x", "y"]), P("b", "done", ["x"]), P("c", "abandoned", ["y"]), P("d", "idea", ["x", "y", "z"])];
const ids = (f: any) => filterProjects(projects, f).map((p: any) => p.id);
const mem = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};

describe("completed filter", () => {
  it("hides completed by default, also after the home reset", () => {
    expect(ids({ status: "", tags: [] })).toEqual(["a", "d"]);
    expect(ids({ completed: "", tags: "" })).toEqual(["a", "d"]);
    expect(completedMode({ completed: "" })).toBe("hide");
  });
  it("only / all", () => {
    expect(ids({ completed: "only" })).toEqual(["b", "c"]);
    expect(ids({ completed: "all" })).toEqual(["a", "b", "c", "d"]);
  });
  it("status options never contradict the mode", () => {
    expect(statusOptions("hide")).toEqual(["idea", "active", "on_hold"]);
    expect(statusOptions("only")).toEqual(["done", "abandoned"]);
    expect(statusOptions("all")).toHaveLength(5);
  });
  it("survives a reload via storage and the home reset forgets it", () => {
    const s = mem();
    saveGridFilter({ completed: "only", tags: ["x"], status: "", owner: "" }, s);
    const f: any = { status: "", tag: "", category: "", owner: "" };
    loadGridFilter(f, s);
    expect(f.completed).toBe("only");
    expect(f.tags).toEqual(["x"]);
    resetGridFilter(f, s);
    expect(s.getItem(GRID_FILTER_KEY)).toBeNull();
    expect(completedMode(f)).toBe("hide");
  });
});

describe("completed mode round trip", () => {
  it.each(["hide", "only", "all"])("%s survives save/load and filters the same", (mode) => {
    const s = mem();
    const before: any = { completed: mode, tags: [], status: "", owner: "" };
    saveGridFilter(before, s);
    const after: any = { status: "", tag: "", category: "", owner: "" };
    loadGridFilter(after, s);
    expect(completedMode(after)).toBe(mode);
    expect(ids(after)).toEqual(ids(before));
  });
});

describe("tag filter", () => {
  it("ANDs checked tags", () => {
    expect(ids({ completed: "all", tags: ["x", "y"] })).toEqual(["a", "d"]);
    expect(ids({ completed: "all", tags: ["x", "y", "z"] })).toEqual(["d"]);
  });
  it("lists checked tags first, then alphabetical", () => {
    expect(orderTags(["b", "a", "c", "d", "a"], ["c", "b"])).toEqual(["b", "c", "a", "d"]);
  });
});

describe("storage getter that throws", () => {
  it("load/save do not throw when globalThis.localStorage access throws", () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("blocked");
      },
    });
    try {
      expect(() => saveGridFilter({})).not.toThrow();
      expect(loadGridFilter({})).toEqual({});
    } finally {
      if (desc) Object.defineProperty(globalThis, "localStorage", desc);
      else delete (globalThis as any).localStorage;
    }
  });
});

// ---- render: real dom.js helpers on a minimal fake DOM
const full = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Project ${id}`,
  status: "active",
  origin: "manual",
  category: null,
  tags: ["x", "y"],
  target_date: "2026-12-01",
  owner_id: null,
  owner_initials: null,
  progress: 40,
  progress_basis: "wp",
  wp_counts: { open: 1, in_progress: 2, waiting_blocked: 0, done: 3 },
  next_milestone: { title: "Kickoff", due_date: "2026-11-20" },
  current_gate: null,
  open_branches: 0,
  context_docs: 0,
  last_activity: null,
  blocked: [],
  summary: "",
  ...over,
});

describe("grid render", () => {
  let doc: FDoc;
  let main: FEl;
  let state: any;
  const classOf = (el: FEl) => el.className;
  const card = () => main.querySelector("article.card")!;

  beforeEach(() => {
    doc = installFakeDom();
    main = doc.createElement("main");
    doc.body.append(main);
    state = {
      filter: { status: "", tag: "", category: "", owner: "" },
      projects: [full("a"), full("b", { tags: ["x"] })],
      persons: [],
      summary: null,
    };
  });

  it("orders the card: head, target, work packages, milestone, [gate], minor", () => {
    state.projects = [full("a", { current_gate: { title: "Go/No-go", due_date: null, decision_state: "pending" } })];
    renderGrid(main as any, state);
    expect(card().children.map(classOf)).toEqual([
      "head",
      "card-target",
      "underlay-wp card-box wp-counts",
      "underlay-milestone card-box next-ms",
      "underlay-gate card-box card-gate",
      "card-minor",
      "card-actions",
    ]);
  });

  it("renders no gate box without a gate and no milestone box without a milestone", () => {
    state.projects = [full("a", { next_milestone: null })];
    renderGrid(main as any, state);
    expect(main.querySelector(".card-gate")).toBeNull();
    expect(main.querySelector(".next-ms")).toBeNull();
    expect(card().children.map(classOf)).toEqual(["head", "card-target", "underlay-wp card-box wp-counts", "card-minor", "card-actions"]);
  });

  it("375 px: cards sit in one fluid .cards container and long box titles are single-line ellipsis boxes", () => {
    renderGrid(main as any, state);
    const cards = main.querySelector(".cards")!;
    expect(cards.children).toHaveLength(2);
    expect(cards.children.every((c: FEl) => c.tagName === "ARTICLE" && c.classes.has("card"))).toBe(true);
    // width is the container's job (auto-fill grid, no fixed widths on the card or its boxes)
    expect(cards.querySelectorAll(".card-box").every((b: FEl) => !b.getAttribute("style"))).toBe(true);
    expect(main.querySelectorAll("table")).toHaveLength(0);
  });

  describe("tag filter focus and popover", () => {
    const tagBtn = () => main.querySelector("button.tag-filter-btn")!;
    const pop = () => main.querySelector(".tag-pop")!;
    const box = (tag: string) => main.querySelectorAll("input").find((i) => i.getAttribute("data-focus") === `tag-opt:${tag}`)!;

    it("keeps focus on the same checkbox, keeps the popover open and applies the filter", () => {
      renderGrid(main as any, state);
      dispatch(doc, tagBtn(), "click");
      expect(pop().hidden).toBe(false);
      box("y").focus();
      box("y").checked = true;
      dispatch(doc, box("y"), "change", { target: box("y") });
      expect(state.filter.tags).toEqual(["y"]);
      expect(pop().hidden).toBe(false);
      expect(tagBtn().getAttribute("aria-expanded")).toBe("true");
      expect(doc.activeElement.getAttribute("data-focus")).toBe("tag-opt:y");
      expect(doc.activeElement).toBe(box("y"));
      expect(box("y").checked).toBe(true);
    });

    it("after clearing, focus falls back to the tag button (the clear button is gone)", () => {
      state.filter.tags = ["x"];
      renderGrid(main as any, state);
      dispatch(doc, tagBtn(), "click");
      const clearBtn = main.querySelector("button.tag-clear")!;
      clearBtn.focus();
      dispatch(doc, clearBtn, "click");
      expect(state.filter.tags).toEqual([]);
      expect(doc.activeElement).toBe(tagBtn());
    });

    it("a change in another control restores focus to that control and does not open the popover", () => {
      renderGrid(main as any, state);
      const seg = main.querySelectorAll("button.seg")[1];
      seg.focus();
      dispatch(doc, seg, "click");
      expect(state.filter.completed).toBe("only");
      expect(doc.activeElement.getAttribute("data-focus")).toBe("completed-only");
      expect(pop().hidden).toBe(true);
    });

    it("Escape closes the popover and returns focus to the button", () => {
      renderGrid(main as any, state);
      dispatch(doc, tagBtn(), "click");
      dispatch(doc, doc, "keydown", { key: "Escape" });
      expect(pop().hidden).toBe(true);
      expect(doc.activeElement).toBe(tagBtn());
    });

    it("does not leak the popover keydown listener across rerenders", () => {
      renderGrid(main as any, state);
      dispatch(doc, tagBtn(), "click");
      expect(doc.listenerCount("keydown")).toBe(1);
      renderGrid(main as any, state); // rebuild while open, e.g. a category change
      expect(doc.listenerCount("keydown")).toBe(0);
      dispatch(doc, tagBtn(), "click");
      dispatch(doc, tagBtn(), "click"); // close again
      expect(doc.listenerCount("keydown")).toBe(0);
    });
  });
});
