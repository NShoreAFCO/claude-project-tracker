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
