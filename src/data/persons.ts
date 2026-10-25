import type { Caller, PersonRow, Role } from "../types";
import { POLICY } from "../policy";
import { isAgent } from "../auth/caller";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  diffFields,
  eventStmt,
  eventStmtIfChanged,
  newId,
  now,
} from "./util";

export const ROLES: readonly Role[] = ["viewer", "editor", "decider", "admin"];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Writable person fields. */
export const PERSON_FIELDS = [
  "name",
  "display_name",
  "company",
  "email",
  "phone",
  "contact_note",
  "internal",
  "function",
  "comment",
  "access_role",
  "locale",
] as const;
type PersonField = (typeof PERSON_FIELDS)[number];
/** Fields that may appear in event diffs (and so in the audit export). Contact data and comments never do (spec §4.1). */
const EVENT_FIELDS = ["name", "display_name", "company", "internal", "function", "access_role", "locale"] as const;

export type PersonRef = { person_id: string | null; text: string | null };

const roleFor = (email: string): Role => (POLICY.admins.includes(email) ? "admin" : POLICY.default_role);

export async function getPerson(db: D1Database, id: string): Promise<PersonRow> {
  const p = await db.prepare("SELECT * FROM person WHERE id = ?").bind(id).first<PersonRow>();
  if (!p) throw new NotFoundError(`person ${id} not found`);
  return p;
}

/** Person with this email (case-insensitive), live rows first. */
async function findByEmail(db: D1Database, email: string): Promise<PersonRow | null> {
  return db
    .prepare("SELECT * FROM person WHERE email IS NOT NULL AND lower(email) = ? ORDER BY deleted_at IS NOT NULL LIMIT 1")
    .bind(email.trim().toLowerCase())
    .first<PersonRow>();
}

/**
 * The person behind an allow-listed login email, created on first use (spec §4.1): name = local part,
 * internal, role admin when listed in policy.admins, else policy.default_role. A stakeholder row with the
 * same email becomes the user; if it has no access role yet it gets one now.
 */
export async function ensureUserPerson(db: D1Database, email: string): Promise<PersonRow> {
  const addr = email.trim().toLowerCase();
  let p = await findByEmail(db, addr);
  if (!p) {
    const ts = now();
    const id = newId();
    const name = addr.split("@")[0] || addr;
    const role = roleFor(addr);
    // Concurrent first requests: the unique email index lets exactly one INSERT win; the event follows only that one.
    await db.batch([
      db
        .prepare(
          "INSERT INTO person (id, name, email, internal, access_role, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, ?, ?) ON CONFLICT DO NOTHING",
        )
        .bind(id, name, addr, role, ts, ts),
      eventStmtIfChanged(db, {
        by: { actor: `user:${addr}`, personId: id, role, channel: "dashboard" },
        project_id: null,
        entity: "person",
        entity_id: id,
        action: "create",
        summary: `${name} (first login)`,
        diff: { name: [null, name], internal: [null, 1], access_role: [null, role] },
      }),
    ]);
    p = await findByEmail(db, addr);
    if (!p) throw new Error(`person for ${addr} could not be created`);
    return p;
  }
  if (p.access_role === null) {
    const role = roleFor(addr);
    await db.batch([
      db
        .prepare("UPDATE person SET access_role = ?, version = version + 1, updated_at = ? WHERE id = ? AND access_role IS NULL")
        .bind(role, now(), p.id),
      eventStmtIfChanged(db, {
        by: { actor: `user:${addr}`, personId: p.id, role, channel: "dashboard" },
        project_id: null,
        entity: "person",
        entity_id: p.id,
        action: "update",
        summary: `${p.name}: access_role (first login)`,
        diff: { access_role: [null, role] },
      }),
    ]);
    p = await getPerson(db, p.id);
  }
  return p;
}

/**
 * A person reference from an API field: person id → email → exact name (case-insensitive) → free text.
 * An ambiguous name stays text, so nothing is attributed to the wrong person. Deleted persons do not match.
 */
export async function resolvePersonRef(db: D1Database, ref: string | null | undefined): Promise<PersonRef> {
  const v = typeof ref === "string" ? ref.trim() : "";
  if (!v) return { person_id: null, text: null };
  const byId = await db.prepare("SELECT id FROM person WHERE id = ? AND deleted_at IS NULL").bind(v).first<{ id: string }>();
  if (byId) return { person_id: byId.id, text: null };
  if (v.includes("@")) {
    const byEmail = await db
      .prepare("SELECT id FROM person WHERE email IS NOT NULL AND lower(email) = ? AND deleted_at IS NULL")
      .bind(v.toLowerCase())
      .first<{ id: string }>();
    if (byEmail) return { person_id: byEmail.id, text: null };
  }
  const { results } = await db
    .prepare("SELECT id FROM person WHERE lower(name) = lower(?) AND deleted_at IS NULL LIMIT 2")
    .bind(v)
    .all<{ id: string }>();
  if (results.length === 1) return { person_id: results[0].id, text: null };
  return { person_id: null, text: v };
}

const optStr = (v: unknown, field: string, max: number): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new ValidationError(`${field} must be text`);
  const s = v.trim();
  if (s.length > max) throw new ValidationError(`${field} is longer than ${max} characters`);
  return s || null;
};

function normalise(input: Record<string, unknown>): Partial<Record<PersonField, unknown>> {
  const out: Partial<Record<PersonField, unknown>> = {};
  for (const f of PERSON_FIELDS) {
    if (!(f in input) || input[f] === undefined) continue;
    const v = input[f];
    switch (f) {
      case "name": {
        const s = optStr(v, "name", 200);
        if (!s) throw new ValidationError("name is required");
        out.name = s;
        break;
      }
      case "email": {
        const s = optStr(v, "email", 254)?.toLowerCase() ?? null;
        if (s && !EMAIL_RE.test(s)) throw new ValidationError("email must look like name@example.com");
        out.email = s;
        break;
      }
      case "internal":
        if (typeof v !== "boolean" && v !== 0 && v !== 1) throw new ValidationError("internal must be true or false");
        out.internal = v ? 1 : 0;
        break;
      case "access_role":
        if (v !== null && !ROLES.includes(v as Role)) throw new ValidationError(`access_role must be one of ${ROLES.join("|")} or null`);
        out.access_role = v;
        break;
      case "locale":
        out.locale = optStr(v, "locale", 10);
        break;
      default:
        out[f] = optStr(v, f, f === "comment" || f === "contact_note" ? 2000 : 200);
    }
  }
  return out;
}

async function checkEmailFree(db: D1Database, email: unknown, selfId: string | null): Promise<void> {
  if (typeof email !== "string" || !email) return;
  const other = await findByEmail(db, email);
  if (other && other.id !== selfId) throw new ConflictError(`email ${email} already belongs to another person`, { person_id: other.id });
}

/**
 * Create a person, or update the one named by input.id. undefined keeps a field, null clears it.
 * Agents (MCP, service tokens) never change access roles; role checks per §4.2 arrive with R5.
 */
export async function upsertPerson(
  db: D1Database,
  input: Record<string, unknown> & { id?: string },
  by: Caller,
  expectedVersion?: number,
): Promise<PersonRow> {
  const fields = normalise(input);
  const existing = input.id ? await getPerson(db, String(input.id)) : null;
  const roleChange = "access_role" in fields && (fields.access_role ?? null) !== (existing?.access_role ?? null);
  if (roleChange && isAgent(by)) throw new ForbiddenError("agents cannot change access roles");

  if (existing) {
    if (typeof expectedVersion === "number" && expectedVersion !== existing.version) throw new ConflictError("version conflict", existing);
    if ("email" in fields) await checkEmailFree(db, fields.email, existing.id);
    const next = { ...existing, ...fields } as Record<string, unknown>;
    const diff = diffFields(existing as unknown as Record<string, unknown>, next, PERSON_FIELDS);
    const changed = Object.keys(diff);
    if (!changed.length) return existing;
    const res = await db.batch([
      db
        .prepare(
          `UPDATE person SET ${changed.map((f) => `${f} = ?`).join(", ")}, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
        )
        .bind(...changed.map((f) => next[f] ?? null), now(), existing.id, existing.version),
      eventStmtIfChanged(db, {
        by,
        project_id: null,
        entity: "person",
        entity_id: existing.id,
        action: "update",
        summary: `${String(next.name)}: ${changed.join(", ")}`,
        diff: diffFields(existing as unknown as Record<string, unknown>, next, EVENT_FIELDS),
      }),
    ]);
    if (!res[0].meta.changes) throw new ConflictError("version conflict", await getPerson(db, existing.id));
    return getPerson(db, existing.id);
  }

  if (input.id !== undefined) throw new NotFoundError(`person ${String(input.id)} not found`);
  if (!fields.name) throw new ValidationError("name is required");
  await checkEmailFree(db, fields.email, null);
  const ts = now();
  const row: Record<string, unknown> = {
    id: newId(),
    internal: 0,
    ...fields,
    version: 1,
    created_at: ts,
    updated_at: ts,
  };
  const cols = ["id", ...PERSON_FIELDS, "version", "created_at", "updated_at"] as const;
  try {
    await db.batch([
      db
        .prepare(`INSERT INTO person (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
        .bind(...cols.map((c) => row[c] ?? null)),
      eventStmt(db, {
        by,
        project_id: null,
        entity: "person",
        entity_id: String(row.id),
        action: "create",
        summary: String(row.name),
        diff: diffFields(null, row, EVENT_FIELDS),
      }),
    ]);
  } catch (e) {
    // Lost a race on the unique email index.
    if (/UNIQUE/i.test(String((e as Error)?.message)))
      throw new ConflictError(`email ${String(fields.email)} already belongs to another person`, null);
    throw e;
  }
  return getPerson(db, String(row.id));
}

export async function listPersons(db: D1Database, opts: { users_only?: boolean; include_deleted?: boolean } = {}): Promise<PersonRow[]> {
  const where: string[] = [];
  if (!opts.include_deleted) where.push("deleted_at IS NULL");
  if (opts.users_only) where.push("access_role IS NOT NULL AND email IS NOT NULL");
  const { results } = await db
    .prepare(`SELECT * FROM person${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY name COLLATE NOCASE, id`)
    .all<PersonRow>();
  return results;
}

/**
 * Initials for chips: a short display_name (up to 3 letters, one word) is used as is; otherwise the first
 * letters of the first and last word of display_name or name ("Jane Doe" → "JD", "new" → "N").
 */
export function initials(p: Pick<PersonRow, "name" | "display_name">): string {
  const dn = p.display_name?.trim();
  if (dn && /^\p{L}{1,3}$/u.test(dn)) return dn.toUpperCase();
  const words = (dn || p.name || "")
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean);
  if (!words.length) return "?";
  const first = [...words[0]][0];
  const last = words.length > 1 ? [...words[words.length - 1]][0] : "";
  return (first + last).toUpperCase();
}
