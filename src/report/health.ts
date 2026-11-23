export type HealthState = "on_hold" | "late" | "at_risk" | "stalled" | "on_track";

export type HealthReason =
  | { kind: "on_hold" }
  | { kind: "milestone_overdue"; code: string | null; title: string; gate: boolean; days: number }
  | { kind: "target_passed"; date: string; days: number }
  | { kind: "high_risk"; title: string; score: number }
  | { kind: "wp_blocked"; code: string | null; title: string }
  | { kind: "gate_due"; code: string | null; title: string; due_date: string; days: number }
  | { kind: "wp_late"; code: string | null; title: string; days: number }
  | { kind: "no_activity"; days: number | null }
  | { kind: "next_milestone"; code: string | null; title: string; due_date: string | null };

export type Health = { state: HealthState; reasons: HealthReason[] };

export type HealthFacts = {
  status: string;
  target_date: string | null;
  milestones: Array<{
    code: string | null;
    title: string;
    due_date: string | null;
    reached: boolean;
    gate: boolean;
    decided: boolean;
  }>;
  workpackages: Array<{
    code: string | null;
    title: string;
    status: string;
    end_date: string | null;
  }>;
  high_risks: Array<{ title: string; score: number }>;
  stale: boolean;
  days_since_activity: number | null;
};

export type HealthOptions = { wp_late_days: number; gate_soon_days: number };

export const HEALTH_DEFAULTS: HealthOptions = {
  wp_late_days: 7,
  gate_soon_days: 2,
};

const MS_PER_DAY = 86_400_000;

function utcDay(ymd: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const milliseconds = Date.UTC(year, month - 1, day);
  const date = new Date(milliseconds);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return milliseconds / MS_PER_DAY;
}

export function daysBetween(fromYmd: string, toYmd: string): number {
  const from = utcDay(fromYmd);
  const to = utcDay(toYmd);
  return from === null || to === null ? Number.NaN : to - from;
}

function isOpenWp(status: string): boolean {
  return status !== "done" && status !== "dropped";
}

function compareNatural(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;

  const leftParts = left.match(/\d+|\D+/g) ?? [left];
  const rightParts = right.match(/\d+|\D+/g) ?? [right];
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index];
    const b = rightParts[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;

    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const difference = Number(a) - Number(b);
      if (difference !== 0) return difference;
      if (a.length !== b.length) return a.length - b.length;
    } else {
      const aLower = a.toLowerCase();
      const bLower = b.toLowerCase();
      if (aLower < bLower) return -1;
      if (aLower > bLower) return 1;
      if (a < b) return -1;
      if (a > b) return 1;
    }
  }

  return 0;
}

function reasonCode(reason: HealthReason): string | null {
  switch (reason.kind) {
    case "milestone_overdue":
    case "wp_blocked":
    case "gate_due":
    case "wp_late":
    case "next_milestone":
      return reason.code;
    default:
      return null;
  }
}

function reasonTitle(reason: HealthReason): string {
  switch (reason.kind) {
    case "milestone_overdue":
    case "high_risk":
    case "wp_blocked":
    case "gate_due":
    case "wp_late":
    case "next_milestone":
      return reason.title;
    case "target_passed":
      return reason.date;
    case "on_hold":
      return "on_hold";
    case "no_activity":
      return "no_activity";
  }
}

function overdueStrength(reason: HealthReason): number {
  switch (reason.kind) {
    case "milestone_overdue":
    case "target_passed":
    case "wp_late":
      return reason.days;
    case "gate_due":
      return Math.max(0, -reason.days);
    default:
      return 0;
  }
}

function compareReasons(left: HealthReason, right: HealthReason): number {
  const daysDifference = overdueStrength(right) - overdueStrength(left);
  if (daysDifference !== 0) return daysDifference;

  const codeDifference = compareNatural(reasonCode(left), reasonCode(right));
  if (codeDifference !== 0) return codeDifference;

  const leftTitle = reasonTitle(left);
  const rightTitle = reasonTitle(right);
  if (leftTitle < rightTitle) return -1;
  if (leftTitle > rightTitle) return 1;
  return 0;
}

function lateReasons(facts: HealthFacts, today: string): HealthReason[] {
  const reasons: HealthReason[] = [];

  for (const milestone of facts.milestones) {
    if (milestone.reached || milestone.due_date === null) continue;
    const days = daysBetween(milestone.due_date, today);
    if (Number.isFinite(days) && days > 0) {
      reasons.push({
        kind: "milestone_overdue",
        code: milestone.code,
        title: milestone.title,
        gate: milestone.gate,
        days,
      });
    }
  }

  if (facts.target_date !== null) {
    const days = daysBetween(facts.target_date, today);
    if (Number.isFinite(days) && days > 0) {
      reasons.push({
        kind: "target_passed",
        date: facts.target_date,
        days,
      });
    }
  }

  return reasons.sort(compareReasons);
}

function atRiskReasons(
  facts: HealthFacts,
  today: string,
  options: HealthOptions,
  fallbackWpLateDays = options.wp_late_days,
): HealthReason[] {
  const reasons: HealthReason[] = [];

  for (const risk of facts.high_risks) {
    reasons.push({
      kind: "high_risk",
      title: risk.title,
      score: risk.score,
    });
  }

  for (const workpackage of facts.workpackages) {
    if (workpackage.status === "blocked") {
      reasons.push({
        kind: "wp_blocked",
        code: workpackage.code,
        title: workpackage.title,
      });
    }
  }

  for (const milestone of facts.milestones) {
    if (!milestone.gate || !milestone.reached || milestone.decided || milestone.due_date === null) {
      continue;
    }

    const days = daysBetween(today, milestone.due_date);
    if (Number.isFinite(days) && days <= options.gate_soon_days) {
      reasons.push({
        kind: "gate_due",
        code: milestone.code,
        title: milestone.title,
        due_date: milestone.due_date,
        days,
      });
    }
  }

  for (const workpackage of facts.workpackages) {
    if (!isOpenWp(workpackage.status) || workpackage.end_date === null) continue;
    const days = daysBetween(workpackage.end_date, today);
    if (Number.isFinite(days) && days > fallbackWpLateDays) {
      reasons.push({
        kind: "wp_late",
        code: workpackage.code,
        title: workpackage.title,
        days,
      });
    }
  }

  return reasons.sort(compareReasons);
}

function nextMilestoneReason(facts: HealthFacts): HealthReason | null {
  const candidates = facts.milestones
    .filter((milestone) => !milestone.reached)
    .slice()
    .sort((left, right) => {
      const leftDay = left.due_date === null ? null : utcDay(left.due_date);
      const rightDay = right.due_date === null ? null : utcDay(right.due_date);

      if (leftDay !== null && rightDay !== null && leftDay !== rightDay) {
        return leftDay - rightDay;
      }
      if (leftDay !== null && rightDay === null) return -1;
      if (leftDay === null && rightDay !== null) return 1;

      const codeDifference = compareNatural(left.code, right.code);
      if (codeDifference !== 0) return codeDifference;
      return left.title < right.title ? -1 : left.title > right.title ? 1 : 0;
    });

  const milestone = candidates[0];
  if (milestone === undefined) return null;

  return {
    kind: "next_milestone",
    code: milestone.code,
    title: milestone.title,
    due_date: milestone.due_date !== null && utcDay(milestone.due_date) !== null
      ? milestone.due_date
      : null,
  };
}

function laterReason(
  facts: HealthFacts,
  today: string,
  options: HealthOptions,
  after: "late" | "at_risk",
): HealthReason | null {
  if (after === "late") {
    const atRisk = atRiskReasons(facts, today, options, 0);
    const first = atRisk[0];
    if (first !== undefined) return first;
  } else {
    // Relax only the secondary WP threshold. The primary at-risk facts have
    // already been considered, so do not select one of them again.
    const supplementalWp = atRiskReasons(facts, today, options, 0).find(
      (reason) => reason.kind === "wp_late" && reason.days <= options.wp_late_days,
    );
    if (supplementalWp !== undefined) return supplementalWp;
  }

  if (facts.stale && facts.workpackages.some((workpackage) => isOpenWp(workpackage.status))) {
    return {
      kind: "no_activity",
      days: facts.days_since_activity,
    };
  }

  return nextMilestoneReason(facts);
}

export function projectHealth(
  facts: HealthFacts,
  today: string,
  opts: HealthOptions = HEALTH_DEFAULTS,
): Health | null {
  if (facts.status !== "active" && facts.status !== "on_hold") {
    return null;
  }

  if (facts.status === "on_hold") {
    return {
      state: "on_hold",
      reasons: [{ kind: "on_hold" }],
    };
  }

  const todayDay = utcDay(today);
  const effectiveToday = todayDay === null ? "" : today;

  const late = lateReasons(facts, effectiveToday);
  if (late.length > 0) {
    const reasons = late.slice(0, 2);
    if (reasons.length === 1) {
      const second = laterReason(facts, effectiveToday, opts, "late");
      if (second !== null) reasons.push(second);
    }
    return { state: "late", reasons };
  }

  const atRisk = atRiskReasons(facts, effectiveToday, opts);
  if (atRisk.length > 0) {
    const reasons = atRisk.slice(0, 2);
    if (reasons.length === 1) {
      const second = laterReason(facts, effectiveToday, opts, "at_risk");
      if (second !== null) reasons.push(second);
    }
    return { state: "at_risk", reasons };
  }

  const hasOpenWp = facts.workpackages.some((workpackage) => isOpenWp(workpackage.status));
  if (facts.stale && hasOpenWp) {
    return {
      state: "stalled",
      reasons: [{ kind: "no_activity", days: facts.days_since_activity }],
    };
  }

  const next = nextMilestoneReason(facts);
  return {
    state: "on_track",
    reasons: next === null ? [] : [next],
  };
}
