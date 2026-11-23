import { beforeEach, describe, expect, it } from "vitest";
import { installFakeDom, type FEl } from "./fake-dom";

const doc = installFakeDom();
const g = globalThis as Record<string, any>;
(doc as any).createElementNS = (_ns: string, tag: string) => doc.createElement(tag);
// every element records its inline style calls, so the tests can see what colour a bar was given
const makeEl = doc.createElement.bind(doc);
(doc as any).createElement = (tag: string) => {
  const el = makeEl(tag) as any;
  const calls: [string, string][] = [];
  el.style = { setProperty: (k: string, v: string) => calls.push([k, v]), calls };
  return el;
};
g.location = { hash: "#/gantt" };
g.history = { replaceState: (_a: unknown, _b: string, url: string) => (g.location.hash = url) };

// @ts-expect-error untyped JS module
const { renderGantt } = (await import("../public/js/gantt.js")) as { renderGantt: (main: FEl, state: any, keep?: boolean) => Promise<void> };
// @ts-expect-error untyped JS module
const { api } = (await import("../public/js/api.js")) as { api: Record<string, any> };

// @ts-expect-error untyped JS module
const { PROJECT_CATEGORIES, WP_CATEGORIES } = (await import("../public/js/categories.js")) as { PROJECT_CATEGORIES: string[]; WP_CATEGORIES: string[] };

const wp = (id: string, code: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  code,
  title,
  status: "doing",
  progress: 0,
  start_date: "2099-01-01",
  end_date: "2099-01-20",
  children: [],
  ...extra,
});
const details: Record<string, any> = {
  a: {
    workpackages: [
      wp("a1", "1", "Top A", { progress: 50, bar_category: WP_CATEGORIES[0], children: [wp("a11", "1.1", "Sub A1")] }),
      wp("a2", "2", "Late top", { start_date: "2020-01-01", end_date: "2020-01-10" }),
    ],
    milestones: [],
  },
  d: { workpackages: [wp("d1", "1", "Done top")], milestones: [] },
  m: { workpackages: [wp("m1", "1", "Long", { start_date: "2026-10-20", end_date: "2027-06-30" })], milestones: [] },
};
const state = {
  projects: [
    { id: "a", title: "Alpha", status: "active", category: PROJECT_CATEGORIES[0], health: { state: "late", reasons: [] } },
    { id: "d", title: "Finished", status: "done" },
    { id: "m", title: "Mid", status: "active" },
  ],
};
api.project = async (id: string) => details[id];

const render = async (hash: string, keep = false) => {
  g.location.hash = hash;
  const main = doc.createElement("main") as FEl;
  await renderGantt(main, state, keep);
  return main;
};
const texts = (main: FEl) => main.querySelectorAll("text").map((t) => t.textContent);
const bar = (main: FEl, cls: string) => main.querySelectorAll(`rect.${cls}`);
const sleep = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  g.location.hash = "#/gantt";
});

describe("gantt defaults and toggles", () => {
  it("default: top-level WPs only, no completed project, completed count in the label", async () => {
    const main = await render("#/gantt?project=a");
    expect(texts(main).some((x) => x.startsWith("Top A"))).toBe(true);
    expect(texts(main).some((x) => x.startsWith("Sub A1"))).toBe(false);
    const all = await render("#/gantt");
    expect(texts(all).some((x) => x.startsWith("Finished"))).toBe(false);
    expect(texts(all).some((x) => x.startsWith("Alpha"))).toBe(true);
    expect(all.querySelectorAll("label.check").some((l) => l.textContent.includes("Completed projects (1)"))).toBe(true);
  });

  it("sub=1 and done=1 from the hash turn them on", async () => {
    const main = await render("#/gantt?sub=1&done=1");
    expect(texts(main).some((x) => x.startsWith("Sub A1"))).toBe(true);
    expect(texts(main).some((x) => x.startsWith("Finished"))).toBe(true);
    const checks = main.querySelectorAll("input").filter((i) => i.getAttribute("type") === "checkbox");
    expect(checks.slice(0, 2).map((c) => c.checked)).toEqual([true, true]);
  });

  it("project=<completed id> still shows it", async () => {
    const main = await render("#/gantt?project=d");
    expect(texts(main).some((x) => x.startsWith("Finished"))).toBe(true);
    expect(texts(main).some((x) => x.startsWith("Done top"))).toBe(true);
  });
});

describe("gantt bars and axis", () => {
  it("a bar is filled to the WP progress", async () => {
    const main = await render("#/gantt?project=a");
    const [bg] = bar(main, "bar-bg");
    const [fill] = bar(main, "bar-fill");
    expect(Number(fill.getAttribute("width")) / Number(bg.getAttribute("width"))).toBeCloseTo(0.5, 5);
  });

  it("bars carry no category colour; the project dot does", async () => {
    const main = await render("#/gantt?project=a");
    const rectCalls = main.querySelectorAll("rect").flatMap((r: any) => r.style.calls as [string, string][]);
    expect(rectCalls.some(([, v]) => v.includes("--cat-"))).toBe(false);
    const dot = main.querySelector("circle.cat-dot") as any;
    expect(dot.style.calls).toContainEqual(["fill", `var(--cat-p-${PROJECT_CATEGORIES[0]})`]);
  });

  it("a late bar keeps the late class, an on-time bar does not", async () => {
    const main = await render("#/gantt?project=a");
    const bgs = bar(main, "bar-bg");
    expect(bgs.filter((b) => b.classes.has("late"))).toHaveLength(1);
    expect(bgs).toHaveLength(2);
  });

  it("axis months read month and four-digit year", async () => {
    const main = await render("#/gantt?project=m");
    expect(texts(main)).toContain("Nov 2026");
  });
});

describe("gantt project groups", () => {
  it("a project row is a button with aria-expanded and collapses its WPs", async () => {
    const main = await render("#/gantt?project=a");
    const head = main.querySelector("g.proj-head") as FEl;
    expect(head.getAttribute("role")).toBe("button");
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(head.textContent).toContain("Alpha");
    expect(head.textContent).toContain("Late");
    head.listeners.get("click")![0].fn({});
    await sleep();
    const main2 = main;
    expect(main2.querySelector("g.proj-head")!.getAttribute("aria-expanded")).toBe("false");
    expect(texts(main2).some((x) => x.startsWith("Top A"))).toBe(false);
  });

  it("collapse state is dropped when the view is opened afresh", async () => {
    const main = await render("#/gantt?project=a");
    expect(main.querySelector("g.proj-head")!.getAttribute("aria-expanded")).toBe("true");
  });
});
