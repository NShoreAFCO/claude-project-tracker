/**
 * Schedule validation (spec F4): issues between WP dates, dependencies, parents and milestone links.
 * `scheduleIssues` is pure; `recomputeScheduleStmts` loads a project's plan, applies the pending write,
 * and returns the statements that store each entity's issues (to append to the write's batch).
 */
import { POLICY } from "../policy";
import { TransitionError } from "./rules";
import { LIVE, ValidationError, parseJsonArray } from "./util";

export type ScheduleIssueCode =
  "DEP_START_BEFORE_PRED_END" | "START_BEFORE_GATE" | "CHILD_OUTSIDE_PARENT" | "MILESTONE_BEFORE_REQUIRED_END";
export interface ScheduleIssue {
  code: ScheduleIssueCode;
  entity: "workpackage" | "milestone";
  entity_id: string;
  related_id: string;
  message: string;
}
export interface ScheduleSnapshot {
  wps: Array<{ id: string; parent_id: string | null; start_date: string | null; end_date: string | null; depends_on: string[] }>;
  milestones: Array<{ id: string; due_date: string | null; requires: string[]; unlocks: string[] }>;
}
type SnapWp = ScheduleSnapshot["wps"][number];
type SnapMs = ScheduleSnapshot["milestones"][number];

/**
 * All schedule issues of a plan (pure). Dates are YYYY-MM-DD and compared lexically; a missing date on
 * either side gives no issue, unknown ids and self references are ignored. Sorted by entity, id, code, related id.
 */
export function scheduleIssues(s: ScheduleSnapshot): ScheduleIssue[] {
  const issues: ScheduleIssue[] = [];

  const wps = new Map(s.wps.map((wp) => [wp.id, wp]));

  for (const wp of s.wps) {
    if (wp.start_date !== null) {
      for (const predecessorId of wp.depends_on) {
        if (predecessorId === wp.id) continue;

        const predecessor = wps.get(predecessorId);
        if (predecessor?.end_date !== null && predecessor?.end_date !== undefined && wp.start_date < predecessor.end_date) {
          issues.push({
            code: "DEP_START_BEFORE_PRED_END",
            entity: "workpackage",
            entity_id: wp.id,
            related_id: predecessor.id,
            message: `Work package ${wp.id} starts ${wp.start_date} before predecessor ${predecessor.id} ends ${predecessor.end_date}.`,
          });
        }
      }
    }

    if (wp.parent_id !== null && wp.parent_id !== wp.id) {
      const parent = wps.get(wp.parent_id);

      if (parent !== undefined) {
        const startsOutside = wp.start_date !== null && parent.start_date !== null && wp.start_date < parent.start_date;

        const endsOutside = wp.end_date !== null && parent.end_date !== null && wp.end_date > parent.end_date;

        if (startsOutside || endsOutside) {
          const childDates = `start ${wp.start_date ?? "unknown"}, end ${wp.end_date ?? "unknown"}`;
          const parentDates = `start ${parent.start_date ?? "unknown"}, end ${parent.end_date ?? "unknown"}`;

          issues.push({
            code: "CHILD_OUTSIDE_PARENT",
            entity: "workpackage",
            entity_id: wp.id,
            related_id: parent.id,
            message: `Work package ${wp.id} (${childDates}) is outside parent ${parent.id} (${parentDates}).`,
          });
        }
      }
    }
  }

  for (const milestone of s.milestones) {
    if (milestone.due_date !== null) {
      for (const wpId of milestone.unlocks) {
        if (wpId === milestone.id) continue;

        const wp = wps.get(wpId);
        if (wp !== undefined && wp.start_date !== null && wp.start_date < milestone.due_date) {
          issues.push({
            code: "START_BEFORE_GATE",
            entity: "workpackage",
            entity_id: wp.id,
            related_id: milestone.id,
            message: `Work package ${wp.id} starts ${wp.start_date} before milestone ${milestone.id} is due ${milestone.due_date}.`,
          });
        }
      }

      for (const requiredId of milestone.requires) {
        if (requiredId === milestone.id) continue;

        const required = wps.get(requiredId);
        if (required !== undefined && required.end_date !== null && milestone.due_date < required.end_date) {
          issues.push({
            code: "MILESTONE_BEFORE_REQUIRED_END",
            entity: "milestone",
            entity_id: milestone.id,
            related_id: required.id,
            message: `Milestone ${milestone.id} is due ${milestone.due_date} before required work package ${required.id} ends ${required.end_date}.`,
          });
        }
      }
    }
  }

  return issues.sort((a, b) => {
    if (a.entity !== b.entity) return a.entity < b.entity ? -1 : 1;
    if (a.entity_id !== b.entity_id) return a.entity_id < b.entity_id ? -1 : 1;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.related_id !== b.related_id) return a.related_id < b.related_id ? -1 : 1;
    return 0;
  });
}

/** The write a recompute should see: the WP or milestone as it will be stored after the batch. */
export interface ScheduleChange {
  wp?: SnapWp;
  milestone?: SnapMs;
  /** The write sets depends_on: every id must be another live WP of the project. */
  checkDependsOn?: boolean;
}

const issueKey = (i: ScheduleIssue): string => `${i.code}|${i.entity}|${i.entity_id}|${i.related_id}`;

/** Effective strict flag: the project's own setting, else the policy default. */
export const isScheduleStrict = (projectStrict: number | null | undefined): boolean =>
  projectStrict == null ? !!POLICY.schedule_strict_default : projectStrict === 1;

/** Issues that concern one entity (as the entity itself or as the related one). */
export const issuesOf = (issues: ScheduleIssue[], id: string): ScheduleIssue[] =>
  issues.filter((i) => i.entity_id === id || i.related_id === id);

/** depends_on input → id list: an array, a JSON array string or a comma-separated string; null clears. */
export function dependsOnInput(v: unknown): string[] {
  if (v === null || v === "") return [];
  if (Array.isArray(v)) {
    if (v.some((x) => typeof x !== "string")) throw new ValidationError("depends_on must be a list of workpackage ids");
    return [...new Set((v as string[]).map((x) => x.trim()).filter(Boolean))];
  }
  if (typeof v !== "string") throw new ValidationError("depends_on must be a list of workpackage ids");
  const list = v.trim().startsWith("[") ? parseJsonArray(v) : v.split(",");
  return [...new Set(list.map((x) => x.trim()).filter(Boolean))];
}

/**
 * Load the project's live plan, apply `change`, compute the issues and return the statements that
 * store every changed `schedule_issues` value (no version bump: derived data). Append them at the end
 * of the write's batch, after the INSERT/UPDATE of the written row.
 * - `change.checkDependsOn`: an unknown (or own) id in the written WP's depends_on → ValidationError.
 * - Strict project: a write that adds issues → TransitionError SCHEDULE_STRICT (409), current.issues
 *   lists the added ones. Existing issues do not block unrelated writes.
 */
export async function recomputeScheduleStmts(
  db: D1Database,
  projectId: string,
  change?: ScheduleChange,
): Promise<{ stmts: D1PreparedStatement[]; issues: ScheduleIssue[] }> {
  const [projRes, wpRes, msRes, linkRes] = await db.batch([
    db.prepare("SELECT schedule_strict FROM project WHERE id = ?").bind(projectId),
    db
      .prepare(
        `SELECT id, parent_id, start_date, end_date, depends_on, schedule_issues FROM workpackage WHERE project_id = ? AND ${LIVE()}`,
      )
      .bind(projectId),
    db.prepare(`SELECT id, due_date, schedule_issues FROM milestone WHERE project_id = ? AND ${LIVE()}`).bind(projectId),
    db
      .prepare(
        `SELECT l.milestone_id, l.workpackage_id, l.role FROM milestone_link l JOIN milestone m ON m.id = l.milestone_id
         JOIN workpackage w ON w.id = l.workpackage_id WHERE m.project_id = ? AND ${LIVE("m")} AND ${LIVE("w")}`,
      )
      .bind(projectId),
  ]);
  type WpRow = {
    id: string;
    parent_id: string | null;
    start_date: string | null;
    end_date: string | null;
    depends_on: string | null;
    schedule_issues: string | null;
  };
  type MsRow = { id: string; due_date: string | null; schedule_issues: string | null };
  const wpRows = wpRes.results as WpRow[];
  const msRows = msRes.results as MsRow[];
  const links = new Map<string, { requires: string[]; unlocks: string[] }>();
  for (const l of linkRes.results as Array<{ milestone_id: string; workpackage_id: string; role: string }>) {
    const e = links.get(l.milestone_id) ?? { requires: [], unlocks: [] };
    (l.role === "requires" ? e.requires : e.unlocks).push(l.workpackage_id);
    links.set(l.milestone_id, e);
  }
  const before: ScheduleSnapshot = {
    wps: wpRows.map((w) => ({
      id: w.id,
      parent_id: w.parent_id,
      start_date: w.start_date,
      end_date: w.end_date,
      depends_on: parseJsonArray(w.depends_on),
    })),
    milestones: msRows.map((m) => ({ id: m.id, due_date: m.due_date, ...(links.get(m.id) ?? { requires: [], unlocks: [] }) })),
  };
  const after: ScheduleSnapshot = { wps: [...before.wps], milestones: [...before.milestones] };
  if (change?.wp) {
    const w = change.wp;
    if (change.checkDependsOn) {
      const known = new Set(before.wps.map((x) => x.id));
      const bad = w.depends_on.filter((d) => d === w.id || !known.has(d));
      if (bad.length) throw new ValidationError(`depends_on: not other workpackages of project ${projectId}: ${bad.join(", ")}`);
    }
    after.wps = [...after.wps.filter((x) => x.id !== w.id), w];
  }
  if (change?.milestone) {
    const m = change.milestone;
    after.milestones = [...after.milestones.filter((x) => x.id !== m.id), m];
  }
  const issues = scheduleIssues(after);

  if (change && isScheduleStrict((projRes.results[0] as { schedule_strict: number | null } | undefined)?.schedule_strict)) {
    const old = new Set(scheduleIssues(before).map(issueKey));
    const added = issues.filter((i) => !old.has(issueKey(i)));
    if (added.length)
      throw new TransitionError(`schedule_strict: the write adds ${added.length} schedule issue${added.length === 1 ? "" : "s"}`, {
        code: "SCHEDULE_STRICT",
        issues: added,
      });
  }

  const per = new Map<string, ScheduleIssue[]>();
  for (const i of issues) per.set(`${i.entity}:${i.entity_id}`, [...(per.get(`${i.entity}:${i.entity_id}`) ?? []), i]);
  const stored = new Map<string, string | null>([
    ...wpRows.map((w) => [`workpackage:${w.id}`, w.schedule_issues] as const),
    ...msRows.map((m) => [`milestone:${m.id}`, m.schedule_issues] as const),
  ]);
  const stmts: D1PreparedStatement[] = [];
  const targets = [...after.wps.map((w) => ["workpackage", w.id] as const), ...after.milestones.map((m) => ["milestone", m.id] as const)];
  for (const [table, id] of targets) {
    const list = per.get(`${table}:${id}`);
    const value = list?.length ? JSON.stringify(list) : null;
    if ((stored.get(`${table}:${id}`) ?? null) === value) continue;
    stmts.push(db.prepare(`UPDATE ${table} SET schedule_issues = ? WHERE id = ?`).bind(value, id));
  }
  return { stmts, issues };
}

/** Recompute and store a project's issues on its own (after writes that only remove or restore entities). */
export async function storeSchedule(db: D1Database, projectId: string): Promise<ScheduleIssue[]> {
  const { stmts, issues } = await recomputeScheduleStmts(db, projectId);
  if (stmts.length) await db.batch(stmts);
  return issues;
}
