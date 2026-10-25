/**
 * Baselines (spec F4): a labelled snapshot of the live WP and milestone dates of a project, and the
 * values the detail read derives from the latest one (baseline dates, slip in days).
 */
import type { Caller } from "../types";
import { daysBetween } from "./critical-path";
import { LIVE, NotFoundError, ValidationError, eventStmt, newId, now } from "./util";

export type BaselineRef = { id: string; label: string; decision_id: string | null; created_at: string; created_by: string };
export type BaselineItem = { entity: "workpackage" | "milestone"; entity_id: string; start_date: string | null; end_date: string | null };
export type BaselineFields = { baseline_start: string | null; baseline_end: string | null; slip_days: number | null };

const LABEL_MAX = 200;

/**
 * Snapshot every live WP (start, end) and milestone (due date as end) of the project in a batch of its
 * own. `auto` marks a baseline created by a gate decision. No schedule statements: the plan is unchanged.
 */
export async function createBaseline(
  db: D1Database,
  projectId: string,
  label: string,
  by: Caller,
  auto?: { decision_id: string },
): Promise<{ id: string; label: string; items: number }> {
  const b = createBaselineStmts(db, projectId, label, by, auto);
  if (!(await db.prepare(`SELECT 1 FROM project WHERE id = ? AND ${LIVE()}`).bind(projectId).first()))
    throw new NotFoundError(`project ${projectId} not found`);
  const res = await db.batch(b.stmts);
  return { id: b.id, label: b.label, items: (res[1].meta.changes ?? 0) + (res[2].meta.changes ?? 0) };
}

/**
 * The statements of a baseline snapshot, for a caller that runs them in its own batch (a gate decision
 * takes its baseline atomically with the decision row). No reads: the caller checks that the project
 * exists. stmts[1] and stmts[2] insert the WP and milestone items.
 */
export function createBaselineStmts(
  db: D1Database,
  projectId: string,
  label: string,
  by: Caller,
  auto?: { decision_id: string },
): { id: string; label: string; stmts: D1PreparedStatement[] } {
  const text = typeof label === "string" ? label.trim() : "";
  if (!text) throw new ValidationError("label is required");
  if (text.length > LABEL_MAX) throw new ValidationError(`label must be at most ${LABEL_MAX} characters`);
  const id = newId();
  const stmts = [
    db
      .prepare("INSERT INTO baseline (id, project_id, label, decision_id, created_at, created_by, person_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, projectId, text, auto?.decision_id ?? null, now(), by.actor, by.personId),
    db
      .prepare(
        `INSERT INTO baseline_item (baseline_id, entity, entity_id, start_date, end_date)
         SELECT ?, 'workpackage', id, start_date, end_date FROM workpackage WHERE project_id = ? AND ${LIVE()}`,
      )
      .bind(id, projectId),
    db
      .prepare(
        `INSERT INTO baseline_item (baseline_id, entity, entity_id, start_date, end_date)
         SELECT ?, 'milestone', id, NULL, due_date FROM milestone WHERE project_id = ? AND ${LIVE()}`,
      )
      .bind(id, projectId),
    eventStmt(db, {
      by,
      project_id: projectId,
      entity: "baseline",
      entity_id: id,
      action: "create",
      summary: text,
      diff: auto ? { decision_id: [null, auto.decision_id] } : null,
    }),
  ];
  return { id, label: text, stmts };
}

/** The project's latest baseline (newest created_at, then the last inserted). */
export const latestBaselineStmt = (db: D1Database, projectId: string): D1PreparedStatement =>
  db
    .prepare(
      "SELECT id, label, decision_id, created_at, created_by FROM baseline WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .bind(projectId);

/** Items of the project's latest baseline. */
export const latestBaselineItemsStmt = (db: D1Database, projectId: string): D1PreparedStatement =>
  db
    .prepare(
      `SELECT entity, entity_id, start_date, end_date FROM baseline_item WHERE baseline_id =
         (SELECT id FROM baseline WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1)`,
    )
    .bind(projectId);

/** Baseline dates and slip (current end − baseline end, in days) of one entity; all null without a baseline item or dates. */
export function baselineFields(
  items: Map<string, BaselineItem>,
  entity: BaselineItem["entity"],
  id: string,
  end: string | null,
): BaselineFields {
  const item = items.get(`${entity}:${id}`);
  if (!item) return { baseline_start: null, baseline_end: null, slip_days: null };
  return {
    baseline_start: item.start_date,
    baseline_end: item.end_date,
    slip_days: end && item.end_date ? daysBetween(item.end_date, end) : null,
  };
}

export const baselineItemMap = (rows: BaselineItem[]): Map<string, BaselineItem> =>
  new Map(rows.map((r) => [`${r.entity}:${r.entity_id}`, r]));
