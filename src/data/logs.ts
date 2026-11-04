import type { Caller, EventOut, EventRow, ScoreRow, TokenCostRow, WorkpackageRow } from "../types";
import { reachStmts } from "./milestones";
import { gateGuardStmt, gateGuardedBatch, gateLockedError, lockingGates } from "./gates";
import { LIVE, NotFoundError, ValidationError, eventStmt, newId, now, type Diff } from "./util";
import { activitySet } from "./activity";
import { TransitionError, signOffGuardStmt, verificationGuardStmt, verificationGuarded, verificationRequiredError } from "./rules";
import { canDo, requireAction } from "../auth/permissions";

async function requireProject(db: D1Database, id: string): Promise<void> {
  if (!(await db.prepare(`SELECT 1 FROM project WHERE id = ? AND ${LIVE()}`).bind(id).first()))
    throw new NotFoundError(`project ${id} not found`);
}

async function requireWpOf(db: D1Database, projectId: string, wpId: string): Promise<WorkpackageRow> {
  const wp = await db.prepare(`SELECT * FROM workpackage WHERE id = ? AND ${LIVE()}`).bind(wpId).first<WorkpackageRow>();
  if (!wp || wp.project_id !== projectId) throw new ValidationError(`workpackage ${wpId} is not part of project ${projectId}`);
  return wp;
}

const optText = (v: unknown, max: number, name: string): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new ValidationError(`${name} must be a string`);
  if (v.length > max) throw new ValidationError(`${name} is longer than ${max} characters`);
  return v;
};

/** Append score rows (0..10). */
export async function setScores(
  db: D1Database,
  projectId: string,
  scores: Array<{ criterion: string; value: number; note?: string | null }>,
  by: Caller,
): Promise<ScoreRow[]> {
  await requireProject(db, projectId);
  if (!Array.isArray(scores) || !scores.length || scores.length > 20) throw new ValidationError("scores must hold 1..20 entries");
  const ts = now();
  const rows: ScoreRow[] = scores.map((s) => {
    const criterion = String(s.criterion ?? "").trim();
    if (!criterion || criterion.length > 40) throw new ValidationError("criterion must be 1..40 characters");
    if (typeof s.value !== "number" || !Number.isFinite(s.value) || s.value < 0 || s.value > 10)
      throw new ValidationError(`score ${criterion} must be 0..10`);
    return {
      id: newId(),
      project_id: projectId,
      criterion,
      value: s.value,
      note: optText(s.note, 2000, "note"),
      recorded_at: ts,
      actor: by.actor,
    };
  });
  await db.batch([
    ...rows.map((r) =>
      db
        .prepare("INSERT INTO score (id, project_id, criterion, value, note, recorded_at, actor) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(r.id, r.project_id, r.criterion, r.value, r.note, r.recorded_at, r.actor),
    ),
    eventStmt(db, {
      by,
      project_id: projectId,
      entity: "score",
      entity_id: null,
      action: "set",
      summary: rows.map((r) => `${r.criterion}=${r.value}`).join(", "),
    }),
  ]);
  return rows;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

export async function logTokenCost(
  db: D1Database,
  projectId: string,
  input: { claude_tokens?: number | null; copilot_prompts?: number | null; note?: string | null; workpackage_id?: string | null },
  by: Caller,
): Promise<TokenCostRow> {
  await requireProject(db, projectId);
  const claude = input.claude_tokens ?? null;
  const copilot = input.copilot_prompts ?? null;
  if ((claude !== null && !isCount(claude)) || (copilot !== null && !isCount(copilot)) || (claude === null && copilot === null)) {
    throw new ValidationError("give claude_tokens and/or copilot_prompts as non-negative integers");
  }
  if (input.workpackage_id) await requireWpOf(db, projectId, input.workpackage_id);
  const row: TokenCostRow = {
    id: newId(),
    project_id: projectId,
    workpackage_id: input.workpackage_id ?? null,
    recorded_at: now(),
    claude_tokens: claude,
    copilot_prompts: copilot,
    note: optText(input.note, 2000, "note"),
    actor: by.actor,
  };
  const summary = [claude !== null ? `${claude} tokens` : "", copilot !== null ? `${copilot} prompts` : ""].filter(Boolean).join(", ");
  await db.batch([
    db
      .prepare(
        "INSERT INTO token_cost (id, project_id, workpackage_id, recorded_at, claude_tokens, copilot_prompts, note, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(row.id, row.project_id, row.workpackage_id, row.recorded_at, row.claude_tokens, row.copilot_prompts, row.note, row.actor),
    eventStmt(db, { by, project_id: projectId, entity: "token_cost", entity_id: row.id, action: "log", summary }),
  ]);
  return row;
}

export function parseEffortPd(v: unknown): number | null {
  if (v === undefined || v === null) {
    return null;
  }

  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1000) {
    throw new ValidationError("effort_pd must be a number of person-days greater than 0 and at most 1000");
  }

  return v;
}

export function effortStmt(db: D1Database, wpId: string, pd: number, ts: string, by: Caller): D1PreparedStatement {
  const act = activitySet(by, ts, true);
  return db
    .prepare(
      `UPDATE workpackage SET effort_actual_pd = COALESCE(effort_actual_pd, 0) + ?, version = version + 1, updated_at = ?${act.sql} WHERE id = ?`,
    )
    .bind(pd, ts, ...act.params, wpId);
}

/** Test seam: runs between the reads of logProgress and its batch. */
let beforeProgressWrite: (() => Promise<void>) | null = null;
export function setBeforeProgressWriteForTesting(f: (() => Promise<void>) | null): void {
  beforeProgressWrite = f;
}

const DONE_GUARD_FAILED = /NOT NULL constraint failed: workpackage\.weight/i;
/** Guard (first in the batch): fails when WP `wpId` is done when the batch runs (it was not at read time). */
const doneGuardStmt = (db: D1Database, wpId: string): D1PreparedStatement =>
  db.prepare("UPDATE workpackage SET weight = NULL WHERE id = ? AND status = 'done'").bind(wpId);

/**
 * Spec §25 (D21 d): a person in the dashboard with write access may authorise a progress log on a done
 * WP (same who-may rule as the gate override). Agents, service tokens and the system never can.
 */
const mayAuthoriseDone = (by: Caller): boolean => by.channel === "dashboard" && !!by.personId && canDo(by, "write");

/** 409 WP_DONE: a progress log on a done WP without a person's authorisation. */
function wpDoneError(wpId: string, by: Caller): TransitionError {
  return new TransitionError(
    `work package ${wpId} is done: log a note instead (note: true), or open a new sub-work package or task for new work; ` +
      (mayAuthoriseDone(by)
        ? "to record late work on it (moves actual_end to today), send authorize_done: true"
        : "only a person in the dashboard can authorise a progress log on a done work package"),
    { code: "WP_DONE" },
  );
}

/** 409 GATE_LOCKED for a progress log: the gate error plus the way to log without starting the WP. */
function lockedLogError(e: TransitionError): TransitionError {
  return new TransitionError(`${e.message}; to record work without starting it, log a note (note: true)`, e.current);
}

const optFlag = (v: unknown, name: string): boolean => {
  if (v === undefined || v === null) return false;
  if (typeof v !== "boolean") throw new ValidationError(`${name} must be true or false`);
  return v;
};

/**
 * Main "log what we did" call: event, optional WP progress, optional session id. Spec §25 (D21): a note
 * (`note: true`) is only an event; a progress log starts a todo WP, is refused on a gate-locked WP
 * (409 GATE_LOCKED) and on a done WP (409 WP_DONE) unless a person authorises it (`authorize_done`).
 */
export async function logProgress(
  db: D1Database,
  input: {
    project_id: string;
    summary: string;
    workpackage_id?: string | null;
    progress?: number | null;
    effort_pd?: number | null;
    session_id?: string | null;
    /** A note: stored as an event, never changes status, dates, progress or effort. */
    note?: boolean | null;
    /** REST, dashboard persons with write access only: let a progress log land on a done WP. */
    authorize_done?: boolean | null;
    /** Hook only: stored with the session id in the same batch (own event when it changed). */
    local_host?: string | null;
  },
  by: Caller,
): Promise<{ event_id: number; workpackage?: WorkpackageRow }> {
  await requireProject(db, input.project_id);
  const summary = String(input.summary ?? "").trim();
  if (!summary || summary.length > 2000) throw new ValidationError("summary must be 1..2000 characters");
  const note = optFlag(input.note, "note");
  const authorizeDone = optFlag(input.authorize_done, "authorize_done");
  const wp = input.workpackage_id ? await requireWpOf(db, input.project_id, input.workpackage_id) : null;
  const progress = input.progress ?? null;
  const effort = parseEffortPd(input.effort_pd);
  if (note && (progress !== null || effort !== null)) throw new ValidationError("a note records text only: leave out progress and effort_pd");
  if (effort !== null && !wp) throw new ValidationError("effort_pd needs a workpackage_id");
  if (progress !== null && (typeof progress !== "number" || !Number.isFinite(progress) || progress < 0 || progress > 100)) {
    throw new ValidationError("progress must be 0..100");
  }
  const ts = now();
  const today = ts.slice(0, 10);
  const stmts: D1PreparedStatement[] = [];
  // Spec F8: log_progress is progress on the WP and the project; system callers update no activity data.
  // A note is no progress: it touches last_changed_at only.
  const act = activitySet(by, ts, !note);
  // A progress log is a log with a WP that is not a note; all WP rules below apply to it only.
  const plog = wp && !note ? wp : null;
  const wasDone = plog?.status === "done";
  // D21 (d): a done WP takes a progress log only with a person's authorisation; it then moves actual_end.
  if (plog && wasDone) {
    if (!authorizeDone || !mayAuthoriseDone(by)) throw wpDoneError(plog.id, by);
    if (progress !== null && progress < 100) throw new ValidationError("a done work package keeps progress 100: reopen it to lower its progress");
  }
  // D21 (c): a progress log on a gate-locked WP is refused for every caller but the system (pre-check, and a
  // guard first in the batch). An override (D6) lifts the lock. A done WP is never locked (it is started).
  const gateGuard = { stmts: [] as D1PreparedStatement[], ids: [] as string[] };
  if (plog && !wasDone && by.channel !== "system") {
    const gates = await lockingGates(db, plog.id);
    if (gates.length) throw lockedLogError(gateLockedError(plog.id, gates, by));
    gateGuard.stmts.push(gateGuardStmt(db, plog.id));
    gateGuard.ids.push(plog.id);
  }
  // A WP that becomes done between the read and the write must not take an unauthorised progress log.
  const doneGuard = plog && !wasDone ? [doneGuardStmt(db, plog.id)] : [];
  // Spec F3, D21 (b): a progress log on a todo WP moves it to doing; progress >= 100 finishes it.
  const nextStatus = plog ? (progress !== null && progress >= 100 ? "done" : plog.status === "todo" ? "doing" : plog.status) : null;
  // F2: progress >= 100 completes the WP; with a verification method the caller's person verifies it
  // (no person: refused, and re-checked by a guard first in the batch in case a verification appears meanwhile).
  const completes = !!plog && !wasDone && progress !== null && progress >= 100;
  const verifier = by.personId ?? null;
  const needsVerifier = completes && (plog!.verification ?? "none") !== "none";
  if (needsVerifier && !verifier) throw verificationRequiredError(String(plog!.verification));
  // F11: completing a sign_off WP records the caller as its verifier: decider or above, never a service token.
  if (completes && plog!.verification === "sign_off") requireAction(by, "verify_sign_off");
  // Guarded whenever the log may complete the WP: a verification (or a sign_off) may appear meanwhile (the
  // guards check status and verification when the batch runs).
  const signOffGuarded = completes && !!verifier && !canDo(by, "verify_sign_off");
  const verifyGuard = !completes ? [] : !verifier ? [verificationGuardStmt(db, plog!.id)] : signOffGuarded ? [signOffGuardStmt(db, plog!.id)] : [];
  const diff: Diff = {};
  if (plog && wasDone) {
    // D21 (d): authorised late work on a done WP: status stays done, actual_end moves to the log date.
    stmts.push(
      db
        .prepare(`UPDATE workpackage SET actual_end = ?, version = version + 1, updated_at = ?${act.sql} WHERE id = ? AND status = 'done'`)
        .bind(today, ts, ...act.params, plog.id),
    );
    if (plog.actual_end !== today) diff.actual_end = [plog.actual_end ?? null, today];
  } else if (plog && progress !== null) {
    const verify = "? >= 100 AND status != 'done' AND verification != 'none' AND verified_by IS NULL";
    stmts.push(
      db
        .prepare(
          `UPDATE workpackage SET progress = ?, status = CASE WHEN ? >= 100 THEN 'done' WHEN status = 'todo' THEN 'doing' ELSE status END,
            blocked_since = CASE WHEN ? >= 100 THEN NULL ELSE blocked_since END, waiting_reason = CASE WHEN ? >= 100 THEN NULL ELSE waiting_reason END,
            verified_by = CASE WHEN ${verify} THEN ? ELSE verified_by END, verified_at = CASE WHEN ${verify} THEN ? ELSE verified_at END,
            actual_start = COALESCE(actual_start, ?), actual_end = CASE WHEN ? >= 100 AND status != 'done' THEN ? ELSE actual_end END,
            version = version + 1, updated_at = ?${act.sql} WHERE id = ?`,
        )
        .bind(progress, progress, progress, progress, progress, verifier, progress, ts, today, progress, today, ts, ...act.params, plog.id),
    );
  } else if (plog && plog.status === "todo") {
    stmts.push(
      db
        .prepare(
          `UPDATE workpackage SET status = 'doing', actual_start = COALESCE(actual_start, ?), version = version + 1, updated_at = ?${act.sql} WHERE id = ? AND status = 'todo'`,
        )
        .bind(today, ts, ...act.params, plog.id),
    );
  } else if (plog && !plog.actual_start && plog.status !== "dropped") {
    // D21 (b): a log on a WP under way (doing, blocked, waiting) without an actual start records it once.
    stmts.push(
      db
        .prepare(`UPDATE workpackage SET actual_start = COALESCE(actual_start, ?), version = version + 1, updated_at = ?${act.sql} WHERE id = ?`)
        .bind(today, ts, ...act.params, plog.id),
    );
  }
  if (plog && effort !== null) stmts.push(effortStmt(db, plog.id, effort, ts, by));
  if (plog && effort !== null) diff.effort_actual_pd = [plog.effort_actual_pd ?? null, (plog.effort_actual_pd ?? 0) + effort];
  if (plog && !wasDone && progress !== null) diff.progress = [plog.progress, progress];
  if (plog && nextStatus !== plog.status) diff.status = [plog.status, nextStatus];
  // D21 (b): the first progress log on a WP is its actual start (the log date, whatever the planned start);
  // reaching 100 is its actual end. Planned dates never move from a log (D21 f).
  if (plog && !wasDone && !plog.actual_start && (progress !== null || plog.status !== "dropped")) diff.actual_start = [null, today];
  if (completes) diff.actual_end = [plog!.actual_end ?? null, today];
  // The automatic dates must leave a valid pair (end not before start); refuse before anything is written.
  if (plog && (diff.actual_start || diff.actual_end)) {
    const finalStart = diff.actual_start ? today : plog.actual_start;
    const finalEnd = diff.actual_end ? today : plog.actual_end;
    if (finalStart && finalEnd && finalEnd < finalStart) throw new ValidationError("actual_end cannot be before actual_start");
  }
  if (needsVerifier) {
    diff.verified_by = [null, verifier];
    diff.verified_at = [null, ts];
  }
  const newHost = typeof input.local_host === "string" ? input.local_host : null;
  const oldHost = newHost
    ? ((await db.prepare("SELECT local_host FROM project WHERE id = ?").bind(input.project_id).first<{ local_host: string | null }>())?.local_host ?? null)
    : null;
  const hostChanged = !!newHost && newHost !== oldHost;
  if (input.session_id || hostChanged) {
    stmts.push(
      db
        .prepare(
          `UPDATE project SET session_id = COALESCE(?, session_id), local_host = ${hostChanged ? "?" : "local_host"}, version = version + 1, updated_at = ?${act.sql} WHERE id = ?`,
        )
        .bind(input.session_id || null, ...(hostChanged ? [newHost] : []), ts, ...act.params, input.project_id),
    );
    if (hostChanged)
      stmts.push(
        eventStmt(db, {
          by,
          project_id: input.project_id,
          entity: "project",
          entity_id: input.project_id,
          action: "update",
          summary: "Host name updated by session hook",
          diff: { local_host: [oldHost, newHost] },
        }),
      );
  } else {
    stmts.push(db.prepare(`UPDATE project SET updated_at = ?${act.sql} WHERE id = ?`).bind(ts, ...act.params, input.project_id));
  }
  stmts.push(
    eventStmt(db, {
      by,
      project_id: input.project_id,
      entity: wp ? "workpackage" : "project",
      entity_id: wp ? wp.id : input.project_id,
      action: note ? "note" : "progress",
      summary,
      diff,
    }),
  );
  const reach = Object.keys(diff).length ? reachStmts(db, input.project_id, by) : [];
  const guards = [...doneGuard, ...gateGuard.stmts, ...verifyGuard];
  const batch = [...guards, ...stmts, ...reach];
  if (beforeProgressWrite) await beforeProgressWrite();
  let res: D1Result[];
  try {
    res = await verificationGuarded(db, wp?.id ?? "", () => gateGuardedBatch(db, batch, gateGuard.ids, by), signOffGuarded ? by : undefined);
  } catch (e) {
    if (plog && DONE_GUARD_FAILED.test(String((e as Error)?.message ?? e))) throw wpDoneError(plog.id, by);
    if (e instanceof TransitionError && e.current?.code === "GATE_LOCKED") throw lockedLogError(e);
    throw e;
  }
  const eventId = Number(res[guards.length + stmts.length - 1].meta.last_row_id);
  if (!wp) return { event_id: eventId };
  return {
    event_id: eventId,
    workpackage: (await db.prepare("SELECT * FROM workpackage WHERE id = ?").bind(wp.id).first<WorkpackageRow>())!,
  };
}

/** Events with the human behind each write joined in (person_name), newest first. */
export async function listEvents(
  db: D1Database,
  opts: { project_id?: string; limit?: number; before_id?: number } = {},
): Promise<EventOut[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.project_id) {
    where.push("e.project_id = ?");
    args.push(opts.project_id);
  }
  if (typeof opts.before_id === "number") {
    where.push("e.id < ?");
    args.push(opts.before_id);
  }
  const { results } = await db
    .prepare(
      `SELECT e.*, p.name AS person_name FROM event e LEFT JOIN person p ON p.id = e.person_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY e.id DESC LIMIT ?`,
    )
    .bind(...args, limit)
    .all<EventOut>();
  return results;
}

export async function listInbox(db: D1Database, limit = 100): Promise<EventOut[]> {
  const { results } = await db
    .prepare(
      "SELECT e.*, p.name AS person_name FROM event e LEFT JOIN person p ON p.id = e.person_id WHERE e.project_id IS NULL AND e.action = 'unmatched' ORDER BY e.id DESC LIMIT ?",
    )
    .bind(Math.min(Math.max(Math.trunc(limit), 1), 500))
    .all<EventOut>();
  return results;
}

export async function assignInboxEvent(db: D1Database, eventId: number, projectId: string, by: Caller): Promise<void> {
  const ev = await db.prepare("SELECT * FROM event WHERE id = ?").bind(eventId).first<EventRow>();
  if (!ev) throw new NotFoundError(`event ${eventId} not found`);
  if (ev.project_id !== null || ev.action !== "unmatched") throw new ValidationError("only unassigned inbox events can be assigned");
  await requireProject(db, projectId);
  await db.batch([
    db.prepare("UPDATE event SET project_id = ?, action = 'assigned' WHERE id = ? AND project_id IS NULL").bind(projectId, eventId),
    eventStmt(db, {
      by,
      project_id: projectId,
      entity: "event",
      entity_id: String(eventId),
      action: "assign",
      summary: `inbox event assigned: ${ev.summary ?? ev.entity}`,
    }),
  ]);
}
