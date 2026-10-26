/**
 * Gate decisions (spec F5): who may decide a gate milestone, what a decision does, the gate lock that
 * keeps agents from starting work behind an undecided gate, and the human override of that lock.
 *
 * Every rule that depends on rows other writers can change (latest decision, WP status, project
 * decision maker) is evaluated inside the write's own batch, not only read before it: a failing guard
 * aborts the whole batch (a NOT NULL violation, as with schedule_rev), so nothing is half-written.
 */
import type { Caller, ProjectRow, WorkpackageRow } from "../types";
import { hasRole, requireAction } from "../auth/permissions";
import { POLICY } from "../policy";
import { activitySet, isSystem, touchProject } from "./activity";
import { createBaselineStmts } from "./baselines";
import { isClosedProjectStatus, projectClosedError, TransitionError } from "./rules";
import { recomputeScheduleStmts, scheduleBatch, snapWp } from "./schedule";
import {
  ConflictError,
  ForbiddenError,
  LIVE,
  NotFoundError,
  ValidationError,
  eventStmt,
  eventStmtIfChanged,
  newId,
  now,
  slugify,
  type Diff,
} from "./util";

export type Decision = "go" | "go_with_conditions" | "hold" | "stop";
export const DECISIONS: readonly Decision[] = ["go", "go_with_conditions", "hold", "stop"];
/** Decisions that open a gate (unlock its WPs and take a baseline). */
export const OPENING_DECISIONS: readonly Decision[] = ["go", "go_with_conditions"];
export type GateRef = { milestone_id: string; title: string };
export type DecisionInput = {
  decision: Decision;
  note_md?: string;
  evidence?: string[];
  conditions?: string[];
  on_behalf_of_decision_maker?: boolean;
};

const NOTE_MAX = 20000;
const REASON_MAX = 2000;
const EVIDENCE_MAX = 50;
const CONDITIONS_MAX = 20;
const CONDITION_TITLE_MAX = 200;

/** policy.gates.require_decision (default true); false = gates unlock when reached, like other milestones. */
export const gatesEnforced = (): boolean => POLICY.gates?.require_decision !== false;

const OPENING_SQL = `(${OPENING_DECISIONS.map((d) => `'${d}'`).join(", ")})`;
/** SQL: the latest decision of milestone alias `m` (NULL without one). */
export const latestDecisionSql = (m: string): string =>
  `(SELECT d.decision FROM decision d WHERE d.milestone_id = ${m}.id ORDER BY d.decided_at DESC, d.rowid DESC LIMIT 1)`;
/** SQL: milestone alias `m` is a live gate whose latest decision is not go / go_with_conditions. */
export const gateClosedSql = (m: string): string =>
  `(${m}.gate = 1 AND ${m}.deleted_at IS NULL AND COALESCE(${latestDecisionSql(m)}, '') NOT IN ${OPENING_SQL})`;
/**
 * SQL: WP alias `w` has not been started. Started = doing/done or any progress; a WP that went todo →
 * blocked/waiting/dropped without progress is still unstarted, so such a detour does not unlock it.
 */
const unstartedSql = (w: string): string => `(${w}.status NOT IN ('doing', 'done') AND ${w}.progress = 0)`;

/**
 * SQL: the CTE `glk(id, milestone_id, title, due_date, sort)` of all gate-locked WPs with the gate that
 * locks them. Roots: live, unstarted, not overridden WPs in the `unlocks` of a closed gate. The lock covers
 * every live descendant of a root (sub-WPs would otherwise raise the derived progress behind the gate),
 * except a descendant overridden on its own (and its subtree). Not correlated, so it can sit in any statement.
 */
const lockedCte = (): string => `WITH RECURSIVE glk(id, milestone_id, title, due_date, sort) AS (
    SELECT gw.id, gm.id, gm.title, gm.due_date, gm.sort FROM milestone_link gl
      JOIN milestone gm ON gm.id = gl.milestone_id JOIN workpackage gw ON gw.id = gl.workpackage_id
      WHERE gl.role = 'unlocks' AND ${gateClosedSql("gm")} AND gw.deleted_at IS NULL AND gw.gate_override_at IS NULL AND ${unstartedSql("gw")}
    UNION
    SELECT gc.id, glk.milestone_id, glk.title, glk.due_date, glk.sort FROM workpackage gc JOIN glk ON gc.parent_id = glk.id
      WHERE gc.deleted_at IS NULL AND gc.gate_override_at IS NULL)`;
/** SQL: WP alias `w` is gate-locked (always false when the policy turns gate decisions off). */
export const gateLockedSql = (w: string): string =>
  gatesEnforced() ? `(${w}.deleted_at IS NULL AND ${w}.id IN (${lockedCte()} SELECT id FROM glk))` : "0";

const GATE_ORDER = "ORDER BY glk.due_date IS NULL, glk.due_date, glk.sort, glk.title, glk.milestone_id";

/** Gate-locked WPs of a project (sub-WPs of locked WPs included), each with the (first) gate that locks it. */
export async function gateLockedWpIds(db: D1Database, projectId: string): Promise<Map<string, GateRef>> {
  const out = new Map<string, GateRef>();
  if (!gatesEnforced()) return out;
  const { results } = await db
    .prepare(
      `${lockedCte()} SELECT glk.id AS wp_id, glk.milestone_id, glk.title FROM glk JOIN workpackage w ON w.id = glk.id
       WHERE w.project_id = ? ${GATE_ORDER}`,
    )
    .bind(projectId)
    .all<{ wp_id: string } & GateRef>();
  for (const r of results) if (!out.has(r.wp_id)) out.set(r.wp_id, { milestone_id: r.milestone_id, title: r.title });
  return out;
}

/** The gates that lock one WP right now, directly or through a locked ancestor ([] = not locked). */
export async function lockingGates(db: D1Database, wpId: string): Promise<GateRef[]> {
  if (!gatesEnforced()) return [];
  const { results } = await db
    .prepare(`${lockedCte()} SELECT DISTINCT glk.milestone_id, glk.title, glk.due_date, glk.sort FROM glk WHERE glk.id = ? ${GATE_ORDER}`)
    .bind(wpId)
    .all<GateRef>();
  return results.map((r) => ({ milestone_id: r.milestone_id, title: r.title }));
}

/**
 * 409 GATE_LOCKED for `wpId`. For a dashboard caller `current.override_endpoint` names the way through
 * (`overrideId`: the WP to override, default `wpId`); agents cannot override.
 */
export function gateLockedError(wpId: string, gates: GateRef[], by?: Caller, overrideId?: string): TransitionError {
  const names = gates.map((g) => `"${g.title}" (${g.milestone_id})`).join(", ") || "a gate";
  const person = by?.channel === "dashboard";
  const endpoint = `POST /api/workpackages/${overrideId ?? wpId}/gate-override`;
  return new TransitionError(
    `work package ${wpId} is locked by gate ${names} until a go decision is recorded; ` +
      (person
        ? `to start it before the decision, record an override with a reason (${endpoint})`
        : "ask the decision maker to decide, or a person can override the lock in the dashboard"),
    { code: "GATE_LOCKED", gates, ...(person ? { override_endpoint: endpoint } : {}) },
  );
}

const GATE_GUARD_FAILED = /NOT NULL constraint failed: workpackage\.status/i;

/** SQL: WP alias `w` is a lock root itself (in the unlocks of a closed gate), not only below one. */
const directLockedSql = (w: string): string =>
  `(${w}.deleted_at IS NULL AND ${w}.gate_override_at IS NULL AND ${unstartedSql(w)} AND EXISTS (SELECT 1 FROM milestone_link dl
    JOIN milestone dm ON dm.id = dl.milestone_id WHERE dl.workpackage_id = ${w}.id AND dl.role = 'unlocks' AND ${gateClosedSql("dm")}))`;

/**
 * Guard statement for a batch: a no-op while WP `wpId` is not gate-locked (with `onlyViaAncestor`: not
 * locked through an ancestor alone), else it fails a NOT NULL constraint and D1 rolls the whole batch
 * back. Put it first.
 */
export const gateGuardStmt = (db: D1Database, wpId: string, onlyViaAncestor = false): D1PreparedStatement =>
  db
    .prepare(
      `UPDATE workpackage AS w SET status = NULL WHERE w.id = ? AND ${gateLockedSql("w")}${onlyViaAncestor ? ` AND NOT ${directLockedSql("w")}` : ""}`,
    )
    .bind(wpId);

const isStartedStatus = (s: unknown): boolean => s === "doing" || s === "done";

/**
 * Writes that would start a gate-locked WP are refused for every caller but the system: agents always,
 * dashboard persons until the WP has an override (spec F5, §3: humans override with a reason). Refused:
 * - setting a locked WP to doing/done or changing its progress (`always`: any progress write);
 * - moving a WP that is locked only through its ancestors to another parent (that would lift the lock);
 * - creating a started WP under a locked WP, or moving a started WP under one.
 * Each refusal is a pre-check (clear 409) plus a guard statement for the write's batch, so a lock that
 * appears between the read and the write (a `hold` recorded meanwhile) still refuses it.
 * `wp` is the stored row (null on create); `next` the write's fields.
 */
export async function startGuard(
  db: D1Database,
  by: Caller,
  wp: Pick<WorkpackageRow, "id" | "status" | "progress" | "parent_id"> | null,
  next: { status?: unknown; progress?: unknown; parent_id?: unknown },
  opts: { always?: boolean } = {},
): Promise<{ stmts: D1PreparedStatement[]; ids: string[] }> {
  const out: { stmts: D1PreparedStatement[]; ids: string[] } = { stmts: [], ids: [] };
  if (by.channel === "system" || !gatesEnforced()) return out;
  const status = next.status !== undefined ? next.status : (wp?.status ?? "todo");
  const progress = typeof next.progress === "number" ? next.progress : (wp?.progress ?? 0);
  const startedAfter = isStartedStatus(status) || progress > 0;
  const oldParent = wp?.parent_id ?? null;
  const parent = next.parent_id !== undefined ? ((next.parent_id as string | null) ?? null) : oldParent;
  const parentChanged = !!wp && next.parent_id !== undefined && parent !== oldParent;
  if (wp) {
    const toStarted = isStartedStatus(next.status) && next.status !== wp.status;
    const progressChange = typeof next.progress === "number" && next.progress !== wp.progress;
    if (opts.always || toStarted || progressChange) {
      const gates = await lockingGates(db, wp.id);
      if (gates.length) throw gateLockedError(wp.id, gates, by);
      out.stmts.push(gateGuardStmt(db, wp.id));
      out.ids.push(wp.id);
    }
    if (parentChanged) {
      const viaAncestor = await db
        .prepare(`SELECT 1 FROM workpackage w WHERE w.id = ? AND ${gateLockedSql("w")} AND NOT ${directLockedSql("w")}`)
        .bind(wp.id)
        .first();
      if (viaAncestor) throw gateLockedError(wp.id, await lockingGates(db, wp.id), by);
      out.stmts.push(gateGuardStmt(db, wp.id, true));
      out.ids.push(wp.id);
    }
  }
  if (parent && startedAfter && (parentChanged || !wp)) {
    const gates = await lockingGates(db, parent);
    if (gates.length) throw gateLockedError(parent, gates, by);
    out.stmts.push(gateGuardStmt(db, parent));
    out.ids.push(parent);
  }
  return out;
}

/** scheduleBatch for a batch that carries startGuard statements: a failed guard becomes 409 GATE_LOCKED. */
export async function gateGuardedBatch(db: D1Database, stmts: D1PreparedStatement[], ids: string[], by: Caller): Promise<D1Result[]> {
  try {
    return await scheduleBatch(db, stmts);
  } catch (e) {
    if (!GATE_GUARD_FAILED.test(String((e as Error)?.message ?? e))) throw e;
    for (const id of ids) {
      const gates = await lockingGates(db, id);
      if (gates.length) throw gateLockedError(id, gates, by);
    }
    throw gateLockedError(ids[0] ?? "?", [], by);
  }
}

/** Agents never take a gate away while it holds work back (that would be an override). */
export const agentGateRemovalError = (title: string): ForbiddenError =>
  new ForbiddenError(
    `milestone "${title}" is an undecided gate: agents cannot remove the gate flag, its unlocked work packages or the milestone; a person can do this in the dashboard`,
  );

// ---- override

/**
 * A person in the dashboard (editor or above) lets a gate-locked WP start before the decision. Stores
 * who, when and why; agents may then work on the WP normally.
 */
export async function overrideGateLock(db: D1Database, wpId: string, reason: string, by: Caller): Promise<WorkpackageRow> {
  if (by.channel !== "dashboard" || !by.personId)
    throw new ForbiddenError("a gate lock can only be overridden by a person in the dashboard, not by an agent");
  // The route maps to "write" (editor or above); checked here too for direct callers.
  requireAction(by, "write");
  const text = typeof reason === "string" ? reason.trim() : "";
  if (!text) throw new ValidationError("reason is required");
  if (text.length > REASON_MAX) throw new ValidationError(`reason must be at most ${REASON_MAX} characters`);
  const wp = await db.prepare(`SELECT * FROM workpackage WHERE id = ? AND ${LIVE()}`).bind(wpId).first<WorkpackageRow>();
  if (!wp) throw new NotFoundError(`workpackage ${wpId} not found`);
  const gates = await lockingGates(db, wp.id);
  const notLocked = () => new TransitionError(`workpackage ${wp.id} is not gate-locked`, { code: "GATE_NOT_LOCKED" });
  if (!gates.length) throw notLocked();
  const ts = now();
  const act = activitySet(by, ts, false);
  const res = await db.batch([
    db
      .prepare(
        `UPDATE workpackage AS w SET gate_override_by = ?, gate_override_at = ?, gate_override_reason = ?, version = version + 1, updated_at = ?${act.sql}
         WHERE w.id = ? AND w.version = ? AND ${gateLockedSql("w")}`,
      )
      .bind(by.personId, ts, text, ts, ...act.params, wp.id, wp.version),
    eventStmtIfChanged(db, {
      by,
      project_id: wp.project_id,
      entity: "workpackage",
      entity_id: wp.id,
      action: "gate_override",
      summary: `${wp.title}: started before gate decision (${gates.map((g) => g.title).join(", ")})`,
      diff: {
        gate_override_by: [null, by.personId],
        gate_override_at: [null, ts],
        gate_override_reason: [null, text],
        locked_by_gates: [gates.map((g) => g.milestone_id), null],
      },
    }),
    ...touchProject(db, by, wp.project_id, ts, false, true),
  ]);
  const fresh = await db.prepare("SELECT * FROM workpackage WHERE id = ?").bind(wp.id).first<WorkpackageRow>();
  if (!res[0].meta.changes) {
    if (fresh && fresh.version === wp.version) throw notLocked();
    throw new ConflictError("version conflict", fresh);
  }
  return fresh!;
}

// ---- decisions

/** Test seam: runs between the reads of recordGateDecision and its batch. */
let beforeDecisionWrite: (() => Promise<void>) | null = null;
export function setBeforeDecisionWriteForTesting(f: (() => Promise<void>) | null): void {
  beforeDecisionWrite = f;
}

const DECISION_GUARD_FAILED = /NOT NULL constraint failed: decision\.decided_by/i;
const decisionConflict = () =>
  new TransitionError("the gate, the project's status or its decision maker changed meanwhile; reload and try again", {
    code: "DECISION_CONFLICT",
  });

function optNote(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new ValidationError("note_md must be a string");
  const s = v.trim();
  if (s.length > NOTE_MAX) throw new ValidationError(`note_md must be at most ${NOTE_MAX} characters`);
  return s || null;
}

function stringList(v: unknown, name: string, max: number, itemMax: number): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== "string"))
    throw new ValidationError(`${name} must be a list of up to ${max} strings`);
  const out = (v as string[]).map((x) => x.trim());
  if (out.some((x) => !x || x.length > itemMax)) throw new ValidationError(`${name} entries must be 1..${itemMax} characters`);
  return out;
}

const URL_RE = /^https?:\/\/[^\s]+$/i;

/** Evidence entries: http(s) links, or ids of live context documents of the project (no other schemes). */
async function checkEvidence(db: D1Database, projectId: string, evidence: string[]): Promise<void> {
  const docs = evidence.filter((e) => !URL_RE.test(e));
  if (!docs.length) return;
  const { results } = await db
    .prepare(`SELECT id FROM context_doc WHERE project_id = ? AND ${LIVE()} AND id IN (SELECT value FROM json_each(?))`)
    .bind(projectId, JSON.stringify(docs))
    .all<{ id: string }>();
  const known = new Set(results.map((r) => r.id));
  const bad = docs.filter((d) => !known.has(d));
  if (bad.length) throw new ValidationError(`evidence must be http(s) links or context document ids of this project: ${bad.join(", ")}`);
}

/** Unique ids for new WPs, like upsertWorkpackage's (`<project>-<slug>`, `-2`… on collision, trash included). */
async function newWpIds(db: D1Database, projectId: string, titles: string[]): Promise<string[]> {
  const taken = new Set<string>();
  const out: string[] = [];
  for (const t of titles) {
    const base = `${projectId}-${slugify(t)}`.slice(0, 63).replace(/-+$/, "");
    let id = base;
    for (let n = 2; taken.has(id) || (await db.prepare("SELECT 1 FROM workpackage WHERE id = ?").bind(id).first()); n++)
      id = `${base}-${n}`;
    taken.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Record a decision on a gate milestone (spec F5).
 * - Only a person records: `decided_by` is always `by.personId` (for MCP the OAuth login's person);
 *   service tokens and callers without a person are refused, and the caller needs the decider role.
 * - The project needs a decision maker. A person: only they decide, or an admin on their behalf
 *   (`on_behalf_of_decision_maker` with a note). Free text (a body): any decider, the note naming the body.
 * - go / go_with_conditions take a baseline in the same batch; conditions become `todo` WPs (not linked
 *   as requires or unlocks; the decision row keeps their ids); stop puts the project on hold with
 *   `closure_decision_pending`.
 * The batch re-checks the gate, the project status and the decision maker; a change meanwhile → 409.
 */
export async function recordGateDecision(
  db: D1Database,
  milestoneId: string,
  input: DecisionInput,
  by: Caller,
): Promise<{ decision_id: string; baseline_id?: string; created_wps?: string[] }> {
  // F11: decider or above; service tokens never decide (also with on_behalf_of). A person records it:
  // decided_by is the caller's person (the OAuth login for MCP), never an agent or the system.
  requireAction(by, "decide");
  if (!by.personId) throw new ForbiddenError("gate decisions are recorded by a person (the logged-in user)");

  const raw = (input ?? {}) as Record<string, unknown>;
  const decision = raw.decision as Decision;
  if (!DECISIONS.includes(decision)) throw new ValidationError(`decision must be one of ${DECISIONS.join("|")}`);
  const note = optNote(raw.note_md);
  const evidence = stringList(raw.evidence, "evidence", EVIDENCE_MAX, 2000);
  const conditions = stringList(raw.conditions, "conditions", CONDITIONS_MAX, CONDITION_TITLE_MAX);
  if (conditions.length && decision !== "go_with_conditions")
    throw new ValidationError("conditions are only given with go_with_conditions");
  const onBehalfFlag = raw.on_behalf_of_decision_maker;
  if (onBehalfFlag !== undefined && onBehalfFlag !== null && typeof onBehalfFlag !== "boolean")
    throw new ValidationError("on_behalf_of_decision_maker must be true or false");

  const m = await db
    .prepare(`SELECT id, project_id, title, gate FROM milestone WHERE id = ? AND ${LIVE()}`)
    .bind(milestoneId)
    .first<{ id: string; project_id: string; title: string; gate: number }>();
  if (!m) throw new NotFoundError(`milestone ${milestoneId} not found`);
  if (m.gate !== 1) throw new ValidationError(`milestone ${m.id} is not a gate; set gate=true first`);
  const project = await db.prepare(`SELECT * FROM project WHERE id = ? AND ${LIVE()}`).bind(m.project_id).first<ProjectRow>();
  if (!project) throw new NotFoundError(`project ${m.project_id} not found`);
  if (isClosedProjectStatus(project.status)) throw projectClosedError(project.id, project.status);

  const dmPerson = project.decision_maker_person_id;
  const dmText = project.decision_maker_text;
  if (!dmPerson && !dmText)
    throw new TransitionError(
      "the project has no decision maker; set decision_maker (a person, or a body such as a steering board) before deciding a gate",
      { code: "DECISION_MAKER_MISSING", missing: ["decision_maker"] },
    );
  if (onBehalfFlag === true && !hasRole(by, "admin") && by.personId !== dmPerson)
    throw new ForbiddenError("only admins may record a decision on behalf of the decision maker");
  let onBehalf = false;
  if (dmPerson) {
    if (by.personId !== dmPerson) {
      if (onBehalfFlag !== true)
        throw new ForbiddenError(
          "only the project's decision maker may record decisions on its gates; an admin may record one on their behalf (on_behalf_of_decision_maker with a note)",
        );
      if (!note) throw new ValidationError("a decision recorded on behalf of the decision maker needs note_md");
      onBehalf = true;
    }
  } else if (!note) throw new ValidationError(`the decision maker is "${dmText}": note_md must name the body that decided`);
  await checkEvidence(db, project.id, evidence);

  const prev = await db
    .prepare("SELECT decision FROM decision WHERE milestone_id = ? ORDER BY decided_at DESC, rowid DESC LIMIT 1")
    .bind(m.id)
    .first<{ decision: string }>();
  const decisionId = newId();
  const ts = now();
  const opening = OPENING_DECISIONS.includes(decision);
  const wpIds = conditions.length ? await newWpIds(db, project.id, conditions) : [];
  const conditionRows = conditions.map((title, i) => ({ title, workpackage_id: wpIds[i] }));
  const baseline = opening
    ? createBaselineStmts(db, project.id, `Gate decision: ${m.title.slice(0, 150)} (${decision})`, by, { decision_id: decisionId })
    : null;
  const schedule = wpIds.length
    ? await recomputeScheduleStmts(db, project.id, {
        wps: wpIds.map((id) => snapWp({ id, parent_id: null, start_date: null, end_date: null, depends_on: null })),
        strict: false,
      })
    : null;

  // decided_by becomes NULL (a NOT NULL violation that aborts the batch) unless the gate is still a live
  // gate of this project, the project is still open and its decision maker is still the one checked above.
  const guard = `EXISTS (SELECT 1 FROM project p WHERE p.id = ? AND p.deleted_at IS NULL AND p.status NOT IN ('done', 'abandoned')
      AND p.decision_maker_person_id IS ? AND p.decision_maker_text IS ?)
    AND EXISTS (SELECT 1 FROM milestone gm WHERE gm.id = ? AND gm.project_id = ? AND gm.deleted_at IS NULL AND gm.gate = 1)`;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO decision (id, project_id, milestone_id, decision, decided_by, decided_at, decision_note_md, evidence, conditions, on_behalf, actor, baseline_id, created_at)
         SELECT ?, ?, ?, ?, CASE WHEN ${guard} THEN ? ELSE NULL END, ?, ?, ?, ?, ?, ?, ?, ?`,
      )
      .bind(
        decisionId,
        project.id,
        m.id,
        decision,
        project.id,
        dmPerson,
        dmText,
        m.id,
        project.id,
        by.personId,
        ts,
        note,
        evidence.length ? JSON.stringify(evidence) : null,
        conditionRows.length ? JSON.stringify(conditionRows) : null,
        onBehalf ? 1 : 0,
        by.actor,
        baseline?.id ?? null,
        ts,
      ),
  ];
  const diff: Diff = { decision: [prev?.decision ?? null, decision] };
  if (onBehalf) diff.on_behalf = [null, true];
  if (baseline) diff.baseline_id = [null, baseline.id];
  if (wpIds.length) diff.created_workpackages = [null, wpIds];
  stmts.push(
    eventStmt(db, {
      by,
      project_id: project.id,
      entity: "milestone",
      entity_id: m.id,
      action: "decision",
      summary: `${m.title}: ${decision}`,
      diff,
    }),
  );
  for (const [i, id] of wpIds.entries()) {
    stmts.push(
      db
        .prepare(
          "INSERT INTO workpackage (id, project_id, title, status, progress, weight, sort, version, created_at, updated_at, last_progress_at, last_changed_at) VALUES (?, ?, ?, 'todo', 0, 1, 0, 1, ?, ?, ?, ?)",
        )
        .bind(id, project.id, conditions[i], ts, ts, isSystem(by) ? null : ts, isSystem(by) ? null : ts),
      eventStmt(db, {
        by,
        project_id: project.id,
        entity: "workpackage",
        entity_id: id,
        action: "create",
        summary: conditions[i],
        diff: { title: [null, conditions[i]], status: [null, "todo"], decision_id: [null, decisionId] },
      }),
    );
  }
  if (baseline) stmts.push(...baseline.stmts);
  if (decision === "stop") {
    const stopAct = activitySet(by, ts, true);
    stmts.push(
      db
        .prepare(
          `UPDATE project SET status = 'on_hold', closure_decision_pending = 1, version = version + 1, updated_at = ?${stopAct.sql} WHERE id = ?`,
        )
        .bind(ts, ...stopAct.params, project.id),
      eventStmt(db, {
        by,
        project_id: project.id,
        entity: "project",
        entity_id: project.id,
        action: "update",
        summary: `stop decision on ${m.title}: status, closure_decision_pending`,
        diff: {
          ...(project.status !== "on_hold" ? { status: [project.status, "on_hold"] } : {}),
          closure_decision_pending: [project.closure_decision_pending ?? 0, 1],
        },
      }),
    );
  }
  // A decision is progress on the project (spec F8); the stop branch above already wrote the columns.
  if (decision !== "stop") stmts.push(...touchProject(db, by, project.id, ts, true));
  if (schedule) stmts.push(...schedule.stmts);

  if (beforeDecisionWrite) await beforeDecisionWrite();
  try {
    await scheduleBatch(db, stmts);
  } catch (e) {
    if (DECISION_GUARD_FAILED.test(String((e as Error)?.message ?? e))) throw decisionConflict();
    throw e;
  }
  return {
    decision_id: decisionId,
    ...(baseline ? { baseline_id: baseline.id } : {}),
    ...(wpIds.length ? { created_wps: wpIds } : {}),
  };
}
