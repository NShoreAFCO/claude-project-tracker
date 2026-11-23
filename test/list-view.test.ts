import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch, installFakeDom, type FDoc, type FEl } from "./fake-dom";

// @ts-expect-error plain browser module without types
import { t } from "../public/js/i18n.js";
// @ts-expect-error plain browser module without types
import { LIST_COLUMNS, listView } from "../public/js/list-view.js";

const project = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Project ${id}`,
  status: "active",
  category: null,
  health: { state: "on_track", reasons: [] },
  target_date: "2099-12-01",
  next_milestone: {
    id: `milestone-${id}`,
    title: "Kickoff",
    due_date: "2099-11-20",
  },
  progress: 40,
  owner_id: "owner-1",
  owner_initials: "OA",
  wp_counts: {
    open: 1,
    in_progress: 2,
    waiting_blocked: 3,
    done: 4,
  },
  last_activity: null,
  ...over,
});

describe("list view", () => {
  let doc: FDoc;
  let onOpen: ReturnType<typeof vi.fn>;
  let persons: Map<string, string>;

  beforeEach(() => {
    doc = installFakeDom();
    onOpen = vi.fn();
    persons = new Map([["owner-1", "Owner Alpha"]]);
  });

  const render = (projects: Array<Record<string, unknown>>) => {
    const table = listView(projects, { persons, onOpen }) as FEl;
    doc.body.append(table);
    return table;
  };

  it("renders nine headers in LIST_COLUMNS order", () => {
    const table = render([project("a")]);
    const headers = table.querySelectorAll("thead").flatMap((head) => head.querySelectorAll("th"));

    expect(LIST_COLUMNS).toEqual([
      "health",
      "project",
      "status",
      "target",
      "next",
      "progress",
      "owner",
      "wps",
      "activity",
    ]);
    expect(headers).toHaveLength(9);
    expect(headers.map((header) => header.getAttribute("scope"))).toEqual(Array(9).fill("col"));
    expect(headers.map((header) => header.textContent)).toEqual(LIST_COLUMNS.map((key: string) => t(`list.col.${key}`)));
    expect(headers.every((header) => header.textContent !== "" && !header.textContent.startsWith("list.col."))).toBe(true);
  });

  it("renders one row per project in input order", () => {
    const table = render([project("b"), project("a"), project("c")]);
    const rows = table.querySelectorAll("tr.list-row");

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.dataset.id)).toEqual(["b", "a", "c"]);
    expect(rows.every((row) => row.children.length === LIST_COLUMNS.length)).toBe(true);
  });

  it("shows a late target chip for an active project", () => {
    const table = render([project("late", { target_date: "2000-01-01" })]);
    const row = table.querySelector("tr.list-row")!;

    expect(row.children[3].querySelector(".chip.late")).not.toBeNull();
  });

  it("never shows a late target chip for a done project", () => {
    const table = render([
      project("done", {
        status: "done",
        target_date: "2000-01-01",
        next_milestone: null,
      }),
    ]);
    const row = table.querySelector("tr.list-row")!;

    expect(row.children[3].querySelector(".chip.late")).toBeNull();
  });

  it("leaves the health cell empty when health is null", () => {
    const table = render([project("no-health", { health: null })]);
    const healthCell = table.querySelector("tr.list-row")!.children[0];

    expect(healthCell.childNodes).toHaveLength(0);
    expect(healthCell.textContent).toBe("");
  });

  it("opens the project once when its title is clicked", () => {
    const table = render([project("a")]);
    const title = table.querySelector("button.list-link")!;

    dispatch(doc, title, "click");

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("a");
  });

  it("opens the project once when its row is clicked", () => {
    const table = render([project("a")]);
    const row = table.querySelector("tr.list-row")!;

    dispatch(doc, row, "click");

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("a");
  });

  it("renders the spanning empty row for an empty list", () => {
    const table = render([]);
    const body = table.querySelector("tbody")!;
    const rows = body.querySelectorAll("tr");
    const empty = body.querySelector("td.empty")!;

    expect(rows).toHaveLength(1);
    expect(empty.getAttribute("colspan")).toBe(String(LIST_COLUMNS.length));
    expect(empty.textContent).toBe(t("list.empty"));
    expect(empty.textContent).not.toBe("list.empty");
  });

  it("keeps markup-like project titles as text and does not use innerHTML", () => {
    const table = render([project("safe", { title: "<b>Unsafe</b>" })]);
    const title = table.querySelector("button.list-link")!;

    expect(title.textContent).toBe("<b>Unsafe</b>");
    expect(title.querySelectorAll("b")).toHaveLength(0);
    expect("innerHTML" in title).toBe(false);
  });
});
