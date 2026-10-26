// Activity timestamps and staleness (spec F8). utcDayNumber, isStale and staleDaysFor were drafted by Copilot.
import type { Caller } from "../types";
import { INSTANCE } from "../generated/instance";
import { POLICY } from "../policy";

/**
 * Parses an ISO date-only string or ISO timestamp and returns the whole number
 * of days since 1970-01-01 for its UTC calendar date.
 * @throws {Error} Error("invalid date") if the input is invalid.
 */
export function utcDayNumber(s: string): number {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);

  if (dateOnly !== null) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);

    if (month < 1 || month > 12 || day < 1 || day > 31) {
      throw new Error("invalid date");
    }

    const ms = Date.UTC(year, month - 1, day);
    const date = new Date(ms);

    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      throw new Error("invalid date");
    }

    return Math.floor(ms / 86_400_000);
  }

  if (!/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) {
    throw new Error("invalid date");
  }

  // SQLite-style "YYYY-MM-DD HH:MM:SS" (no offset) is UTC.
  const iso = s.replace(" ", "T");
  const ms = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`);
  if (!Number.isFinite(ms)) {
    throw new Error("invalid date");
  }

  const date = new Date(ms);
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86_400_000);
}

/** True only if p is an active item whose last progress is more than staleDays UTC calendar days before now. */
export function isStale(p: { status: string; last_progress_at: string | null; created_at: string }, staleDays: number, now: Date): boolean {
  if (p.status !== "active") return false;
  let referenceDay: number | null = null;
  for (const s of [p.last_progress_at, p.created_at]) {
    if (s == null) continue;
    try {
      referenceDay = utcDayNumber(s);
      break;
    } catch {
      // try the next candidate
    }
  }
  // Nothing parsable: not stale (never break a listing over a malformed timestamp).
  if (referenceDay === null) return false;
  return utcDayNumber(now.toISOString()) - referenceDay > staleDays;
}

/** The category's positive-integer stale_days, else defaultDays. */
export function staleDaysFor(
  category: string | null,
  categories: ReadonlyArray<{ key: string; stale_days?: number }>,
  defaultDays: number,
): number {
  if (category === null) return defaultDays;
  const value = categories.find(({ key }) => key === category)?.stale_days;
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : defaultDays;
}

/** Stale flag of a project row: policy stale_days with the project category's override. */
export function projectStale(p: { status: string; category: string | null; last_progress_at: string | null; created_at: string }): boolean {
  return isStale(p, staleDaysFor(p.category, INSTANCE.categories.project, POLICY.stale_days), new Date());
}

/** System writes (migrations, scheduled jobs) update no activity data. */
export const isSystem = (by: Caller): boolean => by.channel === "system";

/** SET fragment (after `updated_at = ?`) and its params: last_changed_at always, last_progress_at for progress writes. */
export function activitySet(by: Caller, ts: string, progress: boolean): { sql: string; params: string[] } {
  if (isSystem(by)) return { sql: "", params: [] };
  return progress
    ? { sql: ", last_changed_at = ?, last_progress_at = ?", params: [ts, ts] }
    : { sql: ", last_changed_at = ?", params: [ts] };
}

/** Touches the project's activity columns; put it in the same batch as the write. Null for system callers. */
export function projectActivityStmt(
  db: D1Database,
  by: Caller,
  projectId: string,
  ts: string,
  progress: boolean,
  ifChanged = false,
): D1PreparedStatement | null {
  if (isSystem(by)) return null;
  const a = activitySet(by, ts, progress);
  // ifChanged: place directly after an eventStmtIfChanged; changes() is then 1 only if the main write applied.
  return db
    .prepare(`UPDATE project SET ${a.sql.slice(2)} WHERE id = ?${ifChanged ? " AND changes() > 0" : ""}`)
    .bind(...a.params, projectId);
}

/** projectActivityStmt as a spreadable list (empty for system callers); a plain write counts as a change, not progress. */
export function touchProject(
  db: D1Database,
  by: Caller,
  projectId: string,
  ts: string,
  progress = false,
  ifChanged = false,
): D1PreparedStatement[] {
  const s = projectActivityStmt(db, by, projectId, ts, progress, ifChanged);
  return s ? [s] : [];
}
