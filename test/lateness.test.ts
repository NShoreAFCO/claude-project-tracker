// Shared lateness helper: UTC day rule, never-late states, chip text.
import { beforeEach, describe, expect, it } from "vitest";
import { installFakeDom } from "./fake-dom";
// @ts-expect-error plain browser module without types
import { lateness, lateChip } from "../public/js/lateness.js";

const at = (iso: string) => new Date(iso);

describe("lateness", () => {
  it("compares in UTC across a date change", () => {
    expect(lateness("2026-05-10", "doing", at("2026-05-10T23:30:00Z"))).toMatchObject({ late: false, days: 0 });
    expect(lateness("2026-05-10", "doing", at("2026-05-11T00:30:00Z"))).toMatchObject({ late: true, days: 1 });
  });
  it("counts whole days", () => {
    expect(lateness("2026-05-01", "open", at("2026-05-08T12:00:00Z")).days).toBe(7);
    expect(lateness("2026-02-27", "open", at("2026-03-02T00:00:00Z")).days).toBe(3);
  });
  it("is not late with no date or a future date", () => {
    expect(lateness(null, "doing")).toMatchObject({ late: false, days: 0 });
    expect(lateness("2099-01-01", "doing")).toMatchObject({ late: false, days: 0 });
  });
  it("never flags done, dropped or reached", () => {
    const now = at("2026-06-01T00:00:00Z");
    for (const s of ["done", "dropped", "reached"]) expect(lateness("2026-01-01", s, now).late).toBe(false);
    expect(lateness("2026-01-01", "open", now).late).toBe(true);
  });
});

describe("lateChip", () => {
  beforeEach(() => {
    installFakeDom();
  });
  it("is null when not late", () => {
    expect(lateChip(lateness("2026-06-01", "done", at("2026-07-01T00:00:00Z")))).toBeNull();
    expect(lateChip(null)).toBeNull();
  });
  it("shows the words and days, with the icon hidden from readers", () => {
    const chip = lateChip(lateness("2026-05-01", "doing", at("2026-05-08T10:00:00Z")))!;
    expect(chip.classList.contains("late")).toBe(true);
    expect(chip.textContent).toContain("Overdue · 7 d");
    expect(chip.getAttribute("title")).toBe("Due 2026-05-01, 7 days overdue");
    expect(chip.querySelector("[aria-hidden]")).not.toBeNull();
  });
});
