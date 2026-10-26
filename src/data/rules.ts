/**
 * Status rules and closure (spec F3): which transitions need what, how blockers are referenced,
 * and moving open work packages to a follow-up project.
 */
import type { Caller, ProjectRow, WorkpackageRow } from "../types";
import { activitySet } from "./activity";
import { reachStmts } from "./milestones";
import { recomputeScheduleStmts, scheduleBatch, storeSchedule, storedDependsOn, type ScheduleIssue } from "./schedule";
import {
  ConflictError,
  ForbiddenError,
  LIVE,
  NotFoundError,
  ValidationError,
  eventStmtWhere,
  now,
  parseJsonArray,
  type Diff,
} from "./util";
import { gateLockedError, gateLockedSql, gatesEnforced, lockingGates } from "./gates";
import { resolvePersonRef } from "./persons";
import { isAgent } from "../auth/caller";

/** Machine-readable details of a refused transition (the 409 body's `current`). */
export type TransitionDetails = {
  code: string;
  open_workpackages?: Array<{ id: string; title: string; status: string }>;
  missing?: string[];
  /** RETENTION: when the item may be purged. */
  purgeable_at?: string;
  /** SCHEDULE_STRICT: the schedule issues the refused write would add. */
  issues?: ScheduleIssue[];
  /** GATE_LOCKED: the undecided gates that lock the work package. */
  gates?: Array<{ milestone_id: string; title: string }>;
  /** GATE_LOCKED for a dashboard caller: the override endpoint that lets the WP start. */
  override_endpoint?: string;
};

/** A status transition that the rules refuse (HTTP 409); `current` says why. */
export class TransitionError extends ConflictError {
  declare readonly current: TransitionDetails;
  constructor(message: string, current: TransitionDetails) {
    super(message, current);
  }
}

/** WP statuses that keep a project from being closed (and that may be moved to a follow-up project). */
export const OPEN_WP_STATUSES = ["todo", "doing", "blocked", "waiting"] as const;
/** Closed project statuses. */
export const CLOSED_PROJECT_STATUSES = ["done", "abandoned"] as const;

export const isOpenWpStatus = (s: string): boolean => (OPEN_WP_STATUSES as readonly string[]).includes(s);
export const isClosedProjectStatus = (s: string): boolean => (CLOSED_PROJECT_STATUSES as readonly string[]).includes(s);

/** SQL condition on a workpackage row (no alias): open and not soft-deleted. */
export const OPEN_WP_SQL = `deleted_at IS NULL AND status IN (${OPEN_WP_STATUSES.map((s) => `'${s}'`).join(", ")})`;

export const todayUtc = (): string => new Date().toISOString().slice(0, 10);

const filled = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";

// ---- projects

export async function openWorkpackages(db: D1Database, projectId: string): Promise<Array<{ id: string; title: string; status: string }>> {
  const { results } = await db
    .prepare(`SELECT id, title, status FROM workpackage WHERE project_id = ? AND ${OPEN_WP_SQL} ORDER BY sort, title`)
    .bind(projectId)
    .all<{ id: string; title: string; status: string }>();
  return results;
}

export function openWorkpackagesError(open: Array<{ id: string; title: string; status: string }>): TransitionError {
  return new TransitionError(
    `project has ${open.length} open work package${open.length === 1 ? "" : "s"}; finish, drop or move them before closing it as done`,
    { code: "OPEN_WORKPACKAGES", open_workpackages: open },
  );
}

/** Closure fields a project still needs for `status` (done: note and lessons learned; abandoned: note). */
export function closureMissing(status: string, row: Pick<ProjectRow, "closure_note_md" | "lessons_learned_md">): string[] {
  if (!isClosedProjectStatus(status)) return [];
  const missing: string[] = [];
  if (!filled(row.closure_note_md)) missing.push("closure_note_md");
  if (status === "done" && !filled(row.lessons_learned_md)) missing.push("lessons_learned_md");
  return missing;
}

export function closureError(status: string, missing: string[]): TransitionError {
  return new TransitionError(`status ${status} requires ${missing.join(" and ")} (lessons learned may be "none")`, {
    code: "CLOSURE_FIELDS_MISSING",
    missing,
  });
}

/** A closed project gets no new or reopened WPs; the way back is reopening the project. */
export function projectClosedError(projectId: string, status: string): TransitionError {
  return new TransitionError(
    `project ${projectId} is ${status}: work packages cannot be added or reopened; reopen the project (status active or on_hold) first`,
    { code: "PROJECT_CLOSED" },
  );
}

/** Derived project flags (computed on read). */
export function projectFlags(
  status: string,
  wps: WorkpackageRow[],
  derivedProgress: (wps: WorkpackageRow[]) => number,
): { stalled_blocked: boolean; closure_due: boolean } {
  const live = wps.filter((w) => !(w as { deleted_at?: string | null }).deleted_at);
  const ids = new Set(live.map((w) => w.id));
  const top = live.filter((w) => !w.parent_id || !ids.has(w.parent_id));
  const allClosed = live.every((w) => w.status === "done" || w.status === "dropped");
  return {
    stalled_blocked: top.some((w) => w.status === "blocked"),
    closure_due: !isClosedProjectStatus(status) && allClosed && live.some((w) => w.status === "done") && derivedProgress(live) >= 100,
  };
}

/** follows: projects this one continues; followed_by: its follow-up projects. */
export async function projectLinks(db: D1Database, projectId: string): Promise<{ follows: string[]; followed_by: string[] }> {
  const { results } = await db
    .prepare(
      `SELECT l.from_project_id, l.to_project_id FROM project_link l
       JOIN project f ON f.id = l.from_project_id AND ${LIVE("f")} JOIN project t ON t.id = l.to_project_id AND ${LIVE("t")}
       WHERE l.kind = 'follows' AND (l.from_project_id = ? OR l.to_project_id = ?) ORDER BY l.created_at, l.from_project_id, l.to_project_id`,
    )
    .bind(projectId, projectId)
    .all<{ from_project_id: string; to_project_id: string }>();
  return {
    follows: results.filter((r) => r.from_project_id === projectId).map((r) => r.to_project_id),
    followed_by: results.filter((r) => r.to_project_id === projectId).map((r) => r.from_project_id),
  };
}

// ---- work packages

export type BlockedRef = { kind: "wp" | "ms" | "ext" | "text"; ref: string };

/**
 * Classify a `blocked_by` value: `wp:<id>`, `ms:<id>`, `ext:<text>`, or free text (legacy values and
 * anything else stay valid as kind "text"). Empty → null.
 */
export function parseBlockedBy(v: string | null): BlockedRef | null {
  if (v == null) return null;
  const s = v.trim();
  if (!s) return null;
  const m = /^(wp|ms|ext):([\s\S]*)$/.exec(s);
  if (m && m[2].trim()) return { kind: m[1] as "wp" | "ms" | "ext", ref: m[2].trim() };
  return { kind: "text", ref: s };
}

/** `wp:` and `ms:` references must name an existing work package or milestone (not one in the trash). */
export async function checkBlockedRef(db: D1Database, v: unknown): Promise<void> {
  const ref = typeof v === "string" ? parseBlockedBy(v) : null;
  if (!ref || (ref.kind !== "wp" && ref.kind !== "ms")) return;
  const table = ref.kind === "wp" ? "workpackage" : "milestone";
  if (!(await db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND ${LIVE()}`).bind(ref.ref).first()))
    throw new ValidationError(`blocked_by: ${table} ${ref.ref} not found (use ext:<text> for external blockers)`);
}

type WpRuleState = Pick<WorkpackageRow, "status" | "progress" | "drop_reason" | "blocked_since" | "waiting_reason">;

/**
 * Apply the WP status rules to a write (mutates `fields`). `before` is the stored row, null on create.
 * - Auto-start: a `todo` WP whose progress rises above 0 becomes `doing`, unless the write sets a status.
 * - `blocked_since` defaults to today when the WP becomes `blocked`; cleared when it is not blocked.
 * - `waiting_reason` is cleared when the WP is not `waiting`.
 * - `dropped` needs a `drop_reason` (given in the write or already stored).
 */
export function applyWpRules(before: WpRuleState | null, fields: Record<string, unknown>, today = todayUtc()): void {
  const prev = before?.status ?? "todo";
  const progress = fields.progress;
  if (
    fields.status === undefined &&
    prev === "todo" &&
    typeof progress === "number" &&
    progress > 0 &&
    progress !== (before?.progress ?? 0)
  )
    fields.status = "doing";
  const next = String(fields.status ?? prev);
  if (next === "blocked") {
    if ((prev !== "blocked" || !before) && fields.blocked_since == null) fields.blocked_since = today;
  } else fields.blocked_since = null;
  if (next !== "waiting") fields.waiting_reason = null;
  if (next === "dropped" && (prev !== "dropped" || !before || "drop_reason" in fields)) {
    const reason = "drop_reason" in fields ? fields.drop_reason : before?.drop_reason;
    if (!filled(reason))
      throw new TransitionError("status dropped requires drop_reason", { code: "DROP_REASON_MISSING", missing: ["drop_reason"] });
  }
}

// ---- verification (spec F2)

/** How a WP's completion is verified; `none` = no verification needed. */
export const VERIFICATIONS = ["review", "test", "demo", "sign_off", "none"] as const;
export type Verification = (typeof VERIFICATIONS)[number];

/** Strength of a verification method; agents may raise it but never lower it (test and demo are equal). */
const VERIFICATION_RANK: Record<string, number> = { none: 0, review: 1, test: 2, demo: 2, sign_off: 3 };
export const verificationRank = (v: unknown): number => VERIFICATION_RANK[String(v ?? "none")] ?? 0;

/**
 * SQL list of the stored verification values an agent may change from when writing `to` (rank not above
 * `to`'s): the in-batch re-check of the no-lowering rule. Values come from VERIFICATIONS, never from input.
 */
export const verificationNotAboveSql = (to: unknown): string =>
  `(${VERIFICATIONS.filter((v) => verificationRank(v) <= verificationRank(to))
    .map((v) => `'${v}'`)
    .join(", ")})`;

export const verificationLoweredError = (from: string, to: string): ForbiddenError =>
  new ForbiddenError(
    `agents may raise a work package's verification but not lower it (${from} -> ${to}); a person lowers it in the dashboard`,
  );

export const verificationRequiredError = (verification: string): TransitionError =>
  new TransitionError(
    `status done with verification ${verification} requires verified_by: a person (the logged-in user by default; a service token needs on_behalf_of)`,
    { code: "VERIFICATION_REQUIRED", missing: ["verified_by"] },
  );

/**
 * The `verified_by` input: undefined keeps the stored value, null or "" clears it, anything else must
 * resolve to a live person (id, email or exact name; free text and agent names are refused). Agents
 * (MCP, service tokens) may only name their own person: the OAuth login, or the service's on_behalf_of.
 */
export async function verifierInput(db: D1Database, v: unknown, by: Caller): Promise<string | null | undefined> {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string" || v.trim().length > 200) throw new ValidationError("verified_by must be a person id or email");
  const { person_id } = await resolvePersonRef(db, v);
  if (!person_id)
    throw new ValidationError(
      `verified_by: "${v.trim()}" matches no person; verified_by must reference a person, not free text or an agent`,
    );
  if (isAgent(by) && person_id !== by.personId)
    throw new ForbiddenError(
      "agents may only record their own login's person as verified_by; the person who verified records it in the dashboard",
    );
  return person_id;
}

type VerifyState = Pick<WorkpackageRow, "status" | "verification" | "verified_by" | "verified_at">;

/**
 * Apply the verification rule to a write (mutates `fields`; run after applyWpRules). `before` is the
 * stored row, null on create.
 * - A WP that is not done carries no verification: verified_by/verified_at are cleared.
 * - The rule bites only on a transition: the WP becomes done, or a done WP's verification, verified_by
 *   or verified_at change. Other edits of a done WP (also a legacy unverified one) stay possible.
 * - done with verification != none needs verified_by; it defaults to the caller's person (dashboard
 *   login, MCP OAuth login, service on_behalf_of). No person (a service token without on_behalf_of)
 *   → 409 VERIFICATION_REQUIRED, as is an explicit null.
 * - verified_at defaults to now whenever verified_by gets a new value.
 */
export function applyVerificationRules(before: VerifyState | null, fields: Record<string, unknown>, by: Caller, ts = now()): void {
  // Agents (mcp, service) never lower the verification a person set, in any status (the UPDATE re-checks).
  if (
    isAgent(by) &&
    before &&
    fields.verification !== undefined &&
    verificationRank(fields.verification) < verificationRank(before.verification)
  )
    throw verificationLoweredError(String(before.verification ?? "none"), String(fields.verification));
  const next = String(fields.status ?? before?.status ?? "todo");
  if (next !== "done") {
    fields.verified_by = null;
    fields.verified_at = null;
    return;
  }
  const verification = String(fields.verification ?? before?.verification ?? "none");
  const keep = !!before && before.status === "done" && (before.verification ?? "none") === verification;
  const storedBy = keep ? (before.verified_by ?? null) : null;
  const storedAt = keep ? (before.verified_at ?? null) : null;
  const byGiven = "verified_by" in fields && fields.verified_by !== undefined;
  const atGiven = "verified_at" in fields && fields.verified_at !== undefined;
  const touched = !keep || (byGiven && fields.verified_by !== storedBy) || (atGiven && fields.verified_at !== storedAt);
  if (!touched) return;
  let verifiedBy = byGiven ? ((fields.verified_by as string | null) ?? null) : storedBy;
  if (verification !== "none" && verifiedBy === null && !byGiven) verifiedBy = by.personId ?? null;
  let verifiedAt = atGiven ? ((fields.verified_at as string | null) ?? null) : verifiedBy === storedBy ? storedAt : null;
  if (verifiedBy !== null && verifiedAt === null) verifiedAt = ts;
  if (verifiedBy === null) verifiedAt = null;
  // Agents never rewrite a verification another person recorded (they may reopen the WP, which clears it
  // and stays in the history).
  const prevBy = before?.status === "done" ? (before.verified_by ?? null) : null;
  if (isAgent(by) && prevBy !== null && prevBy !== by.personId && (verifiedBy !== prevBy || verifiedAt !== (before?.verified_at ?? null)))
    throw new ForbiddenError(
      "agents cannot change a verification recorded by another person; that person changes it in the dashboard, or reopen the work package",
    );
  if (verification !== "none" && verifiedBy === null) throw verificationRequiredError(verification);
  fields.verified_by = verifiedBy;
  fields.verified_at = verifiedAt;
}

const VERIFY_GUARD_FAILED = /NOT NULL constraint failed: workpackage\.title/i;

/**
 * Guard statement (put it first in the batch) for a write that may complete WP `wpId` without a
 * verifier: a no-op unless the WP needs verification and has no verifier, else it fails a NOT NULL
 * constraint and D1 rolls the whole batch back. Catches a verification set between read and write.
 */
export const verificationGuardStmt = (db: D1Database, wpId: string): D1PreparedStatement =>
  db
    .prepare("UPDATE workpackage SET title = NULL WHERE id = ? AND status != 'done' AND verification != 'none' AND verified_by IS NULL")
    .bind(wpId);

/** Runs `write`; a failed verificationGuardStmt becomes 409 VERIFICATION_REQUIRED. */
export async function verificationGuarded<T>(db: D1Database, wpId: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (!VERIFY_GUARD_FAILED.test(String((e as Error)?.message ?? e))) throw e;
    const row = await db.prepare("SELECT verification FROM workpackage WHERE id = ?").bind(wpId).first<{ verification: string }>();
    throw verificationRequiredError(row?.verification ?? "set");
  }
}

// ---- follow-up projects

/** Test seam: runs between the reads and the guarded batch of moveWorkpackages. */
let beforeMoveWrite: (() => Promise<void>) | null = null;
export function setBeforeMoveWriteForTesting(f: (() => Promise<void>) | null): void {
  beforeMoveWrite = f;
}

/**
 * Move open work packages (with all their sub-WPs) from one project to a follow-up project, and link the
 * projects (`follows`). WP ids stay the same; context docs of moved WPs and branches linked to them (with
 * their docs) follow. Milestone links of the old project to moved WPs and dependencies that would cross
 * the two projects are removed. All writes happen in one batch, guarded so that a concurrent change to
 * any affected WP makes the whole move a no-op (409).
 */
export async function moveWorkpackages(
  db: D1Database,
  fromProjectId: string,
  toProjectId: string,
  ids: string[],
  by: Caller,
): Promise<{ moved: string[] }> {
  if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some((x) => typeof x !== "string" || !x))
    throw new ValidationError("ids must list 1..200 workpackage ids");
  if (typeof toProjectId !== "string" || !toProjectId) throw new ValidationError("to_project_id is required");
  if (fromProjectId === toProjectId) throw new ValidationError("source and target project are the same");
  const [fromRes, toRes, wpRes] = await db.batch([
    db.prepare(`SELECT id, status FROM project WHERE id = ? AND ${LIVE()}`).bind(fromProjectId),
    db.prepare(`SELECT id, status FROM project WHERE id = ? AND ${LIVE()}`).bind(toProjectId),
    db.prepare("SELECT * FROM workpackage WHERE project_id = ? ORDER BY sort, title").bind(fromProjectId),
  ]);
  const from = fromRes.results[0] as { id: string; status: string } | undefined;
  const to = toRes.results[0] as { id: string; status: string } | undefined;
  if (!from) throw new NotFoundError(`project ${fromProjectId} not found`);
  if (!to) throw new NotFoundError(`project ${toProjectId} not found`);
  if (isClosedProjectStatus(to.status))
    throw new TransitionError(`target project ${to.id} is ${to.status}; choose an open project`, { code: "TARGET_CLOSED" });

  // All rows, trash included: sub-WPs in the trash move with their parent, so a later restore finds it.
  const all = wpRes.results as WorkpackageRow[];
  const byId = new Map(all.map((w) => [w.id, w]));
  const unknown = ids.filter((id) => !byId.has(id) || byId.get(id)!.deleted_at);
  if (unknown.length) throw new ValidationError(`not workpackages of project ${from.id}: ${unknown.join(", ")}`);
  const notOpen = ids.filter((id) => !isOpenWpStatus(byId.get(id)!.status));
  if (notOpen.length)
    throw new ValidationError(
      `only open work packages (${OPEN_WP_STATUSES.join("|")}) can be moved: ${notOpen.map((id) => `${id} (${byId.get(id)!.status})`).join(", ")}`,
    );

  // the given WPs and all their descendants
  const kids = new Map<string, string[]>();
  for (const w of all) if (w.parent_id) kids.set(w.parent_id, [...(kids.get(w.parent_id) ?? []), w.id]);
  const moved = new Set<string>();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    if (moved.has(id)) continue;
    moved.add(id);
    stack.push(...(kids.get(id) ?? []));
  }
  const movedList = all.filter((w) => moved.has(w.id)).map((w) => w.id);

  // dependencies that would cross the two projects after the move, in both directions
  const removedDeps: string[] = [];
  const newDeps = new Map<string, string>();
  for (const w of all) {
    const deps = parseJsonArray(w.depends_on);
    const keep = deps.filter((d) => !byId.has(d) || moved.has(d) === moved.has(w.id));
    if (keep.length === deps.length) continue;
    for (const d of deps) if (!keep.includes(d)) removedDeps.push(`${w.id}->${d}`);
    newDeps.set(w.id, JSON.stringify(keep));
  }
  const movedJson = JSON.stringify(movedList);
  const { results: links } = await db
    .prepare(
      "SELECT l.milestone_id, l.workpackage_id, l.role FROM milestone_link l JOIN milestone m ON m.id = l.milestone_id WHERE m.project_id = ? AND l.workpackage_id IN (SELECT value FROM json_each(?)) ORDER BY l.milestone_id, l.role, l.workpackage_id",
    )
    .bind(from.id, movedJson)
    .all<{ milestone_id: string; workpackage_id: string; role: string }>();
  const removedLinks = links.map((l) => `${l.milestone_id}:${l.role}:${l.workpackage_id}`);

  // Moving drops the old project's milestone links, so an agent moving a gate-locked WP away would lift
  // the lock (spec F5: agents never override). Refused here and re-checked in the batch guard below.
  const agentLock = isAgent(by) && gatesEnforced();
  if (agentLock) {
    const { results: locked } = await db
      .prepare(`SELECT w.id FROM workpackage w JOIN json_each(?) j ON w.id = j.value WHERE ${gateLockedSql("w")} ORDER BY w.id`)
      .bind(movedJson)
      .all<{ id: string }>();
    if (locked.length) throw gateLockedError(locked[0].id, await lockingGates(db, locked[0].id));
  }

  // Guard: every affected WP still has the version read above (rows this batch already wrote carry
  // updated_at = ts and are skipped), the target is still open, and (agents) no moved WP is gate-locked.
  // D1 runs a batch as one transaction, so the guard holds for all statements or for none.
  if (beforeMoveWrite) await beforeMoveWrite();
  const ts = now();
  const versions = JSON.stringify(
    Object.fromEntries(all.filter((w) => moved.has(w.id) || newDeps.has(w.id)).map((w) => [w.id, w.version])),
  );
  const guard = `NOT EXISTS (SELECT 1 FROM workpackage gw JOIN json_each(?) gj ON gw.id = gj.key
      WHERE (gw.version != gj.value OR gw.project_id != ?) AND gw.updated_at != ?)
    AND EXISTS (SELECT 1 FROM project gp WHERE gp.id = ? AND gp.deleted_at IS NULL AND gp.status NOT IN ('done', 'abandoned'))${
      agentLock
        ? ` AND NOT EXISTS (SELECT 1 FROM workpackage lw JOIN json_each(?) lj ON lw.id = lj.value WHERE ${gateLockedSql("lw")})`
        : ""
    }`;
  const g = [versions, from.id, ts, to.id, ...(agentLock ? [movedJson] : [])];

  const act = activitySet(by, ts, false);
  const stmts: D1PreparedStatement[] = [];
  for (const [id, deps] of newDeps)
    if (!moved.has(id))
      stmts.push(
        db
          .prepare(`UPDATE workpackage SET depends_on = ?, version = version + 1, updated_at = ?${act.sql} WHERE id = ? AND ${guard}`)
          .bind(deps, ts, ...act.params, id, ...g),
      );
  const firstMove = stmts.length;
  for (const id of movedList) {
    const w = byId.get(id)!;
    stmts.push(
      db
        .prepare(
          `UPDATE workpackage SET project_id = ?, parent_id = ?, depends_on = ?, version = version + 1, updated_at = ?${act.sql} WHERE id = ? AND ${guard}`,
        )
        .bind(
          to.id,
          w.parent_id && moved.has(w.parent_id) ? w.parent_id : null,
          newDeps.get(id) ?? w.depends_on,
          ts,
          ...act.params,
          id,
          ...g,
        ),
    );
  }
  const inMoved = "(SELECT value FROM json_each(?))";
  stmts.push(
    db
      .prepare(
        `DELETE FROM milestone_link WHERE workpackage_id IN ${inMoved} AND milestone_id IN (SELECT id FROM milestone WHERE project_id = ?) AND ${guard}`,
      )
      .bind(movedJson, from.id, ...g),
    db
      .prepare(
        `UPDATE milestone SET workpackage_id = NULL, version = version + 1, updated_at = ? WHERE project_id = ? AND workpackage_id IN ${inMoved} AND ${guard}`,
      )
      .bind(ts, from.id, movedJson, ...g),
    db
      .prepare(
        `UPDATE context_doc SET project_id = ? WHERE ((owner_kind = 'workpackage' AND owner_id IN ${inMoved})
          OR (owner_kind = 'branch' AND owner_id IN (SELECT id FROM branch WHERE workpackage_id IN ${inMoved}))) AND ${guard}`,
      )
      .bind(to.id, movedJson, movedJson, ...g),
    db.prepare(`UPDATE branch SET project_id = ? WHERE workpackage_id IN ${inMoved} AND ${guard}`).bind(to.id, movedJson, ...g),
    db
      .prepare(
        `INSERT OR IGNORE INTO project_link (from_project_id, to_project_id, kind, created_at) SELECT ?, ?, 'follows', ? WHERE ${guard}`,
      )
      .bind(to.id, from.id, ts, ...g),
    db.prepare(`UPDATE project SET updated_at = ?${act.sql} WHERE id IN (?, ?) AND ${guard}`).bind(ts, ...act.params, from.id, to.id, ...g),
  );
  const removed: Diff = {};
  if (removedLinks.length) removed.removed_milestone_links = [removedLinks, null];
  if (removedDeps.length) removed.removed_dependencies = [removedDeps, null];
  const n = movedList.length;
  const label = `${n} work package${n === 1 ? "" : "s"}`;
  stmts.push(
    eventStmtWhere(
      db,
      {
        by,
        project_id: from.id,
        entity: "project",
        entity_id: from.id,
        action: "move_workpackages",
        summary: `moved ${label} to follow-up project ${to.id}`,
        diff: { moved_workpackages: [null, movedList], to_project: [null, to.id], ...removed },
      },
      guard,
      g,
    ),
    eventStmtWhere(
      db,
      {
        by,
        project_id: to.id,
        entity: "project",
        entity_id: to.id,
        action: "move_workpackages",
        summary: `received ${label} from ${from.id}`,
        diff: { moved_workpackages: [null, movedList], from_project: [null, from.id], ...removed },
      },
      guard,
      g,
    ),
    ...reachStmts(db, from.id, by),
    ...reachStmts(db, to.id, by),
  );
  // Removed dependencies and milestone links change the schedule of both projects (spec F4): stored in
  // the same batch, never refused by strict mode.
  const live = (id: string) => !byId.get(id)!.deleted_at;
  const snap = (id: string, parent: string | null) => {
    const w = byId.get(id)!;
    return {
      id,
      parent_id: parent,
      start_date: w.start_date,
      end_date: w.end_date,
      depends_on: storedDependsOn(newDeps.get(id) ?? w.depends_on),
    };
  };
  const fromSchedule = await recomputeScheduleStmts(db, from.id, {
    removeWps: movedList,
    wps: [...newDeps.keys()].filter((id) => !moved.has(id) && live(id)).map((id) => snap(id, byId.get(id)!.parent_id)),
    strict: false,
  });
  const toSchedule = await recomputeScheduleStmts(db, to.id, {
    wps: movedList.filter(live).map((id) => {
      const p = byId.get(id)!.parent_id;
      return snap(id, p && moved.has(p) ? p : null);
    }),
    strict: false,
  });
  stmts.push(...fromSchedule.stmts, ...toSchedule.stmts);
  const res = await scheduleBatch(db, stmts);
  const changed = res.slice(firstMove, firstMove + n).reduce((s, r) => s + (r.meta.changes ?? 0), 0);
  if (changed !== n) {
    // The guarded writes did nothing; put back the stored issues of both unchanged plans.
    await storeSchedule(db, from.id);
    await storeSchedule(db, to.id);
    throw new ConflictError("work packages or the target project changed meanwhile; nothing was moved", null);
  }
  return { moved: movedList };
}
