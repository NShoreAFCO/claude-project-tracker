import type { Caller, EventOut, EventRow, ScoreRow, TokenCostRow, WorkpackageRow } from "../types";
import { reachStmts } from "./milestones";
import { gateGuardedBatch, gateLockedSql, lockingGates, startGuard } from "./gates";
import { LIVE, NotFoundError, ValidationError, eventStmt, newId, now, type Diff } from "./util";
import { activitySet } from "./activity";
import { signOffGuardStmt, verificationGuardStmt, verificationGuarded, verificationRequiredError } from "./rules";
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

/** Main "log what we did" call: event, optional WP progress, optional session id. */
export async function logProgress(
  db: D1Database,
  input: {
    project_id: string;
    summary: string;
    workpackage_id?: string | null;
    progress?: number | null;
    effort_pd?: number | null;
    session_id?: string | null;
  },
  by: Caller,
): Promise<{ event_id: number; workpackage?: WorkpackageRow }> {
  await requireProject(db, input.project_id);
  const summary = String(input.summary ?? "").trim();
  if (!summary || summary.length > 2000) throw new ValidationError("summary must be 1..2000 characters");
  const wp = input.workpackage_id ? await requireWpOf(db, input.project_id, input.workpackage_id) : null;
  const progress = input.progress ?? null;
  const effort = parseEffortPd(input.effort_pd);
  if (effort !== null && !wp) throw new ValidationError("effort_pd needs a workpackage_id");
  if (progress !== null && (typeof progress !== "number" || !Number.isFinite(progress) || progress < 0 || progress > 100)) {
    throw new ValidationError("progress must be 0..100");
  }
  const ts = now();
  const stmts: D1PreparedStatement[] = [];
  // Spec F8: log_progress is progress on the WP and the project; system callers update no activity data.
  const act = activitySet(by, ts, true);
  // Auto-start (spec F3): any progress log on a todo WP moves it to doing; progress ≥ 100 finishes it.
  // F5: a log without progress does not start a gate-locked WP (any caller); progress on one (agents, and
  // dashboard persons without an override) is refused (pre-check, and a guard statement first in the batch).
  const autoStartLocked = !!wp && progress === null && wp.status === "todo" && (await lockingGates(db, wp.id)).length > 0;
  const nextStatus = wp
    ? progress !== null && progress >= 100
      ? "done"
      : wp.status === "todo" && !autoStartLocked
        ? "doing"
        : wp.status
    : null;
  // `always`: the CASE below can still start the WP if its status changes meanwhile, so a progress log is
  // guarded even when it leaves status and progress as read.
  const gateGuard =
    wp && progress !== null
      ? await startGuard(db, by, wp, { status: nextStatus, progress }, { always: true })
      : { stmts: [] as D1PreparedStatement[], ids: [] as string[] };
  // F2: progress >= 100 completes the WP; with a verification method the caller's person verifies it
  // (no person: refused, and re-checked by a guard first in the batch in case a verification appears meanwhile).
  const completes = !!wp && progress !== null && progress >= 100 && wp.status !== "done";
  const verifier = by.personId ?? null;
  const needsVerifier = completes && (wp.verification ?? "none") !== "none";
  if (needsVerifier && !verifier) throw verificationRequiredError(String(wp.verification));
  // F11: completing a sign_off WP records the caller as its verifier: decider or above, never a service token.
  if (completes && wp.verification === "sign_off") requireAction(by, "verify_sign_off");
  // Guarded whenever the log may complete the WP, also when it was done at read time: it may be reopened
  // with a verification meanwhile (the guard checks status and verification when the batch runs). A
  // verifier who may not sign off is guarded against a sign_off appearing meanwhile in the same way.
  const mayComplete = !!wp && progress !== null && progress >= 100;
  const signOffGuarded = mayComplete && !!verifier && !canDo(by, "verify_sign_off");
  const verifyGuard =
    !wp || !mayComplete ? [] : !verifier ? [verificationGuardStmt(db, wp.id)] : signOffGuarded ? [signOffGuardStmt(db, wp.id)] : [];
  if (wp && progress !== null) {
    const verify = "? >= 100 AND status != 'done' AND verification != 'none' AND verified_by IS NULL";
    stmts.push(
      db
        .prepare(
          `UPDATE workpackage SET progress = ?, status = CASE WHEN ? >= 100 THEN 'done' WHEN status = 'todo' THEN 'doing' ELSE status END,
            blocked_since = CASE WHEN ? >= 100 THEN NULL ELSE blocked_since END, waiting_reason = CASE WHEN ? >= 100 THEN NULL ELSE waiting_reason END,
            verified_by = CASE WHEN ${verify} THEN ? ELSE verified_by END, verified_at = CASE WHEN ${verify} THEN ? ELSE verified_at END,
            version = version + 1, updated_at = ?${act.sql} WHERE id = ?`,
        )
        .bind(progress, progress, progress, progress, progress, verifier, progress, ts, ts, ...act.params, wp.id),
    );
  } else if (wp && wp.status === "todo" && !autoStartLocked) {
    stmts.push(
      db
        .prepare(
          `UPDATE workpackage AS w SET status = 'doing', version = version + 1, updated_at = ?${act.sql} WHERE w.id = ? AND w.status = 'todo' AND NOT ${gateLockedSql("w")}`,
        )
        .bind(ts, ...act.params, wp.id),
    );
  }
  if (wp && effort !== null) stmts.push(effortStmt(db, wp.id, effort, ts, by));
  const diff: Diff = {};
  if (wp && effort !== null) diff.effort_actual_pd = [wp.effort_actual_pd ?? null, (wp.effort_actual_pd ?? 0) + effort];
  if (wp && progress !== null) diff.progress = [wp.progress, progress];
  if (wp && nextStatus !== wp.status) diff.status = [wp.status, nextStatus];
  if (needsVerifier) {
    diff.verified_by = [null, verifier];
    diff.verified_at = [null, ts];
  }
  if (input.session_id) {
    stmts.push(
      db
        .prepare(`UPDATE project SET session_id = ?, version = version + 1, updated_at = ?${act.sql} WHERE id = ?`)
        .bind(input.session_id, ts, ...act.params, input.project_id),
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
      action: "progress",
      summary,
      diff,
    }),
  );
  const reach = Object.keys(diff).length ? reachStmts(db, input.project_id, by) : [];
  const batch = [...gateGuard.stmts, ...verifyGuard, ...stmts, ...reach];
  if (beforeProgressWrite) await beforeProgressWrite();
  const res = await verificationGuarded(
    db,
    wp?.id ?? "",
    () => gateGuardedBatch(db, batch, gateGuard.ids, by),
    signOffGuarded ? by : undefined,
  );
  const eventId = Number(res[gateGuard.stmts.length + verifyGuard.length + stmts.length - 1].meta.last_row_id);
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
