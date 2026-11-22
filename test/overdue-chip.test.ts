// The "Overdue · n d" chip wherever a late date shows: cards, list views, project rows, Gantt.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeDom, type FDoc, type FEl } from "./fake-dom";

const mocks = vi.hoisted(() => ({ upcomingWps: vi.fn(), project: vi.fn() }));
vi.mock("../public/js/project.js", () => ({ openProject: vi.fn() }));
vi.mock("../public/js/forms.js", () => ({ projectForm: vi.fn() }));
vi.mock("../public/js/api.js", () => ({ api: { upcomingWps: mocks.upcomingWps, project: mocks.project } }));

// @ts-expect-error plain browser module without types
import { renderGrid } from "../public/js/grid.js";
// @ts-expect-error plain browser module without types
import { renderUpcoming } from "../public/js/portfolio.js";
// @ts-expect-error plain browser module without types
import { lateness } from "../public/js/lateness.js";
// @ts-expect-error plain browser module without types
import { milestoneItem } from "../public/js/schedule-view.js";
// @ts-expect-error plain browser module without types
import { renderGantt } from "../public/js/gantt.js";

const NOW = "2026-05-08T10:00:00Z";
const chipText = (el: FEl | null) => el?.querySelector(".chip.late")?.textContent ?? null;

describe("overdue chip", () => {
  let doc: FDoc;
  let main: FEl;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    doc = installFakeDom();
    (doc as any).createElementNS = (_ns: string, tag: string) => doc.createElement(tag);
    (globalThis as any).location = { hash: "#/upcoming" };
    (globalThis as any).history = { replaceState: () => {} };
    main = doc.createElement("main");
    doc.body.append(main);
  });
  afterEach(() => vi.useRealTimers());

  const project = (over: Record<string, unknown> = {}) => ({
    id: "a",
    title: "Project a",
    status: "active",
    origin: "manual",
    category: null,
    tags: [],
    target_date: "2026-05-01",
    owner_id: null,
    owner_initials: null,
    progress: 40,
    progress_basis: "wp",
    wp_counts: { open: 1, in_progress: 0, waiting_blocked: 0, done: 0 },
    next_milestone: null,
    current_gate: null,
    blocked: [],
    summary: "",
    ...over,
  });
  const grid = (p: any) => {
    renderGrid(main as any, { filter: { status: "", tag: "", category: "", owner: "" }, projects: [p], persons: [], summary: null });
    return main.querySelector("article.card")!;
  };

  it("card: a past target date of an active project shows the day count", () => {
    const card = grid(project());
    expect(chipText(card.querySelector(".card-target"))).toBe("⚠Overdue · 7 d");
  });

  it("card: no chip for a future target date or a project that is not active", () => {
    expect(chipText(grid(project({ target_date: "2026-06-01" })))).toBeNull();
    expect(chipText(grid(project({ status: "done" })))).toBeNull();
    expect(chipText(grid(project({ status: "on_hold" })))).toBeNull();
  });

  it("card: the next milestone is flagged when its due date has passed", () => {
    const card = grid(project({ target_date: "2026-06-01", next_milestone: { title: "Kickoff", due_date: "2026-05-05" } }));
    expect(chipText(card.querySelector(".next-ms"))).toBe("⚠Overdue · 3 d");
    const ok = grid(project({ target_date: "2026-06-01", next_milestone: { title: "Kickoff", due_date: "2026-05-20" } }));
    expect(chipText(ok.querySelector(".next-ms"))).toBeNull();
  });

  it("deadlines: a past-due work package row has the chip and keeps the overdue class; a done one has neither", async () => {
    const row = (id: string, status: string, end_date: string) => ({
      id,
      project_id: "a",
      project_title: "Project a",
      title: `WP ${id}`,
      status,
      end_date,
      progress: 10,
      effective_owner: null,
    });
    mocks.upcomingWps.mockResolvedValue([row("late", "doing", "2026-05-01"), row("done", "done", "2026-05-01"), row("future", "open", "2026-06-01")]);
    await renderUpcoming(main as any);
    const trs = main.querySelectorAll("tr").filter((tr: FEl) => tr.textContent.includes("WP "));
    expect(trs).toHaveLength(3);
    const byTitle = (title: string) => trs.find((tr: FEl) => tr.textContent.includes(title))!;
    expect(chipText(byTitle("WP late"))).toBe("⚠Overdue · 7 d");
    expect(byTitle("WP late").classes.has("overdue")).toBe(true);
    expect(chipText(byTitle("WP done"))).toBeNull();
    expect(byTitle("WP done").classes.has("overdue")).toBe(false);
    expect(chipText(byTitle("WP future"))).toBeNull();
  });

  it("the shared rule: before today is late, today and no date are not", () => {
    expect(lateness("2026-05-01", "open", new Date(NOW)).late).toBe(true);
    expect(lateness("2026-05-08", "open", new Date(NOW)).late).toBe(false);
    expect(lateness(null, "open", new Date(NOW)).late).toBe(false);
  });

  it("project dialog: an unreached milestone past its date has the chip, a reached one never", () => {
    const opts = { today: "2026-05-08", titleOf: () => "", requiresText: "-", unlocksText: "-" };
    const late = milestoneItem({ id: "m1", title: "M1", due_date: "2026-05-01", done: false }, opts);
    expect(chipText(late)).toBe("⚠Overdue · 7 d");
    const reached = milestoneItem({ id: "m2", title: "M2", due_date: "2026-05-01", done: true }, opts);
    expect(chipText(reached)).toBeNull();
  });

  it("gantt: the bar of a late work package and the diamond of a late milestone get the late class", async () => {
    const wp = (id: string, status: string, end: string) => ({
      id,
      code: id,
      title: `WP ${id}`,
      status,
      progress: 10,
      start_date: "2026-04-01",
      end_date: end,
      children: [],
    });
    mocks.project.mockResolvedValue({
      workpackages: [wp("W1", "doing", "2026-05-01"), wp("W2", "done", "2026-05-01")],
      milestones: [
        { id: "m1", title: "Late ms", due_date: "2026-05-02", done: false, requires: ["W1"], unlocks: [] },
        { id: "m2", title: "Reached ms", due_date: "2026-05-02", done: true, requires: ["W2"], unlocks: [] },
      ],
      baseline: null,
    });
    await renderGantt(main as any, { projects: [{ id: "a", title: "Project a" }] });
    const bars = main.querySelectorAll("rect.bar-bg");
    expect(bars.length).toBeGreaterThanOrEqual(2);
    expect(bars.filter((b: FEl) => b.classes.has("late"))).toHaveLength(1);
    const diamonds = main.querySelectorAll("polygon.ms");
    expect(diamonds.filter((d: FEl) => d.classes.has("late"))).toHaveLength(1);
    expect(diamonds.filter((d: FEl) => d.classes.has("ms-done") && d.classes.has("late"))).toHaveLength(0);
  });
});
