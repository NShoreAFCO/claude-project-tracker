/**
 * Gate decisions (spec F5): who may decide a gate milestone, what a decision does, the gate lock that
 * keeps agents from starting work behind an undecided gate, and the human override of that lock.
 *
 * Every rule that depends on rows other writers can change (latest decision, WP status, project
 * decision maker) is evaluated inside the write's own batch, not only read before it: a failing guard
 * aborts the whole batch (a NOT NULL violation, as with schedule_rev), so nothing is half-written.
 */
import type { Caller, ProjectRow, Role, WorkpackageRow } from "../types";
import { POLICY } from "../policy";
import { isAgent } from "../auth/caller";
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

const DECIDER_ROLES: readonly Role[] = ["decider", "admin"];
const OVERRIDE_ROLES: readonly Role[] = ["editor", "decider", "admin"];
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
/** SQL: WP alias `w` is gate-locked: unstarted, not overridden, unlocked by a closed gate. Uses aliases gl, gm. */
export const gateLockedSql = (w: string): string =>
  gatesEnforced()
    ? `(${w}.deleted_at IS NULL AND ${w}.gate_override_at IS NULL AND ${unstartedSql(w)} AND EXISTS (SELECT 1 FROM milestone_link gl JOIN milestone gm ON gm.id = gl.milestone_id WHERE gl.workpackage_id = ${w}.id AND gl.role = 'unlocks' AND ${gateClosedSql("gm")}))`
    : "0";

const GATE_ORDER = "ORDER BY gm.due_date IS NULL, gm.due_date, gm.sort, gm.title, gm.id";

/** Gate-locked WPs of a project, each with the (first) gate that locks it. */
export async function gateLockedWpIds(db: D1Database, projectId: string): Promise<Map<string, GateRef>> {
  const out = new Map<string, GateRef>();
  if (!gatesEnforced()) return out;
  const { results } = await db
    .prepare(
      `SELECT w.id AS wp_id, gm.id AS milestone_id, gm.title FROM workpackage w
       JOIN milestone_link gl ON gl.workpackage_id = w.id AND gl.role = 'unlocks' JOIN milestone gm ON gm.id = gl.milestone_id
       WHERE w.project_id = ? AND w.deleted_at IS NULL AND w.gate_override_at IS NULL AND ${unstartedSql("w")} AND ${gateClosedSql("gm")} ${GATE_ORDER}`,
    )
    .bind(projectId)
    .all<{ wp_id: string } & GateRef>();
  for (const r of results) if (!out.has(r.wp_id)) out.set(r.wp_id, { milestone_id: r.milestone_id, title: r.title });
  return out;
}

/** The gates that lock one WP right now ([] = not locked). */
export async function lockingGates(db: D1Database, wpId: string): Promise<GateRef[]> {
  if (!gatesEnforced()) return [];
  const { results } = await db
    .prepare(
      `SELECT gm.id AS milestone_id, gm.title FROM workpackage w
       JOIN milestone_link gl ON gl.workpackage_id = w.id AND gl.role = 'unlocks' JOIN milestone gm ON gm.id = gl.milestone_id
       WHERE w.id = ? AND w.deleted_at IS NULL AND w.gate_override_at IS NULL AND ${unstartedSql("w")} AND ${gateClosedSql("gm")} ${GATE_ORDER}`,
    )
    .bind(wpId)
    .all<GateRef>();
  return results.map((r) => ({ milestone_id: r.milestone_id, title: r.title }));
}

export function gateLockedError(wpId: string, gates: GateRef[]): TransitionError {
  const names = gates.map((g) => `"${g.title}" (${g.milestone_id})`).join(", ") || "a gate";
  return new TransitionError(
    `work package ${wpId} is locked by gate ${names} until a go decision is recorded; ask the decision maker to decide, or a person can override the lock in the dashboard`,
    { code: "GATE_LOCKED", gates },
  );
}

const GATE_GUARD_FAILED = /NOT NULL constraint failed: workpackage\.status/i;

/**
 * Guard statement for a batch that starts WP `wpId` on behalf of an agent: a no-op while the WP is not
 * gate-locked, else it fails a NOT NULL constraint and D1 rolls the whole batch back. Put it first.
 */
export const gateGuardStmt = (db: D1Database, wpId: string): D1PreparedStatement =>
  db.prepare(`UPDATE workpackage AS w SET status = NULL WHERE w.id = ? AND ${gateLockedSql("w")}`).bind(wpId);

/**
 * Agent writes that would start a WP (status doing/done, or a progress change) are refused while it is
 * gate-locked: a pre-check for a clear error, and the guard statement for the write's batch (the lock
 * can appear between the read and the write, e.g. a `hold` recorded meanwhile). Persons and the system
 * are not restricted (they override in the dashboard).
 */
export async function agentStartGuard(
  db: D1Database,
  by: Caller,
  wp: Pick<WorkpackageRow, "id" | "status" | "progress">,
  next: { status?: unknown; progress?: unknown },
): Promise<D1PreparedStatement[]> {
  if (!isAgent(by) || !gatesEnforced()) return [];
  const toStarted = (next.status === "doing" || next.status === "done") && next.status !== wp.status;
  const progress = typeof next.progress === "number" && next.progress !== wp.progress;
  if (!toStarted && !progress) return [];
  const gates = await lockingGates(db, wp.id);
  if (gates.length) throw gateLockedError(wp.id, gates);
  return [gateGuardStmt(db, wp.id)];
}

/** scheduleBatch for a batch that may carry gate guards: a failed guard becomes 409 GATE_LOCKED. */
export async function gateGuardedBatch(db: D1Database, stmts: D1PreparedStatement[], wpId: string): Promise<D1Result[]> {
  try {
    return await scheduleBatch(db, stmts);
  } catch (e) {
    if (GATE_GUARD_FAILED.test(String((e as Error)?.message ?? e))) throw gateLockedError(wpId, await lockingGates(db, wpId));
    throw e;
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
  if (!by.role || !OVERRIDE_ROLES.includes(by.role)) throw new ForbiddenError("overriding a gate lock needs the editor role or above");
  const text = typeof reason === "string" ? reason.trim() : "";
  if (!text) throw new ValidationError("reason is required");
  if (text.length > REASON_MAX) throw new ValidationError(`reason must be at most ${REASON_MAX} characters`);
  const wp = await db.prepare(`SELECT * FROM workpackage WHERE id = ? AND ${LIVE()}`).bind(wpId).first<WorkpackageRow>();
  if (!wp) throw new NotFoundError(`workpackage ${wpId} not found`);
  const gates = await lockingGates(db, wp.id);
  const notLocked = () => new TransitionError(`workpackage ${wp.id} is not gate-locked`, { code: "GATE_NOT_LOCKED" });
  if (!gates.length) throw notLocked();
  const ts = now();
  const res = await db.batch([
    db
      .prepare(
        `UPDATE workpackage AS w SET gate_override_by = ?, gate_override_at = ?, gate_override_reason = ?, version = version + 1, updated_at = ?
         WHERE w.id = ? AND w.version = ? AND ${gateLockedSql("w")}`,
      )
      .bind(by.personId, ts, text, ts, wp.id, wp.version),
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
  if (by.channel === "service") throw new ForbiddenError("service tokens cannot record gate decisions; a person records them");
  if (!by.personId) throw new ForbiddenError("gate decisions are recorded by a person (the logged-in user)");
  if (!by.role || !DECIDER_ROLES.includes(by.role)) throw new ForbiddenError("recording a gate decision needs the decider role");

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
  if (onBehalfFlag === true && by.role !== "admin" && by.personId !== dmPerson)
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
          "INSERT INTO workpackage (id, project_id, title, status, progress, weight, sort, version, created_at, updated_at) VALUES (?, ?, ?, 'todo', 0, 1, 0, 1, ?, ?)",
        )
        .bind(id, project.id, conditions[i], ts, ts),
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
    stmts.push(
      db
        .prepare("UPDATE project SET status = 'on_hold', closure_decision_pending = 1, version = version + 1, updated_at = ? WHERE id = ?")
        .bind(ts, project.id),
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
