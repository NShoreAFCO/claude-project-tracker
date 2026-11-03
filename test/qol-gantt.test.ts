import { describe, expect, it } from "vitest";

type Parts = Record<string, any> | null;
// @ts-expect-error untyped JS module
const mod = (await import("../public/js/gantt-marks.js")) as unknown as {
  barParts: (wp: Record<string, unknown>, today: string | number) => Parts;
  dayOf: (ymd: string) => number;
};
const { barParts, dayOf } = mod;
const d = (ymd: string) => dayOf(ymd);
const plan = { start_date: "2026-03-01", end_date: "2026-03-10", status: "doing", progress: 50 };

describe("barParts", () => {
  it("on time, in progress: bold outline to today, progress share of the plan", () => {
    const p = barParts({ ...plan, actual_start: "2026-03-02" }, "2026-03-05")!;
    expect(p.planned).toEqual({ from: d("2026-03-01"), to: d("2026-03-11") });
    expect(p.actual).toEqual({ from: d("2026-03-02"), to: d("2026-03-06") });
    expect(p.overdue).toBeNull();
    expect(p.progress).toEqual({ from: d("2026-03-01"), to: d("2026-03-01") + 5 });
  });

  it("late, in progress: dashed continuation to today", () => {
    const p = barParts({ ...plan, progress: 100, actual_start: "2026-03-02" }, "2026-03-15")!;
    expect(p.actual).toEqual({ from: d("2026-03-02"), to: d("2026-03-11") });
    expect(p.overdue).toEqual({ from: d("2026-03-11"), to: d("2026-03-16"), closed: false });
    expect(p.progress!.to).toBe(d("2026-03-11"));
  });

  it("completed late: dashed outline closed at actual end, fill stops at planned end", () => {
    const p = barParts({ ...plan, status: "done", actual_start: "2026-03-02", actual_end: "2026-03-14" }, "2026-04-01")!;
    expect(p.overdue).toEqual({ from: d("2026-03-11"), to: d("2026-03-15"), closed: true });
    expect(p.progress).toEqual({ from: d("2026-03-01"), to: d("2026-03-11") });
  });

  it("completed early: no overdue, outline ends at actual end", () => {
    const p = barParts({ ...plan, status: "done", actual_start: "2026-03-01", actual_end: "2026-03-06" }, "2026-04-01")!;
    expect(p.overdue).toBeNull();
    expect(p.actual).toEqual({ from: d("2026-03-01"), to: d("2026-03-07") });
    expect(p.progress!.to).toBe(d("2026-03-11"));
  });

  it("no plan with actual: solid span, no planned or progress", () => {
    const p = barParts({ status: "doing", actual_start: "2026-03-02" }, "2026-03-05")!;
    expect(p.solid).toEqual({ from: d("2026-03-02"), to: d("2026-03-06") });
    expect(p.planned).toBeNull();
    expect(p.progress).toBeNull();
    expect(p.extent).toEqual({ from: d("2026-03-02"), to: d("2026-03-06") });
  });

  it("actual end only: small block at the end day", () => {
    const p = barParts({ ...plan, actual_end: "2026-03-08" }, "2026-04-01")!;
    expect(p.block).toEqual({ from: d("2026-03-08"), to: d("2026-03-09") });
    expect(p.actual).toBeNull();
    expect(barParts({ actual_end: "2026-03-08" }, "2026-04-01")!.block).not.toBeNull();
  });

  it("nothing: null, dates are not invented", () => {
    expect(barParts({ status: "todo" }, "2026-03-05")).toBeNull();
  });
});

// @ts-expect-error untyped JS module
const { placeMarks } = (await import("../public/js/gantt-marks.js")) as unknown as { placeMarks: (...a: any[]) => any };

describe("placeMarks", () => {
  const rowA = { w: { id: "a" } };
  const rowA1 = { w: { id: "a1" } };
  const rowB = { w: { id: "b" } };
  const topOf = new Map([
    ["a", "a"],
    ["a1", "a"],
    ["b", "b"],
    ["b1", "b"],
  ]);
  const p = { id: "p" };
  const ms = (o: Record<string, unknown>) => ({ m: { id: "x", title: "t", ...o }, p });

  it("attached milestone sits on its main WP's row", () => {
    const { placed } = placeMarks([rowA, rowB], [ms({ due_date: "2026-01-01", workpackage_id: "a1" })], topOf);
    expect(placed.get(rowA)[0].label).toBe("M1");
  });

  it("falls back to the last requires WP's main row", () => {
    const { placed } = placeMarks([rowA, rowB], [ms({ due_date: "2026-01-01", requires: ["a", "b1"] })], topOf);
    expect(placed.get(rowB)).toHaveLength(1);
    expect(placed.has(rowA)).toBe(false);
  });

  it("gate goes on the unlocked sub-WP row when visible, else on its main row", () => {
    const gate = ms({ gate: 1, due_date: "2026-01-01", unlocks: ["a1"] });
    expect(placeMarks([rowA, rowA1], [gate], topOf).placed.get(rowA1)[0].label).toBe("G1");
    expect(placeMarks([rowA], [gate], topOf).placed.get(rowA)[0].kind).toBe("gate");
  });

  it("unlinked or unplaceable marks are unplaced", () => {
    const { placed, unplaced } = placeMarks([rowA], [ms({ due_date: "2026-01-01" }), ms({ requires: ["b"] })], topOf);
    expect(placed.size).toBe(0);
    expect(unplaced).toHaveLength(2);
  });

  it("numbers by due date per project and kind, undated last", () => {
    const e = [
      ms({ id: "1", due_date: "2026-05-01", workpackage_id: "a" }),
      ms({ id: "2", workpackage_id: "a" }),
      ms({ id: "3", due_date: "2026-02-01", workpackage_id: "a" }),
    ];
    const marks = placeMarks([rowA], e, topOf).placed.get(rowA);
    const byId = Object.fromEntries(marks.map((k: any) => [k.m.id, k.label]));
    expect(byId).toEqual({ "3": "M1", "1": "M2", "2": "M3" });
  });
});
