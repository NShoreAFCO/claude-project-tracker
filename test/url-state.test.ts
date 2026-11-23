// The dashboard's view state lives in the hash query: parse/build, apply, replaceState sync, dialog return URL.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom";

vi.mock("../public/js/project.js", () => ({ openProject: vi.fn() }));
vi.mock("../public/js/forms.js", () => ({ projectForm: vi.fn() }));
vi.mock("../public/js/portfolio.js", () => ({
  summaryBar: () => null,
  KPI_KEYS: ["overdue_milestones", "gates_awaiting_decision", "blocked", "stale", "schedule_issues", "open_high_risks", "missing_target_date", "missing_owner"],
}));
// @ts-expect-error plain browser module without types
import { filterToQuery, gridHash, applyGridQuery, syncGridUrl, renderGrid } from "../public/js/grid.js";
// @ts-expect-error plain browser module without types
import { resetGridFilter } from "../public/js/sidebar.js";

const empty = () => ({ status: "", tag: "", category: "", owner: "", completed: "", tags: [] as string[], kpi: "", health: "" });
const q = (s: string) => new URLSearchParams(s);

function fakeWin(hash: string) {
  const loc = { hash };
  const calls: string[] = [];
  const hist = {
    replaceState: (_s: unknown, _t: string, url: string) => {
      loc.hash = url;
      calls.push(url);
    },
    pushState: () => {
      throw new Error("a filter change must not add a history entry");
    },
  };
  return { loc, hist, calls };
}

describe("grid URL state", () => {
  it("builds nothing for the default filter", () => {
    expect(gridHash(empty())).toBe("#/");
    expect(gridHash({ ...empty(), completed: "hide" })).toBe("#/");
  });

  it("round-trips parse and build", () => {
    const f = { ...empty(), kpi: "overdue_milestones", category: "research", status: "active", completed: "all", tags: ["a", "b"], owner: "u1", health: "at_risk" };
    const hash = gridHash(f);
    const g = empty();
    expect(applyGridQuery(g, q(hash.split("?")[1]))).toBe(true);
    expect(g).toEqual(f);
  });

  it("loading ?attention=blocked&cat=x sets the filter and clears the rest", () => {
    const f = { ...empty(), owner: "u9" };
    expect(applyGridQuery(f, q("attention=blocked&cat=x"))).toBe(true);
    expect(f.kpi).toBe("blocked");
    expect(f.category).toBe("x");
    expect(f.owner).toBe("");
  });

  it("garbage params are ignored and leave the filter alone", () => {
    const f = { ...empty(), owner: "u9" };
    expect(applyGridQuery(f, q("attention=nope&status=bogus&completed=zzz&foo=1"))).toBe(false);
    expect(f.owner).toBe("u9");
    const g = empty();
    expect(applyGridQuery(g, q("attention=nope&cat=research&status=bogus"))).toBe(true);
    expect(g.kpi).toBe("");
    expect(g.status).toBe("");
    expect(g.category).toBe("research");
  });

  it("a filter change rewrites the hash with replaceState only", () => {
    const w = fakeWin("#/");
    syncGridUrl({ ...empty(), kpi: "stale" }, w.loc, w.hist);
    expect(w.calls).toEqual(["#/?attention=stale"]);
    syncGridUrl({ ...empty(), kpi: "stale" }, w.loc, w.hist);
    expect(w.calls).toHaveLength(1);
    syncGridUrl(empty(), w.loc, w.hist);
    expect(w.loc.hash).toBe("#/");
  });

  it("leaves other routes alone", () => {
    for (const h of ["#/gantt?project=a", "#/p/a", "#/search?q=ab"]) {
      const w = fakeWin(h);
      syncGridUrl({ ...empty(), kpi: "stale" }, w.loc, w.hist);
      expect(w.calls).toEqual([]);
    }
  });

  it("the home reset clears filters and the URL", () => {
    const f = { ...empty(), kpi: "blocked", category: "x" };
    resetGridFilter(f, null);
    expect(gridHash(f)).toBe("#/");
  });
});

describe("renderGrid keeps the URL in step", () => {
  let doc: any;
  beforeEach(() => {
    doc = installFakeDom();
  });
  it("writes the filter into the hash after a render", () => {
    const w = fakeWin("#/");
    vi.stubGlobal("location", w.loc);
    vi.stubGlobal("history", w.hist);
    const main = doc.createElement("main");
    doc.body.append(main);
    const state: any = { filter: { ...empty(), completed: "only" }, projects: [], persons: [], summary: null };
    renderGrid(main, state);
    expect(w.loc.hash).toBe("#/?completed=only");
    vi.unstubAllGlobals();
  });
});

describe("project dialog return URL", () => {
  it("returns to the view it was opened from", async () => {
    vi.doUnmock("../public/js/project.js");
    vi.resetModules();
    // @ts-expect-error plain browser module without types
    const { returnHashFor } = await import("../public/js/project.js");
    expect(returnHashFor("#/?attention=blocked&cat=x", false)).toBe("#/?attention=blocked&cat=x");
    expect(returnHashFor("#/gantt?project=a", false)).toBe("#/gantt?project=a");
    expect(returnHashFor("#/p/a", false)).toBe("#/");
    expect(returnHashFor("#/p/b", true, "#/?cat=x")).toBe("#/?cat=x");
    expect(returnHashFor("", false)).toBe("#/");
    // a link that changed the hash to the project first: fall back to the last grid hash
    expect(returnHashFor("#/p/a", false, "#/", "#/?cat=research&status=active")).toBe("#/?cat=research&status=active");
    expect(returnHashFor("#/p/b", true, "#/?cat=x", "#/?other=1")).toBe("#/?cat=x");
    expect(returnHashFor("#/p/a", false, "#/", "")).toBe("#/");
  });

  it("a link from a non-grid view keeps that view underneath and closes back to it", async () => {
    vi.doUnmock("../public/js/project.js");
    vi.resetModules();
    // @ts-expect-error plain browser module without types
    const { dialogUnderlay, returnHashFor } = await import("../public/js/project.js");
    // filtered grid on screen: nothing re-rendered, close returns to the filtered hash
    let u = dialogUnderlay(true, "#/?cat=research&status=active");
    expect(u).toEqual({ renderGrid: false, closeTo: "#/?cat=research&status=active" });
    expect(returnHashFor("#/p/a", false, "#/", u.closeTo)).toBe("#/?cat=research&status=active");
    // My dashboard and Upcoming stay under the dialog, so the URL matches what is shown
    for (const base of ["#/my", "#/upcoming", "#/gantt?project=a"]) {
      u = dialogUnderlay(true, base);
      expect(u.renderGrid).toBe(false);
      expect(returnHashFor("#/p/a", false, "#/", u.closeTo)).toBe(base);
    }
    // deep link or reload: empty page gets the grid and closes to #/ whatever the last base was
    for (const base of ["#/", "#/my", ""]) {
      u = dialogUnderlay(false, base);
      expect(u).toEqual({ renderGrid: true, closeTo: "#/" });
      expect(returnHashFor("#/p/a", false, "#/", u.closeTo)).toBe("#/");
    }
    expect(dialogUnderlay(true, "").closeTo).toBe("#/");
  });
});
