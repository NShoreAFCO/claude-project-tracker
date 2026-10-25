/**
 * Schedule validation (spec F4): issues between WP dates, dependencies, parents and milestone links.
 * `scheduleIssues` is pure; `recomputeScheduleStmts` loads a project's plan, applies the pending write,
 * and returns the statements that store each entity's issues (to append to the write's batch).
 */
import { POLICY } from "../policy";
import { TransitionError } from "./rules";
import { LIVE, ValidationError, parseJsonArray } from "./util";

export type ScheduleIssueCode =
  "DEP_START_BEFORE_PRED_END" | "START_BEFORE_GATE" | "CHILD_OUTSIDE_PARENT" | "MILESTONE_BEFORE_REQUIRED_END" | "DEP_UNKNOWN";
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
 * either side gives no issue. A depends_on entry that is not a WP of the snapshot (dangling id or legacy
 * free text) is DEP_UNKNOWN; self references and unknown milestone links are ignored. Sorted by entity, id, code, related id.
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

    for (const dep of wp.depends_on) {
      if (dep === wp.id || wps.has(dep)) continue;
      issues.push({
        code: "DEP_UNKNOWN",
        entity: "workpackage",
        entity_id: wp.id,
        related_id: dep,
        message: `Work package ${wp.id} depends on "${dep}", which is not a work package of this project.`,
      });
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

/**
 * The write a recompute should see. `wps` / `milestones`: rows as they will be stored after the batch
 * (created, updated or moved in). `remove*`: ids that leave the live plan (trash, moved out). `restore*`:
 * ids that come back from the trash.
 */
export interface ScheduleChange {
  wps?: SnapWp[];
  milestones?: SnapMs[];
  removeWps?: string[];
  removeMilestones?: string[];
  restoreWps?: string[];
  restoreMilestones?: string[];
  /** Id of the WP whose depends_on the write sets: every entry must be another live WP of the project. */
  checkDependsOn?: string;
  /** Apply schedule_strict (default: when the change writes WPs or milestones). */
  strict?: boolean;
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
 * Stored depends_on → entries for the schedule: a JSON array gives its ids; any other non-empty text
 * (legacy free text) is kept as one entry, so it is reported as DEP_UNKNOWN instead of disappearing.
 */
export function storedDependsOn(v: string | null | undefined): string[] {
  const s = (v ?? "").trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try {
      const a = JSON.parse(s);
      if (Array.isArray(a)) return a.map(String);
    } catch {
      /* legacy text that only starts with "[" */
    }
  }
  return [s];
}

/** A concurrent schedule-affecting write won the race (HTTP 409). */
export const scheduleConflictError = (): TransitionError =>
  new TransitionError("the project's schedule changed meanwhile; reload and try again", { code: "SCHEDULE_CONFLICT" });

const REV_GUARD_FAILED = /NOT NULL constraint failed: project\.schedule_rev/i;

/**
 * db.batch for a batch that carries recomputeScheduleStmts statements: a lost schedule race aborts the
 * whole batch (the revision guard fails a NOT NULL constraint, so D1 rolls everything back) and becomes
 * TransitionError SCHEDULE_CONFLICT.
 */
export async function scheduleBatch(db: D1Database, stmts: D1PreparedStatement[]): Promise<D1Result[]> {
  try {
    return await db.batch(stmts);
  } catch (e) {
    if (REV_GUARD_FAILED.test(String((e as Error)?.message ?? e))) throw scheduleConflictError();
    throw e;
  }
}

/** Test seam: runs between the reads of recomputeScheduleStmts and the caller's batch. */
let afterScheduleRead: (() => Promise<void>) | null = null;
export function setAfterScheduleReadForTesting(f: (() => Promise<void>) | null): void {
  afterScheduleRead = f;
}

type WpRow = {
  id: string;
  parent_id: string | null;
  start_date: string | null;
  end_date: string | null;
  depends_on: string | null;
  schedule_issues: string | null;
  deleted_at: string | null;
};
type MsRow = { id: string; due_date: string | null; schedule_issues: string | null; deleted_at: string | null };

/**
 * Load the project's plan, apply `change`, compute the issues and return the statements that store
 * each entity's `schedule_issues` ("[]" when computed and empty; no version bump: derived data).
 * Append them to the write's batch after the INSERT/UPDATE of the written rows and run that batch with
 * scheduleBatch: when the change affects the schedule, the statements start with a guarded bump of
 * `project.schedule_rev`, so a concurrent schedule write between these reads and the batch aborts the
 * whole batch with 409 SCHEDULE_CONFLICT.
 * - `change.checkDependsOn`: an unknown (or own) id in that WP's depends_on → ValidationError.
 *   Stored legacy values are never checked; they show up as DEP_UNKNOWN.
 * - Strict project: a write that adds issues → TransitionError SCHEDULE_STRICT (409), current.issues
 *   lists the added ones. Existing issues do not block unrelated writes.
 */
export async function recomputeScheduleStmts(
  db: D1Database,
  projectId: string,
  change?: ScheduleChange,
): Promise<{ stmts: D1PreparedStatement[]; issues: ScheduleIssue[] }> {
  const [projRes, wpRes, msRes, linkRes] = await db.batch([
    db.prepare("SELECT schedule_strict, schedule_rev FROM project WHERE id = ?").bind(projectId),
    db
      .prepare("SELECT id, parent_id, start_date, end_date, depends_on, schedule_issues, deleted_at FROM workpackage WHERE project_id = ?")
      .bind(projectId),
    db.prepare("SELECT id, due_date, schedule_issues, deleted_at FROM milestone WHERE project_id = ?").bind(projectId),
    db
      .prepare(
        "SELECT l.milestone_id, l.workpackage_id, l.role FROM milestone_link l JOIN milestone m ON m.id = l.milestone_id WHERE m.project_id = ?",
      )
      .bind(projectId),
  ]);
  const project = projRes.results[0] as { schedule_strict: number | null; schedule_rev: number } | undefined;
  const wpRows = wpRes.results as WpRow[];
  const msRows = msRes.results as MsRow[];
  const links = new Map<string, { requires: string[]; unlocks: string[] }>();
  for (const l of linkRes.results as Array<{ milestone_id: string; workpackage_id: string; role: string }>) {
    const e = links.get(l.milestone_id) ?? { requires: [], unlocks: [] };
    (l.role === "requires" ? e.requires : e.unlocks).push(l.workpackage_id);
    links.set(l.milestone_id, e);
  }
  const toWp = (w: WpRow): SnapWp => ({
    id: w.id,
    parent_id: w.parent_id,
    start_date: w.start_date,
    end_date: w.end_date,
    depends_on: storedDependsOn(w.depends_on),
  });
  const toMs = (m: MsRow): SnapMs => ({ id: m.id, due_date: m.due_date, ...(links.get(m.id) ?? { requires: [], unlocks: [] }) });

  const before: ScheduleSnapshot = {
    wps: wpRows.filter((w) => !w.deleted_at).map(toWp),
    milestones: msRows.filter((m) => !m.deleted_at).map(toMs),
  };
  const c = change ?? {};
  const gone = new Set([...(c.removeWps ?? []), ...(c.wps ?? []).map((w) => w.id)]);
  const goneMs = new Set([...(c.removeMilestones ?? []), ...(c.milestones ?? []).map((m) => m.id)]);
  const back = new Set(c.restoreWps ?? []);
  const backMs = new Set(c.restoreMilestones ?? []);
  const after: ScheduleSnapshot = {
    wps: [...wpRows.filter((w) => (!w.deleted_at || back.has(w.id)) && !gone.has(w.id)).map(toWp), ...(c.wps ?? [])],
    milestones: [...msRows.filter((m) => (!m.deleted_at || backMs.has(m.id)) && !goneMs.has(m.id)).map(toMs), ...(c.milestones ?? [])],
  };
  if (c.checkDependsOn) {
    const self = after.wps.find((w) => w.id === c.checkDependsOn);
    const known = new Set(after.wps.map((w) => w.id));
    const bad = (self?.depends_on ?? []).filter((d) => d === c.checkDependsOn || !known.has(d));
    if (bad.length) throw new ValidationError(`depends_on: not other workpackages of project ${projectId}: ${bad.join(", ")}`);
  }
  if (change && afterScheduleRead) await afterScheduleRead();
  const issues = scheduleIssues(after);

  const strict = c.strict ?? !!(c.wps?.length || c.milestones?.length);
  if (strict && isScheduleStrict(project?.schedule_strict)) {
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
  const writes: D1PreparedStatement[] = [];
  const targets = [...after.wps.map((w) => ["workpackage", w.id] as const), ...after.milestones.map((m) => ["milestone", m.id] as const)];
  for (const [table, id] of targets) {
    const value = JSON.stringify(per.get(`${table}:${id}`) ?? []);
    if (stored.get(`${table}:${id}`) === value) continue;
    writes.push(db.prepare(`UPDATE ${table} SET schedule_issues = ? WHERE id = ?`).bind(value, id));
  }
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const norm = (s: ScheduleSnapshot) => JSON.stringify([[...s.wps].sort(byId), [...s.milestones].sort(byId)]);
  if (!project || (!writes.length && norm(before) === norm(after))) return { stmts: writes, issues };
  // Guarded revision bump: NULL (a NOT NULL violation that aborts the batch) unless the revision is
  // still the one read above.
  const rev = db
    .prepare("UPDATE project SET schedule_rev = CASE WHEN schedule_rev = ? THEN schedule_rev + 1 ELSE NULL END WHERE id = ?")
    .bind(project.schedule_rev, projectId);
  return { stmts: [rev, ...writes], issues };
}

/**
 * Recompute and store a project's issues on their own (read backfill, repair after a lost version
 * race). A concurrent schedule write that wins stores fresh issues itself, so a lost race is ignored.
 */
export async function storeSchedule(db: D1Database, projectId: string): Promise<ScheduleIssue[]> {
  const { stmts, issues } = await recomputeScheduleStmts(db, projectId);
  if (stmts.length)
    await scheduleBatch(db, stmts).catch((e) => {
      if (!(e instanceof TransitionError && e.current.code === "SCHEDULE_CONFLICT")) throw e;
    });
  return issues;
}

/** Compute and store a project's issues once when one of its live rows was never computed (NULL). */
export async function ensureSchedule(db: D1Database, projectId: string): Promise<void> {
  const missing = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM workpackage WHERE project_id = ?1 AND ${LIVE()} AND schedule_issues IS NULL)
          OR EXISTS (SELECT 1 FROM milestone WHERE project_id = ?1 AND ${LIVE()} AND schedule_issues IS NULL) AS n`,
    )
    .bind(projectId)
    .first<{ n: number }>();
  if (missing?.n) await storeSchedule(db, projectId);
}
