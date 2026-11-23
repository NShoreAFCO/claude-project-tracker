// Dependency links in the project dialog: Depends on / Needed by lines, unfolding jumps, blocked_by references.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
afterEach(() => vi.useRealTimers());

type W = { id: string; code?: string; title: string; status: string; depends_on?: string[]; children?: W[] };
const wps: W[] = [
  { id: "a", code: "WP1", title: "Alpha", status: "done" },
  {
    id: "b",
    code: "WP2",
    title: "Beta",
    status: "doing",
    depends_on: ["a"],
    children: [
      {
        id: "b1",
        code: "WP2.1",
        title: "Beta one",
        status: "doing",
        children: [{ id: "b11", code: "WP2.1.1", title: "Deep task", status: "planned", depends_on: ["a"] }],
      },
    ],
  },
  { id: "c", code: "WP3", title: "Gamma", status: "planned", depends_on: ["b11", "a"] },
  { id: "n", title: "No code", status: "planned", depends_on: ["a"] },
];
const flat = (l: W[]): W[] => l.flatMap((w) => [w, ...flat(w.children ?? [])]);
const milestones = [{ id: "m1", code: "T05", title: "Gate", gate: true, requires: ["a"], unlocks: ["c"] }];

describe("dependency lines", () => {
  it("lists depends_on and needed-by in code order, milestones included", () => {
    const d = tree.wpDependencies(wps[2], flat(wps), milestones);
    expect(d.dependsOn.map((r: any) => r.item.code)).toEqual(["WP1", "WP2.1.1"]);
    const a = tree.wpDependencies(wps[0], flat(wps), milestones);
    expect(a.neededBy.map((r: any) => r.item.code ?? r.item.title)).toEqual(["T05", "WP2", "WP2.1.1", "WP3", "No code"]);
  });

  it("renders no line when empty, codes with the title in the title attribute otherwise", () => {
    expect(tree.depLine("dep-on", "Depends on", [], () => {})).toBeNull();
    const line = tree.depLine("dep-on", "Depends on", tree.wpDependencies(wps[2], flat(wps), milestones).dependsOn, () => {});
    doc.body.append(line);
    expect(line.textContent).toBe("Depends on: WP1, WP2.1.1");
    expect(line.querySelectorAll("button")[0].getAttribute("title")).toBe("Alpha");
  });

  it("a reference without a code shows the title", () => {
    const link = tree.depLink("wp", wps[3], () => {});
    expect(link.textContent).toBe("No code");
  });
});

describe("jumping to a target", () => {
  const fold = () => ({ open: new Set<string>(), issuesOnly: false, doneOpen: false });

  /** Same assembly as the dialog: rows only for unfolded parents, done group folded. */
  function build(f: ReturnType<typeof fold>, onJump: (k: string, id: string) => void) {
    const rows = (list: W[], depth: number): FEl[] =>
      list.map((w) => {
        const open = f.open.has(w.id);
        const row = tree.wpRow({
          depth,
          id: tree.depTargetId("wp", w.id),
          fold: { leaf: !w.children?.length, open, label: w.title, onToggle: () => {} },
          code: w.code,
          title: w.title,
          below: [tree.depLine("dep-on", "Depends on", tree.wpDependencies(w, flat(wps), milestones).dependsOn, onJump)].filter(Boolean),
        });
        return tree.wpItem(depth, row, open && w.children?.length ? dom.h("ul", rows(w.children, depth + 1)) : null);
      });
    const { open, done } = tree.splitDone(wps);
    return dom.h("ul", [...tree.doneFold({ count: done.length, open: f.doneOpen, onToggle: () => {}, rows: rows(done, 1) }), ...rows(open, 1)]);
  }

  it("unfolds all ancestors of a task three levels down, marks it and clears the mark after 2 s", () => {
    vi.useFakeTimers();
    const f = fold();
    const root = dom.h("div");
    doc.body.append(root);
    const jump = (kind: string, id: string) => {
      tree.revealFold(wps, id, f);
      root.replaceChildren(build(f, jump));
      tree.revealTarget(doc.getElementById(tree.depTargetId(kind, id)));
    };
    root.append(build(f, jump));
    expect(doc.getElementById("dep-wp-b11")).toBeNull();
    const wp3 = doc.getElementById("dep-wp-c")!;
    const toTask = wp3.querySelectorAll(".dep-link").find((b: FEl) => b.textContent === "WP2.1.1")!;
    dispatch(doc, toTask, "click");
    const target = doc.getElementById("dep-wp-b11")!;
    expect(target).not.toBeNull();
    expect([...f.open]).toEqual(["b", "b1"]);
    expect(target.classList.contains("dep-target")).toBe(true);
    expect(doc.activeElement).toBe(target);
    vi.advanceTimersByTime(1999);
    expect(target.classList.contains("dep-target")).toBe(true);
    vi.advanceTimersByTime(2);
    expect(target.classList.contains("dep-target")).toBe(false);
  });

  it("a link into the done group opens it", () => {
    const f = fold();
    tree.revealFold(wps, "a", f);
    expect(f.doneOpen).toBe(true);
    const f2 = fold();
    tree.revealFold(wps, "c", f2);
    expect(f2.doneOpen).toBe(false);
  });

  it("turns the issues-only filter off when it hides the target", () => {
    const f = { ...fold(), issuesOnly: true };
    tree.revealFold(wps, "c", f, new Set(["b"]));
    expect(f.issuesOnly).toBe(false);
    const g = { ...fold(), issuesOnly: true };
    tree.revealFold(wps, "c", g, new Set(["c"]));
    expect(g.issuesOnly).toBe(true);
  });
});

describe("blocked_by references", () => {
  const all = flat(wps);
  it("wp: and ms: become links, ext: and free text stay text", () => {
    const wp = tree.blockedRef("wp:b", all, milestones, () => {});
    expect(wp.textContent).toBe("WP2");
    expect(tree.blockedRef("ms:m1", all, milestones, () => {}).textContent).toBe("T05");
    expect(tree.blockedRef("ext:Vendor reply", all, milestones, () => {})).toBe("Vendor reply");
    expect(tree.blockedRef("waiting for legal", all, milestones, () => {})).toBe("waiting for legal");
  });

  it("a milestone row accepts link nodes for requires and unlocks", () => {
    const link = tree.depLink("wp", wps[0], () => {});
    const li = tree.slimMilestoneRow(milestones[0], { today: "2026-11-23", requiresText: link, unlocksText: "none", id: "dep-ms-m1" });
    doc.body.append(li);
    expect(li.querySelector(".tw-ms-req")!.querySelector(".dep-link")!.textContent).toBe("WP1");
    expect(li.id).toBe("dep-ms-m1");
  });
});
