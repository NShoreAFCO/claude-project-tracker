import { describe, expect, it } from "vitest";

// @ts-expect-error untyped JS module
const { compareCode, sortByCode, sortTreeByCode, sortWpRows } = (await import("../public/js/order.js")) as any;
const codes = (l: any[]) => l.map((w) => w.code ?? w.title);
const wp = (code: string | null, extra: object = {}) => ({ code, ...extra });

describe("compareCode", () => {
  it("orders numeric parts as numbers", () => {
    const sorted = ["WP10", "WP2", "WP1.2", "WP1", "WP1.1"].sort(compareCode);
    expect(sorted).toEqual(["WP1", "WP1.1", "WP1.2", "WP2", "WP10"]);
  });
  it("orders task codes", () => {
    const sorted = ["T40", "T10", "T02", "T09", "T01"].sort(compareCode);
    expect(sorted).toEqual(["T01", "T02", "T09", "T10", "T40"]);
  });
  it("compares prefix letters first", () => {
    expect(compareCode("T01", "WP1")).toBeLessThan(0);
    expect(compareCode("WP5", "WP5")).toBe(0);
  });
  it("is null-safe: missing codes sort last", () => {
    expect(compareCode(null, "WP1")).toBeGreaterThan(0);
    expect(compareCode("WP1", undefined)).toBeLessThan(0);
    expect(compareCode(null, "")).toBe(0);
  });
});

describe("sortByCode", () => {
  it("sorts siblings and returns a new array", () => {
    const input = [wp("WP3"), wp("WP1.1"), wp("WP1")];
    const out = sortByCode(input);
    expect(codes(out)).toEqual(["WP1", "WP1.1", "WP3"]);
    expect(codes(input)).toEqual(["WP3", "WP1.1", "WP1"]);
  });
  it("puts rows without a code after the coded ones, by sort then title", () => {
    const out = sortByCode([
      wp(null, { title: "b", sort: 1 }),
      wp("WP2"),
      wp(null, { title: "a", sort: 1 }),
      wp(null, { title: "z", sort: 0 }),
      wp("WP1"),
    ]);
    expect(codes(out)).toEqual(["WP1", "WP2", "z", "a", "b"]);
  });
  it("is stable for equal codes", () => {
    const out = sortByCode([wp("WP1", { id: 1 }), wp("WP1", { id: 2 }), wp("WP1", { id: 3 })]);
    expect(out.map((w: any) => w.id)).toEqual([1, 2, 3]);
  });
  it("handles an empty or missing list", () => {
    expect(sortByCode([])).toEqual([]);
    expect(sortByCode(undefined)).toEqual([]);
  });
});

describe("sortTreeByCode", () => {
  it("sorts every level and keeps the tree", () => {
    const out = sortTreeByCode([wp("WP2", { children: [wp("WP2.10"), wp("WP2.2")] }), wp("WP1")]);
    expect(codes(out)).toEqual(["WP1", "WP2"]);
    expect(codes(out[1].children)).toEqual(["WP2.2", "WP2.10"]);
  });
});

describe("sortWpRows", () => {
  const rows = [
    { project_title: "B", project_id: "b", code: "WP1", end_date: "2026-01-02", status: "todo" },
    { project_title: "A", project_id: "a", code: "WP10", end_date: "2026-01-02", status: "doing" },
    { project_title: "A", project_id: "a", code: "WP2", end_date: null, status: "todo" },
  ];
  it("project: by project, then code", () => {
    expect(sortWpRows(rows, "project").map((r: any) => r.code)).toEqual(["WP2", "WP10", "WP1"]);
  });
  it("end: date order, empty last, code as tie-break", () => {
    expect(sortWpRows(rows, "end").map((r: any) => r.code)).toEqual(["WP10", "WP1", "WP2"]);
  });
  it("in_progress: doing first", () => {
    expect(sortWpRows(rows, "in_progress").map((r: any) => r.code)).toEqual(["WP10", "WP2", "WP1"]);
  });
});
