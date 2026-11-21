// The deadlines view: Overdue / This week / Later with a Today divider.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeDom, type FDoc, type FEl } from "./fake-dom";

const mocks = vi.hoisted(() => ({ upcomingWps: vi.fn() }));
vi.mock("../public/js/project.js", () => ({ openProject: vi.fn() }));
vi.mock("../public/js/api.js", () => ({ api: { upcomingWps: mocks.upcomingWps } }));

// @ts-expect-error plain browser module without types
import { renderUpcoming, groupDeadlines } from "../public/js/portfolio.js";

const NOW = "2026-05-08T10:00:00Z";
const row = (code: string, end_date: string | null, status = "open") => ({
  id: code,
  code,
  project_id: "a",
  project_title: "Project a",
  title: `WP ${code}`,
  status,
  end_date,
  progress: 10,
  effective_owner: null,
});

describe("deadlines groups", () => {
  let doc: FDoc;
  let main: FEl;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    doc = installFakeDom();
    (globalThis as any).location = { hash: "#/upcoming" };
    main = doc.createElement("main");
    doc.body.append(main);
  });
  afterEach(() => vi.useRealTimers());

  it("groupDeadlines: today is in This week, day 6 in This week, day 7 in Later, past in Overdue", () => {
    const { groups } = groupDeadlines(
      [row("O", "2026-05-07"), row("T", "2026-05-08"), row("D6", "2026-05-14"), row("D7", "2026-05-15"), row("N", null)],
      new Date(NOW),
    );
    expect(groups.overdue.map((r: any) => r.code)).toEqual(["O"]);
    expect(groups.week.map((r: any) => r.code)).toEqual(["T", "D6"]);
    expect(groups.later.map((r: any) => r.code)).toEqual(["D7", "N"]);
  });

  it("renders headings with counts, the divider between Overdue and This week, rows in order", async () => {
    mocks.upcomingWps.mockResolvedValue([
      row("A1", "2026-05-01"),
      row("A2", "2026-05-07"),
      row("B1", "2026-05-08"),
      row("C1", "2026-05-15"),
    ]);
    await renderUpcoming(main as any);
    const trs = main.querySelector("tbody")!.querySelectorAll("tr");
    const texts = trs.map((tr: FEl) => tr.textContent);
    expect(texts[0]).toContain("Overdue (2)");
    expect(texts[1]).toContain("WP A1");
    expect(texts[2]).toContain("WP A2");
    expect(texts[3]).toContain("Today · ");
    expect(texts[4]).toContain("This week (1)");
    expect(texts[5]).toContain("WP B1");
    expect(texts[6]).toContain("Later (1)");
    expect(texts[7]).toContain("WP C1");
    const heads = main.querySelectorAll("th").filter((th: FEl) => th.getAttribute("scope") === "colgroup" && th.getAttribute("colspan") === "6");
    expect(heads).toHaveLength(3);
  });

  it("an empty group has no heading; only Later rows leave the divider and one heading", async () => {
    mocks.upcomingWps.mockResolvedValue([row("C1", "2026-06-15")]);
    await renderUpcoming(main as any);
    const text = main.textContent;
    expect(text).not.toContain("Overdue (");
    expect(text).not.toContain("This week (");
    expect(text).toContain("Later (1)");
    expect(text).toContain("Today · ");
  });

  it("no rows: the empty text, no groups", async () => {
    mocks.upcomingWps.mockResolvedValue([]);
    await renderUpcoming(main as any);
    expect(main.textContent).toContain("No open work packages with an end date.");
    expect(main.textContent).not.toContain("Today · ");
  });
});
