import { describe, expect, it } from "vitest";
import { barCategory, effectiveCategories, isHuman } from "../src/data/categories";
import type { WorkpackageRow } from "../src/types";
import { testCaller } from "./helpers";

const wp = (id: string, o: Partial<WorkpackageRow> = {}): WorkpackageRow => ({
  id,
  project_id: "p",
  parent_id: null,
  title: id,
  description_md: null,
  status: "todo",
  blocked_by: null,
  progress: 0,
  weight: 1,
  start_date: null,
  end_date: null,
  depends_on: null,
  sort: 0,
  category: null,
  human: null,
  owner_person_id: null,
  owner_text: null,
  drop_reason: null,
  blocked_since: null,
  waiting_reason: null,
  version: 1,
  created_at: "",
  updated_at: "",
  last_progress_at: null,
  last_changed_at: null,
  ...o,
});

describe("effectiveCategories", () => {
  it("inherits through two levels, own category wins", () => {
    const all = [
      wp("a", { category: "research" }),
      wp("b", { parent_id: "a" }),
      wp("c", { parent_id: "b" }),
      wp("d", { parent_id: "a", category: "docs" }),
    ];
    const eff = effectiveCategories(all);
    expect(eff.get("c")).toBe("research");
    expect(eff.get("d")).toBe("docs");
  });
  it("null parent and null child → null", () => {
    const eff = effectiveCategories([wp("a"), wp("b", { parent_id: "a" })]);
    expect(eff.get("b")).toBeNull();
  });
});

describe("isHuman", () => {
  it("defaults from category and can be overridden", () => {
    expect(isHuman(wp("a"), "pm")).toBe(true);
    expect(isHuman(wp("a"), "experimental")).toBe(true);
    expect(isHuman(wp("a"), "coding")).toBe(false);
    expect(isHuman(wp("a"), null)).toBe(false);
    expect(isHuman(wp("a", { human: 0 }), "pm")).toBe(false);
    expect(isHuman(wp("a", { human: 1 }), "coding")).toBe(true);
  });
});

describe("barCategory", () => {
  const parent = wp("p", { category: "coding" });
  const eff = (list: WorkpackageRow[]) => effectiveCategories([parent, ...list]);
  it("majority by summed weight", () => {
    const kids = [wp("k1", { parent_id: "p", category: "coding", weight: 1 }), wp("k2", { parent_id: "p", category: "docs", weight: 2 })];
    expect(barCategory(parent, kids, eff(kids))).toBe("docs");
  });
  it("tie goes to the parent's own category", () => {
    const kids = [wp("k1", { parent_id: "p", category: "docs" }), wp("k2", { parent_id: "p", category: "coding" })];
    expect(barCategory(parent, kids, eff(kids))).toBe("coding");
  });
  it("tie without own category goes to the first in WP_CATEGORIES order", async () => {
    const bare = wp("q");
    const { INSTANCE } = await import("../src/generated/instance");
    const [first, second] = INSTANCE.categories.workpackage.map((c) => c.key);
    const kids = [wp("k1", { parent_id: "q", category: second }), wp("k2", { parent_id: "q", category: first })];
    expect(barCategory(bare, kids, effectiveCategories([bare, ...kids]))).toBe(first);
  });
  it("ignores dropped children", () => {
    const kids = [
      wp("k1", { parent_id: "p", category: "docs", weight: 5, status: "dropped" }),
      wp("k2", { parent_id: "p", category: "data" }),
    ];
    expect(barCategory(parent, kids, eff(kids))).toBe("data");
  });
  it("leaf → its effective category", () => {
    expect(barCategory(parent, [], eff([]))).toBe("coding");
  });
});

describe("configured work category without human flag", () => {
  it("is listed and not human by default", async () => {
    const { WP_CATEGORIES } = await import("../src/data/categories");
    const { INSTANCE } = await import("../src/generated/instance");
    const key = INSTANCE.categories.workpackage.find((c) => !("human" in c && c.human))?.key;
    expect(key).toBeDefined();
    expect(WP_CATEGORIES).toContain(key);
    expect(isHuman(wp("m"), key!)).toBe(false);
  });
});

describe("categories from the instance", () => {
  it("category lists come from the instance", async () => {
    const { INSTANCE } = await import("../src/generated/instance");
    const { PROJECT_CATEGORIES, WP_CATEGORIES, HUMAN_DEFAULT } = await import("../src/data/categories");
    expect([...PROJECT_CATEGORIES]).toEqual(INSTANCE.categories.project.map((c) => c.key));
    expect([...WP_CATEGORIES]).toEqual(INSTANCE.categories.workpackage.map((c) => c.key));
    expect([...HUMAN_DEFAULT]).toEqual(INSTANCE.categories.workpackage.filter((c) => c.human).map((c) => c.key));
    expect(new Set(PROJECT_CATEGORIES).size).toBe(PROJECT_CATEGORIES.length);
  });

  it("legacy category survives unrelated update", async () => {
    const { env } = await import("cloudflare:test");
    const { createProject, updateProject, getProjectRow } = await import("../src/data/projects");
    await createProject(env.DB, { id: "legacy", title: "Legacy" }, testCaller());
    await env.DB.prepare("UPDATE project SET category = 'retired-key' WHERE id = 'legacy'").run();
    await updateProject(env.DB, "legacy", { title: "Legacy renamed" }, testCaller());
    const row = await getProjectRow(env.DB, "legacy");
    expect(row.title).toBe("Legacy renamed");
    expect(row.category).toBe("retired-key");
  });

  it("setting an unknown category is rejected", async () => {
    const { env } = await import("cloudflare:test");
    const { createProject } = await import("../src/data/projects");
    const { INSTANCE } = await import("../src/generated/instance");
    await expect(createProject(env.DB, { id: "bad", title: "Bad", category: "retired-key" }, testCaller())).rejects.toThrow(
      new RegExp(
        INSTANCE.categories.project
          .slice(0, 3)
          .map((c) => c.key)
          .join("\|"),
      ),
    );
  });
});
