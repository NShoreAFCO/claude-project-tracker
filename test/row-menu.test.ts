// Row menu placement and the primary "Record decision" button on a reached gate.
import { beforeEach, describe, expect, it } from "vitest";
import { dispatch, installFakeDom, type FDoc, type FEl } from "./fake-dom";

let doc: FDoc;
let dom: any;
let tree: any;
let sched: any;

beforeEach(async () => {
  doc = installFakeDom();
  // @ts-expect-error plain browser module without types
  dom = await import("../public/js/dom.js");
  // @ts-expect-error plain browser module without types
  tree = await import("../public/js/wp-tree.js");
  // @ts-expect-error plain browser module without types
  sched = await import("../public/js/schedule-ui.js");
});

const rect = (left: number, top: number, width = 30, height = 24) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

describe("menuPlacement", () => {
  const list = { listWidth: 176, listHeight: 80, vw: 1920, vh: 1000 };

  it("aligns the left edges when the list would cross the left edge", () => {
    expect(dom.menuPlacement({ btn: rect(100, 100), ...list })).toEqual({ alignStart: true, openUp: false });
  });
  it("keeps the default near the right edge", () => {
    expect(dom.menuPlacement({ btn: rect(1800, 100), ...list })).toEqual({ alignStart: false, openUp: false });
  });
  it("opens upward near the bottom when there is more room above", () => {
    expect(dom.menuPlacement({ btn: rect(1800, 960), ...list })).toEqual({ alignStart: false, openUp: true });
  });
  it("stays down near the bottom when there is no more room above", () => {
    expect(dom.menuPlacement({ btn: rect(1800, 20), ...list, vh: 90 })).toEqual({ alignStart: false, openUp: false });
  });
  it("keeps the defaults for zero or missing rects", () => {
    expect(dom.menuPlacement({ btn: rect(0, 0, 0, 0), ...list })).toEqual({ alignStart: false, openUp: false });
    expect(dom.menuPlacement({ btn: undefined, ...list })).toEqual({ alignStart: false, openUp: false });
  });
});

describe("menuButton opening", () => {
  function menu(btnRect: any, listRect: any) {
    const wrap = dom.menuButton("More", [{ label: "Delete", onClick: () => {} }]);
    doc.body.append(wrap);
    const btn = wrap.querySelector(".menu-btn")!;
    const list = wrap.querySelector(".menu-list")!;
    (btn as any).getBoundingClientRect = () => btnRect;
    (list as any).getBoundingClientRect = () => listRect;
    return { btn, list };
  }

  it("applies align-start on open and clears it on close", () => {
    (globalThis as any).innerWidth = 1920;
    (globalThis as any).innerHeight = 1000;
    const { btn, list } = menu(rect(100, 100), rect(0, 0, 176, 80));
    dispatch(doc, btn, "click");
    expect(list.hidden).toBe(false);
    expect(list.classList.contains("align-start")).toBe(true);
    dispatch(doc, btn, "click");
    expect(list.hidden).toBe(true);
    expect(list.classList.contains("align-start")).toBe(false);
  });

  it("applies open-up near the bottom and clears it on close", () => {
    (globalThis as any).innerWidth = 1920;
    (globalThis as any).innerHeight = 1000;
    const { btn, list } = menu(rect(1800, 960), rect(0, 0, 176, 80));
    dispatch(doc, btn, "click");
    expect(list.classList.contains("open-up")).toBe(true);
    expect(list.classList.contains("align-start")).toBe(false);
    dispatch(doc, btn, "click");
    expect(list.classList.contains("open-up")).toBe(false);
  });

  it("keeps the defaults when the rects are zero", () => {
    const { btn, list } = menu(rect(0, 0, 0, 0), rect(0, 0, 0, 0));
    dispatch(doc, btn, "click");
    expect(list.classList.contains("align-start")).toBe(false);
    expect(list.classList.contains("open-up")).toBe(false);
  });
});

describe("gateDecisionPending", () => {
  it("is true for a reached gate with a pending or missing decision state", () => {
    expect(sched.gateDecisionPending({ gate: true, decision_state: "pending" })).toBe(true);
    expect(sched.gateDecisionPending({ gate: true, reached: true })).toBe(true);
  });
  it("is false for decided, open and plain milestones", () => {
    expect(sched.gateDecisionPending({ gate: true, reached: true, decision_state: "go" })).toBe(false);
    expect(sched.gateDecisionPending({ gate: true, reached: false, decision_state: "none" })).toBe(false);
    expect(sched.gateDecisionPending({ gate: false, reached: true, decision_state: "pending" })).toBe(false);
  });
});

describe("row actions with a primary button", () => {
  const edit = { label: "Edit", onClick: () => {} };
  const del = { label: "Delete", danger: true, onClick: () => {} };
  const visible = (box: FEl) => box.querySelectorAll("button").filter((b: FEl) => !b.closest(".menu-list"));
  const menuLabels = (box: FEl) => box.querySelectorAll(".menu-item").map((b: FEl) => b.textContent);

  /** Same decision as the project dialog's row builder. */
  function row(ms: any, canDecide: boolean, onDecide: () => void, gate?: (x: any) => any) {
    const decide = ms.gate && canDecide ? { label: "Record decision", onClick: onDecide } : null;
    const primary = decide && sched.gateDecisionPending(ms) ? decide : null;
    return tree.rowActions({ edit, primary, menuLabel: "More", gate, items: [primary ? null : decide, del] });
  }

  it("reached gate with pending decision: Record decision, Edit, menu holds Delete only", () => {
    let decided = 0;
    const box = row({ gate: true, reached: true, decision_state: "pending" }, true, () => decided++);
    doc.body.append(box);
    expect(visible(box).map((b: FEl) => b.textContent)).toEqual(["Record decision", "Edit", "⋯"]);
    expect(visible(box)[0].classList.contains("secondary")).toBe(false);
    expect(visible(box)[1].classList.contains("secondary")).toBe(true);
    expect(menuLabels(box)).toEqual(["Delete"]);
    dispatch(doc, visible(box)[0], "click");
    expect(decided).toBe(1);
  });

  it("reached and decided gate: Edit, menu with Record decision and Delete", () => {
    const box = row({ gate: true, reached: true, decision_state: "go" }, true, () => {});
    expect(visible(box).map((b: FEl) => b.textContent)).toEqual(["Edit", "⋯"]);
    expect(menuLabels(box)).toEqual(["Record decision", "Delete"]);
  });

  it("open gate: Edit, menu with Record decision and Delete", () => {
    const box = row({ gate: true, reached: false, decision_state: "none" }, true, () => {});
    expect(visible(box).map((b: FEl) => b.textContent)).toEqual(["Edit", "⋯"]);
    expect(menuLabels(box)).toEqual(["Record decision", "Delete"]);
  });

  it("plain milestone: Edit, menu with Delete", () => {
    const box = row({ gate: false, reached: true }, true, () => {});
    expect(visible(box).map((b: FEl) => b.textContent)).toEqual(["Edit", "⋯"]);
    expect(menuLabels(box)).toEqual(["Delete"]);
  });

  it("reader without decide on a pending gate: Edit, menu with Delete", () => {
    const box = row({ gate: true, reached: true, decision_state: "pending" }, false, () => {});
    expect(visible(box).map((b: FEl) => b.textContent)).toEqual(["Edit", "⋯"]);
    expect(menuLabels(box)).toEqual(["Delete"]);
  });
});
