// Grid filters (QoL D10) and the card (D11): pure filter logic and the card markup.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser module without types
import { filterProjects, orderTags, statusOptions, completedMode, saveGridFilter, loadGridFilter } from "../public/js/grid.js";
// @ts-expect-error plain browser module without types
import { GRID_FILTER_KEY, resetGridFilter } from "../public/js/sidebar.js";

const P = (id: string, status: string, tags: string[] = []) => ({ id, status, tags, category: null, owner_id: null, owner_initials: null });
const projects = [P("a", "active", ["x", "y"]), P("b", "done", ["x"]), P("c", "abandoned", ["y"]), P("d", "idea", ["x", "y", "z"])];
const ids = (f: any) => filterProjects(projects, f).map((p: any) => p.id);
const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
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

describe("tag filter", () => {
  it("ANDs checked tags", () => {
    expect(ids({ completed: "all", tags: ["x", "y"] })).toEqual(["a", "d"]);
    expect(ids({ completed: "all", tags: ["x", "y", "z"] })).toEqual(["d"]);
  });
  it("lists checked tags first, then alphabetical", () => {
    expect(orderTags(["b", "a", "c", "d", "a"], ["c", "b"])).toEqual(["b", "c", "a", "d"]);
  });
});
