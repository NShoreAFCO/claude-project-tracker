// Row menu in the top layer, milestone row columns, visible "Mark complete" button on a finished work package.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch, installFakeDom, type FDoc } from "./fake-dom";

const state = vi.hoisted(() => ({ write: true, sign: true }));
vi.mock("../public/js/access.js", async (orig) => ({
  ...(await orig<object>()),
  can: (a: string) => (a === "verify_sign_off" ? state.sign : state.write),
  gate: (el: any) => el,
}));
const markCompleteDialog = vi.hoisted(() => vi.fn());
vi.mock("../public/js/forms.js", async (orig) => ({ ...(await orig<object>()), markCompleteDialog }));
// @ts-expect-error untyped JS module
import { markDoneRowButton } from "../public/js/project.js";
// @ts-expect-error untyped JS module
import { canMarkDone, slimMilestoneRow } from "../public/js/wp-tree.js";
// @ts-expect-error untyped JS module
import * as dom from "../public/js/dom.js";

const rect = (left: number, top: number, width = 30, height = 24) => ({ left, top, width, height, right: left + width, bottom: top + height });

describe("menuButton with the Popover API", () => {
  let doc: FDoc;
  let proto: any;
  const calls: string[] = [];
  const props: Record<string, string> = {};
  const listeners: Record<string, () => void> = {};

  beforeEach(() => {
    doc = installFakeDom();
    calls.length = 0;
    for (const k of Object.keys(props)) delete props[k];
    (globalThis as any).innerWidth = 1920;
    (globalThis as any).innerHeight = 1000;
    (globalThis as any).addEventListener = (t: string, fn: () => void) => void (listeners[t] = fn);
    (globalThis as any).removeEventListener = (t: string) => void delete listeners[t];
    proto = Object.getPrototypeOf(doc.createElement("ul"));
  });

  function make(withPopover: boolean, btnRect: any) {
    if (withPopover) {
      proto.showPopover = () => calls.push("show");
      proto.hidePopover = () => calls.push("hide");
    } else {
      delete proto.showPopover;
      delete proto.hidePopover;
    }
    const wrap = dom.menuButton("More", [{ label: "Delete", onClick: () => {} }]);
    doc.body.append(wrap);
    const btn = wrap.querySelector(".menu-btn")!;
    const list = wrap.querySelector(".menu-list")!;
    (btn as any).getBoundingClientRect = () => btnRect;
    (list as any).getBoundingClientRect = () => rect(0, 0, 176, 80);
    (list as any).style = { setProperty: (k: string, v: string) => void (props[k] = v) };
    return { btn, list };
  }

  it("opening shows the popover with fixed edges from the button rect and placement", () => {
    const { btn, list } = make(true, rect(1800, 100));
    expect(list.getAttribute("popover")).toBe("manual");
    dispatch(doc, btn, "click");
    expect(calls).toEqual(["show"]);
    expect(props).toEqual({ left: "auto", right: "90px", top: "124px", bottom: "auto" });
    dispatch(doc, btn, "click");
    expect(calls).toEqual(["show", "hide"]);
    expect(list.hidden).toBe(true);
  });

  it("aligns to the left edge and opens upward where needed", () => {
    const { btn } = make(true, rect(100, 960));
    dispatch(doc, btn, "click");
    expect(props).toEqual({ left: "100px", right: "auto", top: "auto", bottom: "40px" });
  });

  it("a scroll or a resize closes it", () => {
    const { btn, list } = make(true, rect(1800, 100));
    dispatch(doc, btn, "click");
    dispatch(doc, doc, "scroll");
    expect(list.hidden).toBe(true);
    expect(calls).toEqual(["show", "hide"]);
    dispatch(doc, btn, "click");
    expect(typeof listeners.resize).toBe("function");
    listeners.resize();
    expect(list.hidden).toBe(true);
  });

  it("without showPopover it behaves as before", () => {
    const { btn, list } = make(false, rect(100, 100));
    expect(list.hasAttribute("popover")).toBe(false);
    dispatch(doc, btn, "click");
    expect(list.hidden).toBe(false);
    expect(list.classList.contains("align-start")).toBe(true);
    expect(props).toEqual({});
    dispatch(doc, doc, "scroll");
    expect(list.hidden).toBe(false);
    dispatch(doc, btn, "click");
    expect(list.hidden).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("milestone row columns", () => {
  it("the actions sit in the title column below the text parts", () => {
    installFakeDom();
    const actions = dom.h("div.actions.row-actions", dom.h("button", {}, "Edit"));
    const li = slimMilestoneRow(
      { id: "m", title: "Design approved", due_date: "2026-12-01", done: false },
      { today: "2026-11-25", requiresText: "WP1", unlocksText: "WP2", actions },
    );
    const main = li.querySelector(".tw-ms-main")!;
    const below = li.querySelector(".tw-ms-below")!;
    expect(main.querySelector(".tw-ms-title")!.textContent).toBe("Design approved");
    expect(below.contains(actions)).toBe(true);
    expect(main.contains(actions)).toBe(false);
    expect(li.children.map((c: any) => c.className.split(" ")[0])).toEqual(["ms-diamond", "tw-ms-code", "tw-ms-main", "tw-ms-below"]);
  });
});

describe("Mark complete on a finished work package", () => {
  let doc: FDoc;
  beforeEach(() => {
    doc = installFakeDom();
    state.write = true;
    state.sign = true;
    markCompleteDialog.mockClear();
  });
  const leaf = (o: object = {}) => ({ id: "a", status: "doing", progress: 100, ...o });
  const parent = (o: object = {}) => ({ id: "p", status: "doing", progress: 0, effective_progress: 100, children: [leaf()], ...o });

  it("canMarkDone: leaf at 100 % and parent with effective 100 %", () => {
    expect(canMarkDone(leaf())).toBe(true);
    expect(canMarkDone(parent())).toBe(true);
  });
  it("canMarkDone: not for done, dropped or below 100 %", () => {
    expect(canMarkDone(leaf({ status: "done" }))).toBe(false);
    expect(canMarkDone(leaf({ status: "dropped" }))).toBe(false);
    expect(canMarkDone(leaf({ progress: 95 }))).toBe(false);
    expect(canMarkDone(parent({ effective_progress: 80 }))).toBe(false);
    expect(canMarkDone(parent({ status: "done" }))).toBe(false);
    // a parent's own stored progress does not count
    expect(canMarkDone(parent({ progress: 100, effective_progress: 50 }))).toBe(false);
  });
  it("the button shows for a leaf and a parent and opens the dialog", () => {
    for (const w of [leaf(), parent()]) {
      const b = markDoneRowButton("proj", w);
      expect(b.textContent).toBe("Mark complete");
      expect(b.classList.contains("secondary")).toBe(true);
      dispatch(doc, b, "click");
      expect(markCompleteDialog).toHaveBeenLastCalledWith("proj", w);
    }
  });
  it("no button for done, dropped, below 100 % or without the right", () => {
    expect(markDoneRowButton("proj", leaf({ status: "done" }))).toBeNull();
    expect(markDoneRowButton("proj", leaf({ status: "dropped" }))).toBeNull();
    expect(markDoneRowButton("proj", leaf({ progress: 60 }))).toBeNull();
    state.write = false;
    expect(markDoneRowButton("proj", leaf())).toBeNull();
  });
  it("a sign-off work package needs the sign-off right, not write", () => {
    state.sign = false;
    expect(markDoneRowButton("proj", leaf({ verification: "sign_off" }))).toBeNull();
    expect(markDoneRowButton("proj", leaf({ verification: "review" }))).not.toBeNull();
  });
});
