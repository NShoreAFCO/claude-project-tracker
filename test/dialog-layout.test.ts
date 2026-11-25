// Project dialog layout: done toggle, one action per row, slim gate and milestone rows.
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

describe('done toggle helpers', () => {
  const kids = [{ id: 'k', code: 'WP1.1', title: 'K', status: 'doing' }];
  const tops: any[] = [
    { id: 'a', code: 'WP1', title: 'Alpha', status: 'done', children: kids },
    { id: 'b', code: 'WP2', title: 'Beta', status: 'doing', children: kids },
    { id: 'c', code: 'WP3', title: 'Gamma', status: 'dropped', children: kids },
    { id: 'd', code: 'WP4', title: 'Delta', status: 'done' },
  ];

  it('counts only done or dropped top-level WPs that have sub-WPs', () => {
    expect(tree.doneSubCount(tops)).toBe(2);
    expect(tree.doneSubCount([tops[1], tops[3]])).toBe(0);
    expect(tree.hasFoldableSubs(tops[2])).toBe(true);
    expect(tree.hasFoldableSubs(tops[3])).toBe(false);
  });

  it('flips the label between Show and Hide', () => {
    expect(tree.doneToggleLabel(2, false)).toBe('2 done · Show');
    expect(tree.doneToggleLabel(2, true)).toBe('2 done · Hide');
  });

  it('no longer exports the old fold line', () => {
    expect(tree.doneFold).toBeUndefined();
    expect(tree.splitDone).toBeUndefined();
  });

  it('a reached milestone on a hidden sub-WP lands after its done top-level WP; shown, after the sub-WP', () => {
    const tr = [
      { id: 'a', status: 'done', children: [{ id: 'a1', children: [] }, { id: 'a2', children: [] }] },
      { id: 'b', status: 'doing', children: [] },
    ];
    const ms = [{ id: 'm', requires: ['a1'], reached_at: '2026-11-01' }];
    const hiddenPlan = sched.placeMilestones(tr, ms, (w: any) => w.id !== 'a');
    expect((hiddenPlan.after.get('a') ?? []).map((m: any) => m.id)).toEqual(['m']);
    const shownPlan = sched.placeMilestones(tr, ms, () => true);
    expect((shownPlan.after.get('a1') ?? []).map((m: any) => m.id)).toEqual(['m']);
    expect(shownPlan.after.get('a')).toBeUndefined();
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
