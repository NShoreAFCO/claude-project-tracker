// Tier language in the work package tree: tier classes by depth, one block per top-level row, code column, fold toggle.
import { beforeEach, describe, expect, it } from "vitest";
import { dispatch, installFakeDom, type FDoc, type FEl } from "./fake-dom";

let doc: FDoc;
let tree: any;
let dom: any;

beforeEach(async () => {
  doc = installFakeDom();
  // @ts-expect-error plain browser module without types
  tree = await import("../public/js/wp-tree.js");
  // @ts-expect-error plain browser module without types
  dom = await import("../public/js/dom.js");
});

type W = { id: string; code: string; title: string; children?: W[] };
const data: W[] = [
  { id: "a", code: "WP1", title: "Alpha", children: [{ id: "a1", code: "WP1.1", title: "Sub", children: [{ id: "a1x", code: "WP1.1.1", title: "Task", children: [{ id: "deep", code: "WP1.1.1.1", title: "Deeper" }] }] }] },
  { id: "b", code: "WP2", title: "Beta" },
];

/** Same recursion as the project dialog: fold state and toggle callback are passed in. */
function build(open: Set<string>, rerender: () => void) {
  const level = (list: W[], depth: number): any[] =>
    list.map((w) => {
      const leaf = !w.children?.length;
      const isOpen = !leaf && open.has(w.id);
      const row = tree.wpRow({
        depth,
        fold: {
          leaf,
          open: isOpen,
          label: w.title,
          onToggle: () => {
            if (isOpen) open.delete(w.id);
            else open.add(w.id);
            rerender();
          },
        },
        code: w.code,
        title: w.title,
        status: "doing",
        dates: "",
        owner: null,
        progress: "50 %",
      });
      return tree.wpItem(depth, row, isOpen ? dom.h("ul", level(w.children!, depth + 1)) : null);
    });
  return dom.h("ul.tree.tw-tree", level(data, 1));
}

describe("tier language", () => {
  it("maps depth to tier 1, 2, 3+", () => {
    expect([1, 2, 3, 4, 7].map(tree.tierOf)).toEqual([1, 2, 3, 3, 3]);
  });

  it("rows carry tier classes by depth and each top-level WP is its own block", () => {
    const ul = build(new Set(["a", "a1", "a1x"]), () => {});
    doc.body.append(ul);
    const tiers = ul.querySelectorAll(".tw-row").map((r: FEl) => [r.querySelector(".tw-code")!.textContent, r.classes.has("tier-1") ? 1 : r.classes.has("tier-2") ? 2 : r.classes.has("tier-3") ? 3 : 0]);
    expect(tiers).toEqual([
      ["WP1", 1],
      ["WP1.1", 2],
      ["WP1.1.1", 3],
      ["WP1.1.1.1", 3],
      ["WP2", 1],
    ]);
    const blocks = ul.querySelectorAll(".tw-block");
    expect(blocks).toHaveLength(2);
    // sub rows sit inside their top-level block, not in a block of their own
    expect(blocks[0].querySelectorAll(".tw-row")).toHaveLength(4);
    expect(blocks[1].querySelectorAll(".tw-row")).toHaveLength(1);
  });

  it("the code sits in the first column, before the title", () => {
    const ul = build(new Set(), () => {});
    const row = ul.querySelector(".tw-row")!;
    const kids = row.children.map((c: FEl) => [...c.classes][0]);
    expect(kids.indexOf("chev")).toBeLessThan(kids.indexOf("tw-code"));
    expect(kids.indexOf("tw-code")).toBeLessThan(kids.indexOf("tw-ttl"));
    expect(kids.indexOf("tw-ttl")).toBeLessThan(kids.indexOf("tw-st"));
  });

  it("fold toggle is a button with aria-expanded and toggles the children", () => {
    const open = new Set<string>();
    let ul = build(open, () => {});
    const rerender = () => {
      const next = build(open, rerender);
      doc.body.replaceChildren(next);
      ul = next;
    };
    ul = build(open, rerender);
    doc.body.append(ul);
    const btn = () => ul.querySelector("button.tw-fold")!;
    expect(btn().tagName).toBe("BUTTON");
    expect(btn().getAttribute("aria-expanded")).toBe("false");
    expect(ul.querySelectorAll(".tier-2")).toHaveLength(0);
    dispatch(doc, btn(), "click");
    expect(open.has("a")).toBe(true);
    expect(btn().getAttribute("aria-expanded")).toBe("true");
    expect(ul.querySelectorAll(".tier-2")).toHaveLength(1);
    dispatch(doc, btn(), "click");
    expect(ul.querySelectorAll(".tier-2")).toHaveLength(0);
  });

  it("a leaf has no toggle", () => {
    const ul = build(new Set(), () => {});
    const blocks = ul.querySelectorAll(".tw-block");
    expect(blocks[1].querySelector("button.tw-fold")).toBeNull();
  });
});
