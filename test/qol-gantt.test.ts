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

  it("late start after the planned end: overdue starts at the actual start, no empty actual segment", () => {
    const open = barParts({ ...plan, actual_start: "2026-03-14" }, "2026-03-20")!;
    expect(open.actual).toBeNull();
    expect(open.overdue).toEqual({ from: d("2026-03-14"), to: d("2026-03-21"), closed: false });
    const done = barParts({ ...plan, status: "done", actual_start: "2026-03-14", actual_end: "2026-03-16" }, "2026-04-01")!;
    expect(done.actual).toBeNull();
    expect(done.overdue).toEqual({ from: d("2026-03-14"), to: d("2026-03-17"), closed: true });
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

  it("a milestone is drawn once, on the topmost of its WP rows", () => {
    const { placed } = placeMarks([rowA, rowB], [ms({ due_date: "2026-01-01", requires: ["b1", "a"] })], topOf);
    expect(placed.get(rowA)).toHaveLength(1);
    expect(placed.has(rowB)).toBe(false);
    const attached = placeMarks([rowA, rowB], [ms({ due_date: "2026-01-01", workpackage_id: "b", requires: ["a1"] })], topOf);
    expect(attached.placed.get(rowA)).toHaveLength(1);
    expect(attached.placed.size).toBe(1);
  });

  it("a gate is drawn on every row it unlocks", () => {
    const gate = ms({ gate: 1, due_date: "2026-01-01", unlocks: ["b", "a1"] });
    const { placed } = placeMarks([rowA, rowA1, rowB], [gate], topOf);
    expect(placed.get(rowA1)).toHaveLength(1);
    expect(placed.get(rowB)).toHaveLength(1);
    expect(placed.get(rowA1)[0].label).toBe(placed.get(rowB)[0].label);
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

  it("numbers independently per project and kind, equal dates keep input order", () => {
    const q = { id: "q" };
    const e = [
      ms({ id: "1", due_date: "2026-05-01", workpackage_id: "a" }),
      ms({ id: "2", due_date: "2026-05-01", workpackage_id: "a" }),
      { m: { id: "3", title: "t", due_date: "2026-01-01", workpackage_id: "a" }, p: q },
      ms({ id: "4", gate: 1, due_date: "2026-06-01", workpackage_id: "a" }),
    ];
    const marks = placeMarks([rowA], e, topOf).placed.get(rowA);
    const byId = Object.fromEntries(marks.map((k: any) => [k.m.id, k.label]));
    expect(byId).toEqual({ "1": "M1", "2": "M2", "3": "M1", "4": "G1" });
  });
});

// @ts-expect-error untyped JS module
const marks = (await import("../public/js/gantt-marks.js")) as unknown as { markEdges: (...a: any[]) => any[]; markArrowPath: (...a: any[]) => string };

describe("mark arrows (R6)", () => {
  const rowA = { w: { id: "a" } };
  const rowB = { w: { id: "b" } };
  const rowC = { w: { id: "c" } };
  const resolve = (id: string) => ({ a: rowA, b: rowB, c: rowC })[id as "a"] ?? null;

  it("one arrow per required WP to the single diamond; same-row and unknown sources are skipped", () => {
    const mk = { m: { id: "m1", requires: ["a", "b", "zz", "c"] }, row: rowC, kind: "milestone" };
    const edges = marks.markEdges(new Map([[rowC, [mk]]]), resolve);
    expect(edges.map((e) => e.fromId)).toEqual(["a", "b"]);
    expect(edges.every((e) => e.mark === mk && e.toId === "m1")).toBe(true);
  });

  it("a gate on two rows gets an arrow from the required WP to each flag", () => {
    const g = { id: "g1", requires: [{ workpackage_id: "a" }] };
    const edges = marks.markEdges(
      new Map([
        [rowB, [{ m: g, row: rowB, kind: "gate" }]],
        [rowC, [{ m: g, row: rowC, kind: "gate" }]],
      ]),
      resolve,
    );
    expect(edges.map((e) => e.mark.row)).toEqual([rowB, rowC]);
  });

  it("arrow enters the top vertex from above and the bottom vertex from below", () => {
    expect(marks.markArrowPath(10, 20, 50, 60, 8)).toBe("M 10 20 H 50 V 52");
    expect(marks.markArrowPath(10, 100, 50, 60, 8)).toBe("M 10 100 H 50 V 68");
  });
});
