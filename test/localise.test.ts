import { describe, expect, it } from "vitest";

// @ts-expect-error untyped JS module
const i18n = (await import("../public/js/i18n.js")) as any;
// @ts-expect-error untyped JS module
const project = (await import("../public/js/project.js")) as any;

describe("pickName", () => {
  it("keeps a string unchanged", () => {
    expect(i18n.pickName("Tracker", "de")).toBe("Tracker");
    expect(i18n.pickName(undefined, "de")).toBeUndefined();
  });
  it("picks the locale, then en, then the first value", () => {
    const n = { en: "Tracker", de: "Verfolger" };
    expect(i18n.pickName(n, "de")).toBe("Verfolger");
    expect(i18n.pickName(n, "en")).toBe("Tracker");
    expect(i18n.pickName({ en: "Tracker" }, "de")).toBe("Tracker");
    expect(i18n.pickName({ fr: "Suivi" }, "de")).toBe("Suivi");
  });
});

describe("project route", () => {
  it("reads context and the old kontext name", () => {
    expect(project.tabFromSegment("context")).toBe("context");
    expect(project.tabFromSegment("kontext")).toBe("context");
    expect(project.tabFromSegment("risks")).toBe("risks");
    expect(project.tabFromSegment(undefined)).toBe("overview");
  });
  it("writes context", () => {
    expect(project.projectHash("x", "context")).toBe("#/p/x/context");
    expect(project.projectHash("x", "risks")).toBe("#/p/x/risks");
    expect(project.projectHash("x", "overview")).toBe("#/p/x");
  });
});

describe("date formatting", () => {
  it("axis labels come from i18n", () => {
    const d = new Date(Date.UTC(2026, 2, 9));
    expect(i18n.fmtMonth(d)).toMatch(/26/);
    expect(i18n.fmtDayMonth(d)).toMatch(/09/);
  });
  it("no Intl.DateTimeFormat or toLocaleDateString outside i18n.js", () => {
    const files = (import.meta as any).glob("../public/js/*.js", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    expect(Object.keys(files).length).toBeGreaterThan(10);
    const bad = Object.entries(files)
      .filter(([f, src]) => !f.endsWith("/i18n.js") && /Intl\.DateTimeFormat|toLocaleDateString/.test(src))
      .map(([f]) => f);
    expect(bad).toEqual([]);
  });
});
