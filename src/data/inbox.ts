/**
 * Inbox triage: unassigned hook and webhook events (`event.project_id IS NULL`), their states and folder rules.
 *
 * States by `event.action`: `unmatched` (to review, counted in the badge), `dismissed` (by a person), `ignored`
 * (by an ignore rule), `assigned` (has a project). Dismiss and restore change `action` only; nothing is deleted.
 * Each write adds one audit event (entity `inbox`, no project). Folder rules apply to hook events only.
 */
import type { Caller, EventOut } from "../types";
import { normalisePath } from "../api/match";
import { ConflictError, LIVE, NotFoundError, ValidationError, eventStmt, newId, now } from "./util";

export type InboxState = "open" | "dismissed";
export type InboxRuleKind = "ignore" | "assign";

export interface InboxRuleRow {
  id: string;
  kind: InboxRuleKind;
  path: string;
  project_id: string | null;
  created_at: string;
  created_by: string;
}
export interface InboxRuleOut extends InboxRuleRow {
  project_title: string | null;
}

/** Max ids per dismiss or restore request. */
export const INBOX_IDS_MAX = 200;
/** D1 binds at most 100 parameters per statement: id lists are written in chunks of this size. */
const CHUNK = 100;
const PATH_MAX = 500;

const STATE_ACTIONS: Record<InboxState, string> = {
  open: "('unmatched')",
  dismissed: "('dismissed', 'ignored')",
};

function chunks<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}
const marks = (n: number): string => Array(n).fill("?").join(", ");

/** Inbox events, newest first. `dismissed` gives both dismissed and ignored rows. */
export async function listInbox(db: D1Database, opts: { state?: string; limit?: number } = {}): Promise<EventOut[]> {
  const state = opts.state ?? "open";
  if (state !== "open" && state !== "dismissed") throw new ValidationError("state must be open or dismissed");
  const raw = Math.trunc(opts.limit ?? 100);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 500) : 100;
  const { results } = await db
    .prepare(
      `SELECT e.*, p.name AS person_name FROM event e LEFT JOIN person p ON p.id = e.person_id WHERE e.project_id IS NULL AND e.action IN ${STATE_ACTIONS[state]} ORDER BY e.id DESC LIMIT ?`,
    )
    .bind(limit)
    .all<EventOut>();
  return results;
}

/** Number of events to review (`unmatched`), without a cap. */
export async function countInbox(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM event WHERE project_id IS NULL AND action = 'unmatched'")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Validated id list: 1..INBOX_IDS_MAX positive integers; duplicates counted once. */
function parseIds(v: unknown): number[] {
  if (!Array.isArray(v) || v.length === 0) throw new ValidationError("ids must be a non-empty array");
  if (v.length > INBOX_IDS_MAX) throw new ValidationError(`at most ${INBOX_IDS_MAX} ids per request`);
  for (const x of v) if (typeof x !== "number" || !Number.isInteger(x) || x < 1) throw new ValidationError("ids must be positive integers");
  return [...new Set(v as number[])];
}

/** Moves the given inbox events from one set of actions to another; one batch with its audit event. */
async function moveState(
  db: D1Database,
  rawIds: unknown,
  from: string[],
  to: string,
  audit: { action: string; verb: string },
  by: Caller,
): Promise<number> {
  const ids = parseIds(rawIds);
  const fromSql = `(${marks(from.length)})`;
  const found: number[] = [];
  for (const part of chunks(ids)) {
    const { results } = await db
      .prepare(`SELECT id FROM event WHERE project_id IS NULL AND action IN ${fromSql} AND id IN (${marks(part.length)})`)
      .bind(...from, ...part)
      .all<{ id: number }>();
    for (const r of results) found.push(r.id);
  }
  if (!found.length) return 0;
  found.sort((a, b) => a - b);
  const updates = chunks(found).map((part) =>
    db
      .prepare(`UPDATE event SET action = ? WHERE project_id IS NULL AND action IN ${fromSql} AND id IN (${marks(part.length)})`)
      .bind(to, ...from, ...part),
  );
  const res = await db.batch([
    ...updates,
    eventStmt(db, {
      by,
      project_id: null,
      entity: "inbox",
      entity_id: null,
      action: audit.action,
      summary: `${found.length} inbox event${found.length === 1 ? "" : "s"} ${audit.verb}`,
      diff: { ids: [null, found] },
    }),
  ]);
  return res.slice(0, updates.length).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

/** Dismisses events that are `unmatched`; others are skipped. Returns the number dismissed. */
export function dismissInbox(db: D1Database, ids: unknown, by: Caller): Promise<number> {
  return moveState(db, ids, ["unmatched"], "dismissed", { action: "dismiss", verb: "dismissed" }, by);
}

/** Restores dismissed or ignored events to `unmatched`. Returns the number restored. */
export function restoreInbox(db: D1Database, ids: unknown, by: Caller): Promise<number> {
  return moveState(db, ids, ["dismissed", "ignored"], "unmatched", { action: "restore", verb: "restored" }, by);
}

export async function listRules(db: D1Database): Promise<InboxRuleOut[]> {
  const { results } = await db
    .prepare(
      "SELECT r.*, p.title AS project_title FROM inbox_rule r LEFT JOIN project p ON p.id = r.project_id ORDER BY r.path, r.id",
    )
    .all<InboxRuleOut>();
  return results;
}

/** Absolute in normalised form: `/x…`, `//host/…` or `x:/…` (a bare drive or `/` is refused as too broad). */
const ABSOLUTE = /^(\/[^/]|\/\/[^/]|[a-z]:\/.)/;

/** Whether normalised `cwd` is the rule folder or below it (not a sibling with a common prefix). */
const covers = (path: string, cwd: string): boolean => cwd === path || cwd.startsWith(`${path}/`);

/**
 * Creates a folder rule. With `apply_existing` (default true) it also applies to the `unmatched` hook events whose
 * cwd is the folder or below: ignore → `ignored`, assign → `assigned` on the project. Past events are not replayed.
 */
export async function createRule(
  db: D1Database,
  input: Record<string, unknown>,
  by: Caller,
): Promise<{ rule: InboxRuleOut; applied: number }> {
  const kind = input.kind;
  if (kind !== "ignore" && kind !== "assign") throw new ValidationError("kind must be ignore or assign");
  if (typeof input.path !== "string") throw new ValidationError("path is required");
  if (input.path.length > PATH_MAX) throw new ValidationError(`path is longer than ${PATH_MAX} characters`);
  const path = normalisePath(input.path);
  if (!path) throw new ValidationError("path is required");
  if (!ABSOLUTE.test(path)) throw new ValidationError("path must be an absolute folder");
  const applyExisting = input.apply_existing ?? true;
  if (typeof applyExisting !== "boolean") throw new ValidationError("apply_existing must be true or false");
  let projectId: string | null = null;
  let projectTitle: string | null = null;
  if (kind === "assign") {
    if (typeof input.project_id !== "string" || !input.project_id.trim()) throw new ValidationError("project_id is required for assign");
    const p = await db.prepare(`SELECT id, title FROM project WHERE id = ? AND ${LIVE()}`).bind(input.project_id).first<{ id: string; title: string }>();
    if (!p) throw new NotFoundError(`project ${input.project_id} not found`);
    projectId = p.id;
    projectTitle = p.title;
  } else if (input.project_id !== undefined && input.project_id !== null && input.project_id !== "") {
    throw new ValidationError("an ignore rule takes no project_id");
  }
  const existing = await db.prepare("SELECT * FROM inbox_rule WHERE path = ?").bind(path).first<InboxRuleRow>();
  if (existing) throw new ConflictError(`a rule for ${path} already exists (${existing.id})`, existing);

  const ids: number[] = [];
  if (applyExisting) {
    const { results } = await db
      .prepare(
        "SELECT id, CASE WHEN json_valid(diff_json) THEN json_extract(diff_json, '$.hook[1].cwd') END AS cwd FROM event WHERE project_id IS NULL AND action = 'unmatched' AND entity = 'hook'",
      )
      .all<{ id: number; cwd: unknown }>();
    for (const r of results) {
      const c = typeof r.cwd === "string" ? normalisePath(r.cwd) : null;
      if (c && covers(path, c)) ids.push(r.id);
    }
  }

  const rule: InboxRuleRow = { id: newId(), kind, path, project_id: projectId, created_at: now(), created_by: by.actor };
  const updates = chunks(ids).map((part) =>
    kind === "ignore"
      ? db
          .prepare(`UPDATE event SET action = 'ignored' WHERE project_id IS NULL AND action = 'unmatched' AND id IN (${marks(part.length)})`)
          .bind(...part)
      : db
          .prepare(
            `UPDATE event SET project_id = ?, action = 'assigned' WHERE project_id IS NULL AND action = 'unmatched' AND id IN (${marks(part.length)})`,
          )
          .bind(projectId, ...part),
  );
  let res: D1Result[];
  try {
    res = await db.batch([
      db
        .prepare("INSERT INTO inbox_rule (id, kind, path, project_id, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(rule.id, rule.kind, rule.path, rule.project_id, rule.created_at, rule.created_by),
      ...updates,
      eventStmt(db, {
        by,
        project_id: null,
        entity: "inbox",
        entity_id: rule.id,
        action: "rule_create",
        summary: `inbox rule created: ${kind} ${path}${projectId ? ` → ${projectId}` : ""}`,
        // The folder sits under local_path so that viewers' event reads drop it (spec F12).
        diff: { rule: [null, { id: rule.id, kind, local_path: path, project_id: projectId }], ...(ids.length ? { ids: [null, ids] } : {}) },
      }),
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String((e as Error)?.message ?? e))) {
      const taken = await db.prepare("SELECT * FROM inbox_rule WHERE path = ?").bind(path).first<InboxRuleRow>();
      throw new ConflictError(`a rule for ${path} already exists${taken ? ` (${taken.id})` : ""}`, taken);
    }
    throw e;
  }
  const applied = res.slice(1, 1 + updates.length).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  return { rule: { ...rule, project_title: projectTitle }, applied };
}

/** Hard delete (rules are configuration, not tracker data) with an audit event. */
export async function deleteRule(db: D1Database, id: string, by: Caller): Promise<void> {
  const rule = await db.prepare("SELECT * FROM inbox_rule WHERE id = ?").bind(id).first<InboxRuleRow>();
  if (!rule) throw new NotFoundError(`inbox rule ${id} not found`);
  await db.batch([
    db.prepare("DELETE FROM inbox_rule WHERE id = ?").bind(id),
    eventStmt(db, {
      by,
      project_id: null,
      entity: "inbox",
      entity_id: id,
      action: "rule_delete",
      summary: `inbox rule deleted: ${rule.kind} ${rule.path}`,
      diff: { rule: [{ id, kind: rule.kind, local_path: rule.path, project_id: rule.project_id }, null] },
    }),
  ]);
}

/** The rule whose folder equals `cwd` or contains it, longest folder first (same walk as findProjectByPath). */
export async function findRule(db: D1Database, cwd: string | null | undefined): Promise<InboxRuleRow | null> {
  const want = normalisePath(cwd);
  if (!want) return null;
  const { results } = await db.prepare("SELECT * FROM inbox_rule").all<InboxRuleRow>();
  let best: InboxRuleRow | null = null;
  for (const r of results) if (covers(r.path, want) && (!best || r.path.length > best.path.length)) best = r;
  return best;
}
