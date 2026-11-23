import { describe, expect, it } from "vitest";
import {
  daysBetween,
  projectHealth,
  type HealthFacts,
  type HealthOptions,
} from "../src/report/health";

const TODAY = "2026-06-10";

function facts(overrides: Partial<HealthFacts> = {}): HealthFacts {
  return {
    status: "active",
    target_date: null,
    milestones: [],
    workpackages: [],
    high_risks: [],
    stale: false,
    days_since_activity: null,
    ...overrides,
  };
}

function milestone(
  overrides: Partial<HealthFacts["milestones"][number]> = {},
): HealthFacts["milestones"][number] {
  return {
    code: "M1",
    title: "Audit",
    due_date: null,
    reached: false,
    gate: false,
    decided: false,
    ...overrides,
  };
}

function wp(
  overrides: Partial<HealthFacts["workpackages"][number]> = {},
): HealthFacts["workpackages"][number] {
  return {
    code: "WP2",
    title: "Build",
    status: "doing",
    end_date: null,
    ...overrides,
  };
}

const options: HealthOptions = {
  wp_late_days: 7,
  gate_soon_days: 2,
};

const gate = milestone({
  code: "G1",
  title: "Gate",
  due_date: "2026-06-11",
  reached: true,
  gate: true,
});

describe("daysBetween", () => {
  it("counts whole UTC days across a month boundary", () => {
    expect(daysBetween("2026-01-31", "2026-02-02")).toBe(2);
  });

  it("counts whole UTC days across a year boundary", () => {
    expect(daysBetween("2025-12-31", "2026-01-02")).toBe(2);
  });

  it("supports negative differences and leap days", () => {
    expect(daysBetween("2026-06-11", TODAY)).toBe(-1);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
  });

  it.each(["2026-02-30", "not-a-date", "2026-13-01", "2026-6-01", ""])(
    "returns NaN for malformed date %s",
    (date) => {
      expect(daysBetween(date, TODAY)).toBeNaN();
      expect(daysBetween(TODAY, date)).toBeNaN();
    },
  );
});

describe("projectHealth", () => {
  it.each(["idea", "done", "abandoned"])("returns null for %s projects", (status) => {
    expect(
      projectHealth(facts({ status, target_date: "2026-01-01" }), TODAY),
    ).toBeNull();
  });

  it("lets on hold beat late and returns only the on-hold reason", () => {
    expect(
      projectHealth(
        facts({
          status: "on_hold",
          target_date: "2026-01-01",
          milestones: [milestone({ due_date: "2026-01-01" })],
          high_risks: [{ title: "Budget", score: 20 }],
        }),
        TODAY,
      ),
    ).toEqual({
      state: "on_hold",
      reasons: [{ kind: "on_hold" }],
    });
  });

  it("returns late for overdue milestones and target dates", () => {
    expect(
      projectHealth(
        facts({
          target_date: "2026-06-05",
          milestones: [milestone({ due_date: "2026-06-01", gate: true })],
        }),
        TODAY,
      ),
    ).toEqual({
      state: "late",
      reasons: [
        {
          kind: "milestone_overdue",
          code: "M1",
          title: "Audit",
          gate: true,
          days: 9,
        },
        { kind: "target_passed", date: "2026-06-05", days: 5 },
      ],
    });
  });

  it("does not consider dates due today overdue", () => {
    expect(
      projectHealth(
        facts({
          target_date: TODAY,
          milestones: [milestone({ due_date: TODAY })],
        }),
        TODAY,
      ),
    ).toEqual({
      state: "on_track",
      reasons: [
        { kind: "next_milestone", code: "M1", title: "Audit", due_date: TODAY },
      ],
    });
  });

  it("lets late beat at risk and uses the later-rule reason second", () => {
    expect(
      projectHealth(
        facts({
          target_date: "2026-06-09",
          high_risks: [{ title: "Budget", score: 20 }],
        }),
        TODAY,
      ),
    ).toEqual({
      state: "late",
      reasons: [
        { kind: "target_passed", date: "2026-06-09", days: 1 },
        { kind: "high_risk", title: "Budget", score: 20 },
      ],
    });
  });

  it("returns at risk for high risks and blocked workpackages", () => {
    const result = projectHealth(
      facts({
        high_risks: [{ title: "Supplier", score: 18 }],
        workpackages: [wp({ title: "Validation", status: "blocked" })],
      }),
      TODAY,
    );

    expect(result?.state).toBe("at_risk");
    expect(result?.reasons).toHaveLength(2);
    expect(result?.reasons).toEqual(
      expect.arrayContaining([
        { kind: "high_risk", title: "Supplier", score: 18 },
        { kind: "wp_blocked", code: "WP2", title: "Validation" },
      ]),
    );
  });

  it("lets at risk beat stalled", () => {
    expect(
      projectHealth(
        facts({
          high_risks: [{ title: "Capacity", score: 15 }],
          stale: true,
          days_since_activity: 30,
          workpackages: [wp()],
        }),
        TODAY,
      ),
    ).toEqual({
      state: "at_risk",
      reasons: [
        { kind: "high_risk", title: "Capacity", score: 15 },
        { kind: "no_activity", days: 30 },
      ],
    });
  });

  it("includes an undecided reached gate at the soon boundary", () => {
    expect(
      projectHealth(
        facts({ milestones: [{ ...gate, due_date: "2026-06-12" }] }),
        TODAY,
        options,
      ),
    ).toEqual({
      state: "at_risk",
      reasons: [
        {
          kind: "gate_due",
          code: "G1",
          title: "Gate",
          due_date: "2026-06-12",
          days: 2,
        },
      ],
    });
  });

  it("does not count a gate beyond gate_soon_days", () => {
    expect(
      projectHealth(
        facts({ milestones: [{ ...gate, due_date: "2026-06-13" }] }),
        TODAY,
        options,
      ),
    ).toEqual({ state: "on_track", reasons: [] });
  });

  it("does not count a decided gate", () => {
    expect(
      projectHealth(
        facts({ milestones: [{ ...gate, due_date: TODAY, decided: true }] }),
        TODAY,
      ),
    ).toEqual({ state: "on_track", reasons: [] });
  });

  it("reports negative gate days without making a reached gate late", () => {
    expect(
      projectHealth(
        facts({ milestones: [{ ...gate, due_date: "2026-06-08" }] }),
        TODAY,
      ),
    ).toEqual({
      state: "at_risk",
      reasons: [
        {
          kind: "gate_due",
          code: "G1",
          title: "Gate",
          due_date: "2026-06-08",
          days: -2,
        },
      ],
    });
  });

  it("applies the wp_late_days boundary: exactly 7 is not at risk, 8 is", () => {
    expect(
      projectHealth(
        facts({ workpackages: [wp({ end_date: "2026-06-03" })] }),
        TODAY,
        options,
      ),
    ).toEqual({ state: "on_track", reasons: [] });

    expect(
      projectHealth(
        facts({ workpackages: [wp({ end_date: "2026-06-02" })] }),
        TODAY,
        options,
      ),
    ).toEqual({
      state: "at_risk",
      reasons: [{ kind: "wp_late", code: "WP2", title: "Build", days: 8 }],
    });
  });

  it("honors custom thresholds", () => {
    const custom: HealthOptions = { wp_late_days: 2, gate_soon_days: 0 };
    expect(
      projectHealth(facts({ milestones: [gate] }), TODAY, custom),
    ).toEqual({ state: "on_track", reasons: [] });
    expect(
      projectHealth(
        facts({ workpackages: [wp({ end_date: "2026-06-07" })] }),
        TODAY,
        custom,
      ),
    ).toEqual({
      state: "at_risk",
      reasons: [{ kind: "wp_late", code: "WP2", title: "Build", days: 3 }],
    });
  });

  it("uses an open WP late by at least one day as a second later-rule reason", () => {
    expect(
      projectHealth(
        facts({
          milestones: [gate],
          workpackages: [wp({ end_date: "2026-06-07" })],
        }),
        TODAY,
        options,
      ),
    ).toEqual({
      state: "at_risk",
      reasons: [
        {
          kind: "gate_due",
          code: "G1",
          title: "Gate",
          due_date: "2026-06-11",
          days: 1,
        },
        { kind: "wp_late", code: "WP2", title: "Build", days: 3 },
      ],
    });
  });

  it.each([
    { end_date: "2026-06-09", days: 1 },
    { end_date: "2026-06-03", days: 7 },
  ])("includes supplemental WP lateness of $days days", ({ end_date, days }) => {
    expect(
      projectHealth(
        facts({
          high_risks: [{ title: "Budget", score: 20 }],
          workpackages: [wp({ end_date })],
        }),
        TODAY,
      ),
    ).toEqual({
      state: "at_risk",
      reasons: [
        { kind: "high_risk", title: "Budget", score: 20 },
        { kind: "wp_late", code: "WP2", title: "Build", days },
      ],
    });
  });

  it.each([TODAY, "2026-06-11", "invalid"])(
    "does not supplement with a WP ending %s",
    (end_date) => {
      expect(
        projectHealth(
          facts({
            high_risks: [{ title: "Budget", score: 20 }],
            workpackages: [wp({ end_date })],
          }),
          TODAY,
        ),
      ).toEqual({
        state: "at_risk",
        reasons: [{ kind: "high_risk", title: "Budget", score: 20 }],
      });
    },
  );

  it("does not duplicate the primary WP-late reason", () => {
    expect(
      projectHealth(
        facts({
          stale: true,
          days_since_activity: 30,
          workpackages: [wp({ end_date: "2026-06-02" })],
        }),
        TODAY,
      ),
    ).toEqual({
      state: "at_risk",
      reasons: [
        { kind: "wp_late", code: "WP2", title: "Build", days: 8 },
        { kind: "no_activity", days: 30 },
      ],
    });
  });

  it("prefers another primary at-risk fact over supplemental WP lateness", () => {
    expect(
      projectHealth(
        facts({
          milestones: [gate],
          high_risks: [{ title: "Budget", score: 20 }],
          workpackages: [wp({ end_date: "2026-06-07" })],
        }),
        TODAY,
      )?.reasons,
    ).toEqual([
      {
        kind: "gate_due",
        code: "G1",
        title: "Gate",
        due_date: "2026-06-11",
        days: 1,
      },
      { kind: "high_risk", title: "Budget", score: 20 },
    ]);
  });

  it("sorts supplemental WP facts by days, natural code, then title", () => {
    expect(
      projectHealth(
        facts({
          milestones: [gate],
          workpackages: [
            wp({ code: "WP1", end_date: "2026-06-08" }),
            wp({ code: "WP10", end_date: "2026-06-07" }),
            wp({ title: "Zulu", end_date: "2026-06-07" }),
            wp({ title: "Alpha", end_date: "2026-06-07" }),
          ],
        }),
        TODAY,
      )?.reasons[1],
    ).toEqual({ kind: "wp_late", code: "WP2", title: "Alpha", days: 3 });
  });

  it("allows supplemental WP lateness after a single late fact", () => {
    expect(
      projectHealth(
        facts({
          target_date: "2026-06-09",
          workpackages: [wp({ end_date: "2026-06-07" })],
        }),
        TODAY,
      ),
    ).toEqual({
      state: "late",
      reasons: [
        { kind: "target_passed", date: "2026-06-09", days: 1 },
        { kind: "wp_late", code: "WP2", title: "Build", days: 3 },
      ],
    });
  });

  it("never counts reached non-gate milestones as late", () => {
    expect(
      projectHealth(
        facts({
          milestones: [milestone({ due_date: "2026-01-01", reached: true })],
        }),
        TODAY,
      ),
    ).toEqual({ state: "on_track", reasons: [] });
  });

  it.each(["done", "dropped"])("never counts %s workpackages", (status) => {
    expect(
      projectHealth(
        facts({
          stale: true,
          days_since_activity: 50,
          workpackages: [wp({ status, end_date: "2026-01-01" })],
        }),
        TODAY,
      ),
    ).toEqual({ state: "on_track", reasons: [] });

    expect(
      projectHealth(
        facts({
          milestones: [gate],
          workpackages: [wp({ status, end_date: "2026-06-07" })],
        }),
        TODAY,
      )?.reasons,
    ).toHaveLength(1);
  });

  it("returns stalled only when stale with an open workpackage", () => {
    expect(
      projectHealth(
        facts({
          stale: true,
          days_since_activity: 12,
          workpackages: [wp({ status: "todo" })],
        }),
        TODAY,
      ),
    ).toEqual({
      state: "stalled",
      reasons: [{ kind: "no_activity", days: 12 }],
    });
  });

  it("preserves unknown activity age", () => {
    expect(
      projectHealth(facts({ stale: true, workpackages: [wp()] }), TODAY),
    ).toEqual({
      state: "stalled",
      reasons: [{ kind: "no_activity", days: null }],
    });
  });

  it("returns on track for a stale project with no open workpackage", () => {
    expect(
      projectHealth(facts({ stale: true, days_since_activity: 12 }), TODAY),
    ).toEqual({ state: "on_track", reasons: [] });
  });

  it("returns the earliest next unreached milestone with null dates last", () => {
    expect(
      projectHealth(
        facts({
          milestones: [
            milestone({ code: "M3", title: "Undated" }),
            milestone({ code: "M2", title: "Later", due_date: "2026-07-20" }),
            milestone({ title: "Sooner", due_date: "2026-07-01" }),
          ],
        }),
        TODAY,
      ),
    ).toEqual({
      state: "on_track",
      reasons: [
        {
          kind: "next_milestone",
          code: "M1",
          title: "Sooner",
          due_date: "2026-07-01",
        },
      ],
    });
  });

  it("orders reasons by overdue days, then natural code order", () => {
    expect(
      projectHealth(
        facts({
          milestones: [
            milestone({ code: "WP10", title: "Ten", due_date: "2026-06-01" }),
            milestone({ code: "WP2", title: "Two", due_date: "2026-06-01" }),
            milestone({ code: "WP1", title: "Oldest", due_date: "2026-05-31" }),
          ],
        }),
        TODAY,
      )?.reasons,
    ).toEqual([
      {
        kind: "milestone_overdue",
        code: "WP1",
        title: "Oldest",
        gate: false,
        days: 10,
      },
      {
        kind: "milestone_overdue",
        code: "WP2",
        title: "Two",
        gate: false,
        days: 9,
      },
    ]);
  });

  it("uses title to break equal-day and equal-code ties", () => {
    expect(
      projectHealth(
        facts({
          milestones: [
            milestone({ title: "Zulu", due_date: "2026-06-01" }),
            milestone({ title: "Alpha", due_date: "2026-06-01" }),
          ],
        }),
        TODAY,
      )?.reasons.map((reason) => "title" in reason ? reason.title : null),
    ).toEqual(["Alpha", "Zulu"]);
  });

  it("returns at most two reasons", () => {
    const result = projectHealth(
      facts({
        high_risks: [
          { title: "Risk A", score: 20 },
          { title: "Risk B", score: 19 },
          { title: "Risk C", score: 18 },
        ],
        workpackages: [wp({ status: "blocked" })],
      }),
      TODAY,
    );

    expect(result?.reasons).toHaveLength(2);
  });

  it("ignores malformed dates without throwing", () => {
    const input = facts({
      target_date: "2026-02-30",
      milestones: [
        milestone({ title: "Bad milestone", due_date: "invalid" }),
        { ...gate, due_date: "2026-02-30" },
      ],
      workpackages: [wp({ end_date: "2026-99-99" })],
    });

    expect(() => projectHealth(input, TODAY)).not.toThrow();
    expect(projectHealth(input, TODAY)).toEqual({
      state: "on_track",
      reasons: [
        {
          kind: "next_milestone",
          code: "M1",
          title: "Bad milestone",
          due_date: null,
        },
      ],
    });
  });

  it("treats a malformed today as absent date input", () => {
    expect(() =>
      projectHealth(facts({ target_date: "2026-01-01" }), "bad"),
    ).not.toThrow();
    expect(
      projectHealth(facts({ target_date: "2026-01-01" }), "bad"),
    ).toEqual({ state: "on_track", reasons: [] });
  });
});
