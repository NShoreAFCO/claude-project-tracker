import { describe, expect, it } from "vitest";

// @ts-expect-error untyped JS module
const mod = (await import("../public/js/schedule-view.js")) as unknown as {
  placeMilestones: (
    tree: any[],
    ms: any[],
    isOpen?: (w: any) => boolean,
  ) => { before: Map<string, any[]>; after: Map<string, any[]>; tail: any[] };
};
const { placeMilestones } = mod;
const ids = (l?: any[]) => (l ?? []).map((m) => m.id);
const tree = [
  { id: "a", children: [{ id: "a1" }, { id: "a2" }] },
  { id: "b" },
  { id: "c" },
];

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
    const r = placeMilestones(tree, [
      { id: "m", requires: ["a1", "a2"] },
      { id: "g", gate: true, unlocks: ["a2"] },
    ], folded);
    expect(ids(r.after.get("a"))).toEqual(["m"]);
    expect(ids(r.before.get("a"))).toEqual(["g"]);
  });
  it("an open parent: milestone sits after the last child", () => {
    const r = placeMilestones(tree, [{ id: "m", requires: ["a1", "a2"] }]);
    expect(ids(r.after.get("a2"))).toEqual(["m"]);
  });
  it("a milestone without links goes to the end", () => {
    const r = placeMilestones(tree, [{ id: "m", requires: [] }, { id: "n", requires: ["zz"] }]);
    expect(ids(r.tail)).toEqual(["m", "n"]);
  });
});
