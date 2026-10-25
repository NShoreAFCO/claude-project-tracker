/**
 * Neutral gated R&D plan: 10 work packages, 6 milestones, consecutive gates. Five WPs start before the
 * gate that unlocks them (WP2/M1, WP4/M2, WP5/M3a, WP6/M5, WP8/M6); every other date is consistent, so
 * the plan has exactly these five schedule issues, all START_BEFORE_GATE.
 * `prefix` keeps ids unique when the plan is loaded into the database more than once.
 */
export interface GatedWp {
  id: string;
  title: string;
  parent_id: string | null;
  start_date: string;
  end_date: string;
  depends_on: string[];
}
export interface GatedMilestone {
  id: string;
  title: string;
  due_date: string;
  requires: string[];
  unlocks: string[];
}

export function gatedPlan(prefix = ""): { wps: GatedWp[]; milestones: GatedMilestone[]; conflicts: Array<[string, string]> } {
  const w = (n: string) => `${prefix}wp${n}`;
  const m = (n: string) => `${prefix}m${n}`;
  const wp = (n: string, start: string, end: string, deps: string[] = [], parent: string | null = null): GatedWp => ({
    id: w(n),
    title: `WP${n}`,
    parent_id: parent ? w(parent) : null,
    start_date: start,
    end_date: end,
    depends_on: deps.map(w),
  });
  const ms = (n: string, due: string, requires: string[], unlocks: string[]): GatedMilestone => ({
    id: m(n),
    title: `M${n}`,
    due_date: due,
    requires: requires.map(w),
    unlocks: unlocks.map(w),
  });
  return {
    wps: [
      wp("1", "2027-01-04", "2027-01-22"),
      wp("2", "2027-01-25", "2027-02-26", ["1"]),
      wp("3", "2027-01-04", "2027-02-19"),
      wp("4", "2027-02-22", "2027-04-02", ["3"]),
      wp("5", "2027-03-29", "2027-05-07"),
      wp("6", "2027-05-12", "2027-06-11", ["5"]),
      wp("7", "2027-05-10", "2027-06-04", ["5"]),
      wp("8", "2027-06-07", "2027-07-09"),
      wp("9", "2027-06-14", "2027-07-30", ["7"]),
      wp("10", "2027-06-21", "2027-07-23", [], "9"),
    ],
    milestones: [
      ms("1", "2027-02-01", ["1"], ["2"]),
      ms("2", "2027-03-01", ["2", "3"], ["4"]),
      ms("3a", "2027-04-05", ["4"], ["5"]),
      ms("4", "2027-05-10", ["5"], ["7"]),
      ms("5", "2027-05-17", ["5"], ["6"]),
      ms("6", "2027-06-14", ["6", "7"], ["8", "10"]),
    ],
    conflicts: [
      [w("2"), m("1")],
      [w("4"), m("2")],
      [w("5"), m("3a")],
      [w("6"), m("5")],
      [w("8"), m("6")],
    ],
  };
}
