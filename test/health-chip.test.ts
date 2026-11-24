// Health chip, reason line and the health filter of the grid.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch, installFakeDom, type FDoc, type FEl } from "./fake-dom";

vi.mock("../public/js/project.js", () => ({ openProject: vi.fn() }));
vi.mock("../public/js/forms.js", () => ({ projectForm: vi.fn() }));
vi.mock("../public/js/portfolio.js", () => ({ summaryBar: () => null, KPI_KEYS: ["overdue_milestones", "blocked", "stale"] }));
// @ts-expect-error plain browser module without types
import { HEALTH_ORDER, healthChip, healthLine, healthReasonText } from "../public/js/health.js";
// @ts-expect-error plain browser module without types
import { filterProjects, filterToQuery, applyGridQuery, renderGrid, loadGridFilter, saveGridFilter } from "../public/js/grid.js";
// @ts-expect-error plain browser module without types
import { setLocale, fmtDate } from "../public/js/i18n.js";

const REASONS: Record<string, any> = {
  on_hold: { kind: "on_hold" },
  milestone_overdue: { kind: "milestone_overdue", code: "M2", title: "Audit passed", gate: false, days: 9 },
  gate_overdue: { kind: "milestone_overdue", code: "G1", title: "Go", gate: true, days: 2 },
  target_passed: { kind: "target_passed", date: "2026-11-01", days: 22 },
  high_risk: { kind: "high_risk", title: "Supplier", score: 20 },
  wp_blocked: { kind: "wp_blocked", code: "WP2", title: "Build" },
  gate_tomorrow: { kind: "gate_due", code: "G1", title: "Go", due_date: "2026-11-24", days: 1 },
  gate_in: { kind: "gate_due", code: "G1", title: "Go", due_date: "2026-11-26", days: 3 },
  wp_late: { kind: "wp_late", code: "WP2", title: "Build", days: 12 },
  no_activity: { kind: "no_activity", days: 26 },
  no_activity_unknown: { kind: "no_activity", days: null },
  next_milestone: { kind: "next_milestone", code: "M1", title: "Pilot live", due_date: "2026-12-18" },
  next_milestone_undated: { kind: "next_milestone", code: null, title: "Pilot live", due_date: null },
};

describe("health.js", () => {
  afterEach(() => setLocale("en"));

  it("orders the states worst first", () => {
    expect(HEALTH_ORDER).toEqual(["on_hold", "late", "at_risk", "stalled", "on_track"]);
  });

  it("chip: no chip without health, words for every state", () => {
    installFakeDom();
    expect(healthChip(null)).toBeNull();
    const words: Record<string, string> = { on_hold: "On hold", late: "Late", at_risk: "At risk", stalled: "Stalled", on_track: "On track" };
    for (const s of HEALTH_ORDER) {
      const chip = healthChip({ state: s, reasons: [] });
      expect(chip.classes.has("chip") && chip.classes.has("health") && chip.classes.has(`h-${s.replace("_", "-")}`)).toBe(true);
      expect(chip.textContent).toBe(words[s]);
    }
  });

  it("reason text per kind in en", () => {
    expect(healthReasonText(REASONS.on_hold)).toBe("On hold");
    expect(healthReasonText(REASONS.milestone_overdue)).toBe("M2 Audit passed overdue 9 d");
    expect(healthReasonText(REASONS.gate_overdue)).toBe("Gate G1 Go overdue 2 d");
    expect(healthReasonText(REASONS.target_passed)).toBe(`Target ${fmtDate("2026-11-01")} passed 22 d ago`);
    expect(healthReasonText(REASONS.high_risk)).toBe("High risk: Supplier");
    expect(healthReasonText(REASONS.wp_blocked)).toBe("WP2 Build blocked");
    expect(healthReasonText(REASONS.gate_tomorrow)).toBe("Gate G1 Go due tomorrow");
    expect(healthReasonText(REASONS.gate_in)).toBe("Gate G1 Go due in 3 d");
    expect(healthReasonText(REASONS.wp_late)).toBe("WP2 Build overdue 12 d");
    expect(healthReasonText(REASONS.no_activity)).toBe("No activity for 26 days");
    expect(healthReasonText(REASONS.no_activity_unknown)).toBe("No recent activity");
    expect(healthReasonText(REASONS.next_milestone)).toBe(`Next: M1 Pilot live · ${fmtDate("2026-12-18")}`);
    expect(healthReasonText(REASONS.next_milestone_undated)).toBe("Next: Pilot live");
  });

  it("reason text per kind in de: every kind is translated", () => {
    setLocale("de");
    for (const [name, reason] of Object.entries(REASONS)) {
      const text = healthReasonText(reason);
      expect(text, name).not.toMatch(/^healthReason\./);
      expect(text, name).not.toMatch(/\{\w+\}/);
    }
    expect(healthReasonText(REASONS.no_activity)).toBe("Seit 26 Tagen keine Aktivität");
    expect(healthReasonText(REASONS.milestone_overdue)).toBe("M2 Audit passed seit 9 T überfällig");
    expect(healthChip({ state: "at_risk", reasons: [] }).textContent).toBe("Gefährdet");
  });

  it("line: up to two reasons joined, none for nothing", () => {
    installFakeDom();
    expect(healthLine(null)).toBeNull();
    expect(healthLine({ state: "on_track", reasons: [] })).toBeNull();
    const line = healthLine({ state: "late", reasons: [REASONS.milestone_overdue, REASONS.gate_tomorrow, REASONS.no_activity] });
    expect(line.classes.has("health-reason")).toBe(true);
    expect(line.textContent).toBe("M2 Audit passed overdue 9 d · Gate G1 Go due tomorrow");
  });
});

const full = (id: string, health: any, over: Record<string, unknown> = {}) => ({
  id,
  title: `Project ${id}`,
  status: "active",
  origin: "manual",
  category: null,
  tags: [],
  target_date: "2026-12-01",
  owner_id: null,
  owner_initials: null,
  progress: 40,
  progress_basis: "wp",
  wp_counts: { open: 1, in_progress: 2, waiting_blocked: 0, done: 3 },
  next_milestone: null,
  current_gate: null,
  open_branches: 0,
  context_docs: 0,
  last_activity: null,
  blocked: [],
  summary: "",
  health,
  ...over,
});
const H = (state: string, ...kinds: string[]) => ({ state, reasons: kinds.map((k) => REASONS[k]) });

describe("grid with health", () => {
  let doc: FDoc;
  let main: FEl;
  let state: any;
  const cards = () => main.querySelectorAll("article.card");
  const rowButtons = () => main.querySelector(".health-filter")!.children.filter((c: FEl) => c.tagName === "BUTTON");
  const rowChip = (s: string) => rowButtons().find((b) => b.getAttribute("data-focus") === `health-${s}`)!;

  beforeEach(() => {
    doc = installFakeDom();
    main = doc.createElement("main");
    doc.body.append(main);
    state = {
      filter: { status: "", tag: "", category: "", owner: "" },
      projects: [
        full("a", H("late", "milestone_overdue", "gate_tomorrow")),
        full("b", H("at_risk", "wp_blocked")),
        full("c", H("on_track", "next_milestone")),
        full("d", H("on_track")),
        full("e", null, { status: "idea" }),
      ],
      persons: [],
      summary: null,
    };
  });

  it("puts the chip first in the head and the reason line under it", () => {
    renderGrid(main as any, state);
    const first = cards()[0];
    expect(first.children.map((c: FEl) => c.className)).toEqual(expect.arrayContaining(["head", "health-reason"]));
    expect(first.children[0].className).toBe("head");
    expect(first.children[1].className).toBe("health-reason");
    expect(first.children[0].children[0].classes.has("health")).toBe(true);
    expect(first.children[0].children[0].textContent).toBe("Late");
    expect(first.children[0].children[1].tagName).toBe("H2");
    expect(first.children[1].textContent).toBe("M2 Audit passed overdue 9 d · Gate G1 Go due tomorrow");
  });

  it("shows no chip and no line for a project without health", () => {
    state.filter.completed = "all";
    state.projects = [full("e", null, { status: "done" })];
    renderGrid(main as any, state);
    expect(main.querySelectorAll(".chip.health")).toHaveLength(0);
    expect(main.querySelector(".health-reason")).toBeNull();
    expect(main.querySelector(".health-filter")).toBeNull();
  });

  it("filter row: counts match the shown cards, in HEALTH_ORDER", () => {
    renderGrid(main as any, state);
    const labels = rowButtons().map((b: FEl) => b.textContent);
    expect(labels).toEqual(["Late 1", "At risk 1", "On track 2"]);
    expect(cards()).toHaveLength(5);
  });

  it("click filters to one state, click again clears", () => {
    renderGrid(main as any, state);
    dispatch(doc, rowChip("late"), "click");
    expect(state.filter.health).toBe("late");
    expect(cards()).toHaveLength(1);
    expect(rowChip("late").getAttribute("aria-pressed")).toBe("true");
    // other states stay visible so the choice can be changed
    expect(rowButtons()).toHaveLength(3);
    dispatch(doc, rowChip("late"), "click");
    expect(state.filter.health).toBe("");
    expect(cards()).toHaveLength(5);
  });
});

describe("health filter logic", () => {
  const ps = [
    { id: "a", status: "active", tags: [], health: { state: "late", reasons: [] } },
    { id: "b", status: "active", tags: [], health: { state: "on_track", reasons: [] } },
    { id: "c", status: "idea", tags: [], health: null },
  ];
  const ids = (f: any) => filterProjects(ps, f).map((p: any) => p.id);

  it("keeps only the chosen state", () => {
    expect(ids({ health: "late" })).toEqual(["a"]);
    expect(ids({ health: "" })).toEqual(["a", "b", "c"]);
    expect(ids({ health: "stalled" })).toEqual([]);
  });

  it("round-trips through the URL query", () => {
    const q = filterToQuery({ health: "late" });
    expect(q.get("health")).toBe("late");
    const f: any = { status: "", owner: "", tags: [], category: "", kpi: "", completed: "", health: "" };
    expect(applyGridQuery(f, new URLSearchParams("health=late"))).toBe(true);
    expect(f.health).toBe("late");
    expect(ids(f)).toEqual(["a"]);
    expect(filterToQuery(f).toString()).toBe("health=late");
  });

  it("ignores an unknown state in the URL", () => {
    const f: any = { status: "", owner: "", tags: [], category: "", kpi: "", completed: "", health: "" };
    expect(applyGridQuery(f, new URLSearchParams("health=bogus"))).toBe(false);
  });

  it("survives a reload via storage", () => {
    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    saveGridFilter({ health: "at_risk", tags: [], status: "", owner: "" }, s);
    const f: any = { status: "", owner: "", category: "" };
    loadGridFilter(f, s);
    expect(f.health).toBe("at_risk");
  });
});
