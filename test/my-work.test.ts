import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch, installFakeDom, type FDoc, type FEl } from "./fake-dom";

// @ts-expect-error plain browser module without types
import { t } from "../public/js/i18n.js";
// @ts-expect-error plain browser module without types
import { SECTIONS, myWorkSections, splitWork } from "../public/js/my-work.js";

const sectionOf = (root: FEl, key: string) =>
  root.querySelectorAll("section.mw-section").find((s) => s.dataset.section === key)!;

const wp = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  project_id: `project-${id}`,
  project_title: `Project ${id}`,
  code: `WP${id}`,
  title: `Work ${id}`,
  status: "doing",
  end_date: null,
  ...over,
});

const gate = (id: string, over: Record<string, unknown> = {}) => ({
  milestone_id: `milestone-${id}`,
  title: `Gate ${id}`,
  wp_code: `WP${id}`,
  project_id: `project-${id}`,
  project_title: `Project ${id}`,
  due_date: null,
  reached: false,
  decision_state: null,
  ...over,
});

const recent = (id: number, over: Record<string, unknown> = {}) => ({
  id: `event-${id}`,
  ts: `2026-01-${String(id).padStart(2, "0")}T12:00:00.000Z`,
  actor: `Actor ${id}`,
  person_name: null,
  project_id: `project-${id}`,
  project_title: `Project ${id}`,
  wp_code: `WP${id}`,
  summary: `Summary ${id}`,
  ...over,
});

describe("splitWork", () => {
  const today = "2026-01-10";

  it("puts an overdue blocked work package in overdue only", () => {
    const blockedOverdue = wp("1", {
      status: "blocked",
      end_date: "2026-01-09",
    });

    const result = splitWork([blockedOverdue], today);

    expect(result.overdue).toEqual([blockedOverdue]);
    expect(result.due14).toEqual([]);
    expect(result.blocked).toEqual([]);
  });

  it("includes today and today plus 14 days in due14", () => {
    const dueToday = wp("1", { end_date: "2026-01-10" });
    const dueLastDay = wp("2", { end_date: "2026-01-24" });

    const result = splitWork([dueLastDay, dueToday], today);

    expect(result.due14).toEqual([dueToday, dueLastDay]);
  });

  it("leaves today plus 15 days out unless the row is blocked", () => {
    const ordinary = wp("1", { end_date: "2026-01-25" });
    const blocked = wp("2", {
      status: "blocked",
      end_date: "2026-01-25",
    });

    const result = splitWork([ordinary, blocked], today);

    expect(result.overdue).toEqual([]);
    expect(result.due14).toEqual([]);
    expect(result.blocked).toEqual([blocked]);
  });

  it("never includes done or dropped rows", () => {
    const rows = [
      wp("1", { status: "done", end_date: "2026-01-01" }),
      wp("2", { status: "dropped", end_date: "2026-01-10" }),
      wp("3", { status: "done", end_date: null }),
      wp("4", { status: "dropped", end_date: null }),
    ];

    expect(splitWork(rows, today)).toEqual({
      overdue: [],
      due14: [],
      blocked: [],
    });
  });

  it("sorts overdue and due14 by date, project, then natural code", () => {
    const overdue = [
      wp("a", {
        end_date: "2026-01-09",
        project_title: "Beta",
        code: "WP1",
      }),
      wp("b", {
        end_date: "2026-01-08",
        project_title: "Zulu",
        code: "WP3",
      }),
      wp("c", {
        end_date: "2026-01-09",
        project_title: "Alpha",
        code: "WP10",
      }),
      wp("d", {
        end_date: "2026-01-09",
        project_title: "Alpha",
        code: "WP2",
      }),
    ];
    const due14 = [
      wp("e", {
        end_date: "2026-01-12",
        project_title: "Beta",
        code: "WP1",
      }),
      wp("f", {
        end_date: "2026-01-11",
        project_title: "Zulu",
        code: "WP3",
      }),
      wp("g", {
        end_date: "2026-01-12",
        project_title: "Alpha",
        code: "WP10",
      }),
      wp("h", {
        end_date: "2026-01-12",
        project_title: "Alpha",
        code: "WP2",
      }),
    ];

    const result = splitWork([...overdue, ...due14], today);

    expect(result.overdue.map((row: { id: string }) => row.id)).toEqual([
      "b",
      "d",
      "c",
      "a",
    ]);
    expect(result.due14.map((row: { id: string }) => row.id)).toEqual([
      "f",
      "h",
      "g",
      "e",
    ]);
  });

  it("sorts blocked rows by project and natural code", () => {
    const rows = [
      wp("a", {
        status: "waiting",
        project_title: "Beta",
        code: "WP1",
      }),
      wp("b", {
        status: "blocked",
        project_title: "Alpha",
        code: "WP10",
      }),
      wp("c", {
        status: "waiting",
        project_title: "Alpha",
        code: "WP2",
      }),
    ];

    const result = splitWork(rows, today);

    expect(result.blocked.map((row: { id: string }) => row.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });
});

describe("myWorkSections", () => {
  let doc: FDoc;
  let onOpen: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    doc = installFakeDom();
    onOpen = vi.fn();
  });

  const render = (
    data: {
      gates: Array<Record<string, unknown>>;
      wps: Array<Record<string, unknown>>;
      recent: Array<Record<string, unknown>>;
    },
  ) => {
    const root = myWorkSections(data, {
      today: "2026-01-10",
      onOpen,
    }) as FEl;
    doc.body.append(root);
    return root;
  };

  it("renders all five sections in SECTIONS order with counts", () => {
    const root = render({
      gates: [gate("g")],
      wps: [
        wp("o", { end_date: "2026-01-09" }),
        wp("d", { end_date: "2026-01-10" }),
        wp("b", { status: "blocked" }),
      ],
      recent: [recent(1)],
    });
    const sections = root.querySelectorAll("section.mw-section");

    expect(SECTIONS).toEqual([
      "decisions",
      "overdue",
      "due14",
      "blocked",
      "recent",
    ]);
    expect(sections.map((section) => section.dataset.section)).toEqual(
      SECTIONS,
    );
    expect(
      sections.map(
        (section) => section.querySelector("span.mw-count")!.textContent,
      ),
    ).toEqual(["1", "1", "1", "1", "1"]);
    expect(
      sections.map(
        (section) => section.querySelector("h3")!.textContent,
      ),
    ).toEqual(
      SECTIONS.map((key: string) => `${t(`mw.${key}`)}1`),
    );
  });

  it("renders the localized empty line for every empty section", () => {
    const root = render({ gates: [], wps: [], recent: [] });
    const sections = root.querySelectorAll("section.mw-section");

    expect(sections).toHaveLength(5);
    for (const section of sections) {
      const key = section.dataset.section;
      expect(section.querySelector("ul.mw-list")).toBeNull();
      expect(section.querySelector("p.empty")!.textContent).toBe(
        t(`mw.empty.${key}`),
      );
    }
  });

  it("orders reached gates before open gates", () => {
    const root = render({
      gates: [
        gate("open", {
          title: "Open gate",
          due_date: "2026-01-01",
          reached: false,
        }),
        gate("reached", {
          title: "Reached gate",
          due_date: "2026-12-01",
          reached: true,
        }),
      ],
      wps: [],
      recent: [],
    });
    const section = sectionOf(root, "decisions");
    const rows = section.querySelectorAll("li.mw-row");

    expect(rows.map((item) => item.dataset.project)).toEqual([
      "project-reached",
      "project-open",
    ]);
    expect(rows[0].textContent).toContain(t("mw.reached"));
  });

  it("sorts open gates by due date with nulls last, then project title", () => {
    const root = render({
      gates: [
        gate("null", {
          due_date: null,
          project_title: "Alpha",
        }),
        gate("beta", {
          due_date: "2026-01-12",
          project_title: "Beta",
        }),
        gate("alpha", {
          due_date: "2026-01-12",
          project_title: "Alpha",
        }),
        gate("early", {
          due_date: "2026-01-11",
          project_title: "Zulu",
        }),
      ],
      wps: [],
      recent: [],
    });
    const section = sectionOf(root, "decisions");

    expect(
      section
        .querySelectorAll("li.mw-row")
        .map((item) => item.dataset.project),
    ).toEqual([
      "project-early",
      "project-alpha",
      "project-beta",
      "project-null",
    ]);
  });

  it("keeps only the 20 newest recent events", () => {
    const events = Array.from({ length: 25 }, (_, index) =>
      recent(index + 1),
    );
    const root = render({ gates: [], wps: [], recent: events });
    const section = sectionOf(root, "recent");
    const rows = section.querySelectorAll("li.mw-row");

    expect(rows).toHaveLength(20);
    expect(rows.map((item) => item.dataset.project)).toEqual(
      Array.from(
        { length: 20 },
        (_, index) => `project-${25 - index}`,
      ),
    );
    expect(section.querySelector("span.mw-count")!.textContent).toBe("20");
  });

  it("opens the project once when a link is clicked", () => {
    const root = render({
      gates: [],
      wps: [wp("click", { end_date: "2026-01-10" })],
      recent: [],
    });
    const button = root.querySelector("button.mw-link")!;

    dispatch(doc, button, "click");

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("project-click");
  });

  it("keeps markup-like titles as text and does not use innerHTML", () => {
    const root = render({
      gates: [
        gate("safe", {
          title: "<b>Unsafe</b>",
          reached: true,
        }),
      ],
      wps: [],
      recent: [],
    });
    const title = root.querySelector("span.mw-title")!;

    expect(title.textContent).toBe("<b>Unsafe</b>");
    expect(title.querySelectorAll("b")).toHaveLength(0);
    expect("innerHTML" in title).toBe(false);
  });
});
