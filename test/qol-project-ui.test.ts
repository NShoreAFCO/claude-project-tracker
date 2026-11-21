import { describe, expect, it } from "vitest";

// @ts-expect-error untyped JS module
const mod = (await import("../public/js/schedule-view.js")) as unknown as {
  placeMilestones: (
    tree: any[],
    ms: any[],
    isOpen?: (w: any) => boolean,
  ) => { before: Map<string, any[]>; after: Map<string, any[]>; tail: any[] };
};
const { placeMilestones, pruneTree } = mod as any;
const ids = (l?: any[]) => (l ?? []).map((m) => m.id);
const tree = [{ id: "a", children: [{ id: "a1" }, { id: "a2" }] }, { id: "b" }, { id: "c" }];

describe("placeMilestones", () => {
  it("puts a milestone after the last of its required WPs", () => {
    const r = placeMilestones(tree, [{ id: "m", requires: ["b", "a1"] }]);
    expect(ids(r.after.get("b"))).toEqual(["m"]);
    expect(r.tail).toEqual([]);
  });
  it("uses the attached WP when there are no requires", () => {
    const r = placeMilestones(tree, [{ id: "m", requires: [], workpackage_id: "c" }]);
    expect(ids(r.after.get("c"))).toEqual(["m"]);
  });
  it("puts a gate before the first WP it unlocks", () => {
    const r = placeMilestones(tree, [{ id: "g", gate: true, requires: ["a1"], unlocks: ["c", "b"] }]);
    expect(ids(r.before.get("b"))).toEqual(["g"]);
    expect(r.after.size).toBe(0);
  });
  it("a folded parent stands in for its children", () => {
    const folded = (w: any) => w.id !== "a";
    const r = placeMilestones(
      tree,
      [
        { id: "m", requires: ["a1", "a2"] },
        { id: "g", gate: true, unlocks: ["a2"] },
      ],
      folded,
    );
    expect(ids(r.after.get("a"))).toEqual(["m"]);
    expect(ids(r.before.get("a"))).toEqual(["g"]);
  });
  it("an open parent: milestone sits after the last child", () => {
    const r = placeMilestones(tree, [{ id: "m", requires: ["a1", "a2"] }]);
    expect(ids(r.after.get("a2"))).toEqual(["m"]);
  });
  it("a milestone without links goes to the end", () => {
    const r = placeMilestones(tree, [
      { id: "m", requires: [] },
      { id: "n", requires: ["zz"] },
    ]);
    expect(ids(r.tail)).toEqual(["m", "n"]);
  });
});

describe("pruneTree + placeMilestones", () => {
  const nested = [{ id: "a", children: [{ id: "a1", children: [{ id: "a1x" }] }, { id: "a2" }] }, { id: "b" }];
  it("keeps everything without a filter", () => {
    expect(pruneTree(nested, null)).toEqual(nested);
  });
  it("drops hidden descendants at every depth", () => {
    const pruned = pruneTree(nested, new Set(["a", "a1", "b"]));
    expect(pruned[0].children.map((w: any) => w.id)).toEqual(["a1"]);
    expect(pruned[0].children[0].children).toEqual([]);
  });
  it("a hidden descendant no longer anchors a milestone (it falls back to the shown ones or the tail)", () => {
    const shown = new Set(["a", "a1", "b"]);
    const r = placeMilestones(pruneTree(nested, shown), [
      { id: "m", requires: ["a1", "a2"] },
      { id: "n", requires: ["a1x"] },
    ]);
    expect(ids(r.after.get("a1"))).toEqual(["m"]);
    expect(r.after.has("a2")).toBe(false);
    expect(ids(r.tail)).toEqual(["n"]);
  });
});

describe("code order in the work package tree", () => {
  it("renders rows in code order from a shuffled fixture, with milestones in the running context", async () => {
    // @ts-expect-error untyped JS module
    const { sortTreeByCode } = (await import("../public/js/order.js")) as any;
    const shuffled = [
      { id: "w10", code: "WP10" },
      { id: "w2", code: "WP2", children: [{ id: "w2b", code: "WP2.2" }, { id: "w2a", code: "WP2.1" }] },
      { id: "w1", code: "WP1" },
    ];
    const sorted = sortTreeByCode(shuffled);
    expect(sorted.map((w: any) => w.id)).toEqual(["w1", "w2", "w10"]);
    expect(sorted[1].children.map((w: any) => w.id)).toEqual(["w2a", "w2b"]);
    const r = placeMilestones(sorted, [{ id: "m", requires: ["w2b", "w1"] }]);
    expect(ids(r.after.get("w2b"))).toEqual(["m"]);
  });
});
