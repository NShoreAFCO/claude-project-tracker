// Project dialog layout: done work packages fold, one action per row, slim gate and milestone rows.
import { beforeEach, describe, expect, it } from "vitest";
import { dispatch, installFakeDom, type FDoc, type FEl } from "./fake-dom";

let doc: FDoc;
let tree: any;
let dom: any;
let sched: any;

beforeEach(async () => {
  doc = installFakeDom();
  // @ts-expect-error plain browser module without types
  tree = await import("../public/js/wp-tree.js");
  // @ts-expect-error plain browser module without types
  dom = await import("../public/js/dom.js");
  // @ts-expect-error plain browser module without types
  sched = await import("../public/js/schedule-view.js");
});

type W = { id: string; code: string; title: string; status: string; children?: W[] };
const wps: W[] = [
  { id: "a", code: "WP1", title: "Alpha", status: "done" },
  { id: "b", code: "WP2", title: "Beta", status: "doing" },
  { id: "c", code: "WP3", title: "Gamma", status: "dropped" },
  { id: "d", code: "WP4", title: "Delta", status: "planned" },
];

/** Same assembly as the project dialog's top level. */
function topLevel(foldOpen: boolean, toggle: () => void) {
  const row = (w: W) => dom.h("li.tw-item", w.code);
  const { open, done } = tree.splitDone(wps);
  return dom.h("ul.tw-tree", [...tree.doneFold({ count: done.length, open: foldOpen, onToggle: toggle, rows: done.map(row) }), ...open.map(row)]);
}

describe("done fold", () => {
  it("folds done and dropped top-level WPs into one line with the count", () => {
    const ul = topLevel(false, () => {});
    doc.body.append(ul);
    const fold = ul.querySelector(".tw-donefold")!;
    expect(fold.textContent).toContain("2");
    expect(fold.querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
    expect(ul.querySelectorAll(".tw-item").map((li: FEl) => li.textContent)).toEqual(["WP2", "WP4"]);
  });

  it("expands the done blocks in place after Show", () => {
    let openFold = false;
    let ul = topLevel(openFold, () => {});
    const rebuild = () => {
      ul = topLevel(openFold, toggle);
      doc.body.replaceChildren(ul);
    };
    const toggle = () => {
      openFold = !openFold;
      rebuild();
    };
    rebuild();
    dispatch(doc, ul.querySelector(".tw-donefold-btn")!, "click");
    expect(ul.querySelector(".tw-donefold-btn")!.getAttribute("aria-expanded")).toBe("true");
    expect(ul.querySelectorAll(".tw-item").map((li: FEl) => li.textContent)).toEqual(["WP1", "WP3", "WP2", "WP4"]);
  });

  it("renders no fold line when nothing is done", () => {
    expect(tree.doneFold({ count: 0, open: false, onToggle: () => {} })).toEqual([]);
  });
});

describe("row actions", () => {
  const items = [
    { label: "Sub-package", onClick: () => {} },
    null,
    { label: "Delete", danger: true, onClick: () => {} },
  ];

  it("a writer sees exactly one visible action button plus the menu button", () => {
    const box = tree.rowActions({ edit: { label: "Edit", onClick: () => {} }, items, menuLabel: "More actions" });
    doc.body.append(box);
    const visible = box.querySelectorAll("button").filter((b: FEl) => !b.closest(".menu-list"));
    expect(visible.map((b: FEl) => b.textContent)).toEqual(["Edit", "⋯"]);
    expect(box.querySelector(".menu-btn")!.getAttribute("aria-label")).toBe("More actions");
    expect(box.querySelectorAll(".menu-item")).toHaveLength(2);
  });

  it("a viewer gets nothing when the gate refuses", () => {
    const box = tree.rowActions({ edit: { label: "Edit", onClick: () => {} }, items, menuLabel: "x", gate: () => null });
    expect(box).toBeNull();
  });
});

describe("gate and milestone rows", () => {
  const today = "2026-11-23";
  const gate = { id: "g", title: "Go live", gate: true, due_date: "2026-12-01", requires: [], unlocks: ["w"], decision_state: "none" };
  const base = { today, requiresText: "WP1", unlocksText: "WP2" };

  it("is one slim row with title, due date, requires and unlocks", () => {
    const li = tree.slimMilestoneRow(gate, base);
    doc.body.append(li);
    expect(li.classList.contains("tw-ms")).toBe(true);
    expect(li.textContent).toContain("Go live");
    expect(li.querySelector(".tw-ms-req")!.textContent).toContain("WP1");
    expect(li.querySelector(".tw-ms-unl")!.textContent).toContain("WP2");
    expect(li.querySelector(".tw-ms-due")!.textContent).toContain("2026");
  });

  it("keeps the overdue chip, schedule issues, baseline, slip and critical mark on the row", () => {
    const ms = {
      id: "m",
      title: "Late one",
      due_date: "2026-11-01",
      done: false,
      critical: true,
      baseline_end: "2026-10-20",
      slip_days: 12,
      schedule_issues: JSON.stringify([{ type: "needs_unscheduled", related_id: "w" }]),
    };
    const li = tree.slimMilestoneRow(ms, { ...base, titleOf: () => "Some WP" });
    doc.body.append(li);
    expect(li.querySelector(".chip.late")).not.toBeNull();
    expect(li.querySelector(".badge.issue")).not.toBeNull();
    expect(li.querySelector(".slip")).not.toBeNull();
    expect(li.querySelector(".badge.critical")).not.toBeNull();
    expect(li.textContent).toContain("2026");
  });

  it("shows the last decision of a gate", () => {
    const decided = {
      ...gate,
      decision_state: "go",
      decisions: [{ decision: "go", decided_by: { name: "Sam Lead" }, decided_at: "2026-11-20T10:00:00Z" }],
    };
    const li = tree.slimMilestoneRow(decided, base);
    doc.body.append(li);
    expect(li.querySelector(".tw-ms-last")!.textContent).toContain("Sam Lead");
    expect(tree.slimMilestoneRow(gate, base).querySelector(".tw-ms-last")).toBeNull();
  });

  it("a gate sits before the first WP it unlocks", () => {
    const tr = [
      { id: "x", title: "X", children: [] },
      { id: "w", title: "W", children: [] },
    ];
    const plan = sched.placeMilestones(tr, [gate]);
    expect((plan.before.get("w") ?? []).map((m: any) => m.id)).toEqual(["g"]);
    expect(plan.before.get("x")).toBeUndefined();
  });
});
