import type { Caller } from "../types";

/** Typed errors; REST maps them to HTTP codes, MCP to tool errors. */
export class NotFoundError extends Error {
  readonly status = 404;
}
export class ValidationError extends Error {
  readonly status = 400;
}
export class TooLargeError extends Error {
  readonly status = 413;
}
export class ForbiddenError extends Error {
  readonly status = 403;
}
export class ConflictError extends Error {
  readonly status = 409;
  constructor(
    message: string,
    readonly current: unknown,
  ) {
    super(message);
  }
}

export const now = (): string => new Date().toISOString();

/**
 * SQL condition "row is not in the trash" (spec F10) for project, workpackage, milestone, context_doc and
 * person rows; `alias` is the table alias, if the query uses one. Every read of those tables carries it.
 */
export const LIVE = (alias?: string): string => `${alias ? `${alias}.` : ""}deleted_at IS NULL`;
export const newId = (): string => crypto.randomUUID();

/** Lower-case ASCII slug: umlauts transliterated, non [a-z0-9] → "-", trimmed, max 60 chars. */
export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    // strip combining diacritical marks (string escape so formatters keep it readable)
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s || "item";
}

export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

export type Diff = Record<string, [unknown, unknown]>;

/** Field-level diff over `fields`: only keys whose value changed. `before` null = create. */
export function diffFields(before: Record<string, unknown> | null, after: Record<string, unknown>, fields: readonly string[]): Diff {
  const d: Diff = {};
  for (const f of fields) {
    const a = before ? (before[f] ?? null) : null;
    const b = after[f] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) d[f] = [a, b];
  }
  return d;
}

export interface EventInput {
  by: Caller;
  project_id: string | null;
  entity: string;
  entity_id: string | null;
  action: string;
  summary?: string | null;
  diff?: Diff | null;
}

/** Prepared INSERT for the event table (actor + person_id from the caller); put it in the same db.batch() as the mutation. */
export function eventStmt(db: D1Database, e: EventInput): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO event (ts, actor, person_id, project_id, entity, entity_id, action, summary, diff_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      now(),
      e.by.actor,
      e.by.personId,
      e.project_id,
      e.entity,
      e.entity_id,
      e.action,
      e.summary ?? null,
      e.diff && Object.keys(e.diff).length ? JSON.stringify(e.diff) : null,
    );
}

/**
 * Like eventStmt, but only inserts if the directly preceding statement in the batch changed rows
 * (SQLite changes()). Use after a versioned UPDATE so a lost race leaves no phantom event.
 */
export function eventStmtIfChanged(db: D1Database, e: EventInput): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO event (ts, actor, person_id, project_id, entity, entity_id, action, summary, diff_json) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0",
    )
    .bind(
      now(),
      e.by.actor,
      e.by.personId,
      e.project_id,
      e.entity,
      e.entity_id,
      e.action,
      e.summary ?? null,
      e.diff && Object.keys(e.diff).length ? JSON.stringify(e.diff) : null,
    );
}

/** Like eventStmt, but only inserts while the SQL condition `where` (with its bound `params`) holds. */
export function eventStmtWhere(db: D1Database, e: EventInput, where: string, params: unknown[]): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO event (ts, actor, person_id, project_id, entity, entity_id, action, summary, diff_json) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${where}`,
    )
    .bind(
      now(),
      e.by.actor,
      e.by.personId,
      e.project_id,
      e.entity,
      e.entity_id,
      e.action,
      e.summary ?? null,
      e.diff && Object.keys(e.diff).length ? JSON.stringify(e.diff) : null,
      ...params,
    );
}

/** JSON-array TEXT column helpers. */
export const toJsonArray = (v: unknown): string | null => (Array.isArray(v) ? JSON.stringify(v) : v == null ? null : String(v));
export function parseJsonArray(v: string | null): string[] {
  if (!v) return [];
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}
