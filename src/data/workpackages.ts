import type { WorkpackageRow } from "../types";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  diffFields,
  eventStmt,
  eventStmtIfChanged,
  now,
  slugify,
  toJsonArray,
} from "./util";
import { WP_CATEGORIES, checkCategory, checkHuman } from "./categories";
import { reachStmts } from "./milestones";

export const WP_FIELDS = [
  "parent_id",
  "title",
  "description_md",
  "status",
  "blocked_by",
  "progress",
  "weight",
  "start_date",
  "end_date",
  "depends_on",
  "sort",
  "category",
  "human",
] as const;
type WpField = (typeof WP_FIELDS)[number];

const STATUSES = ["todo", "doing", "blocked", "waiting", "done", "dropped"];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function listWorkpackages(db: D1Database, projectId: string): Promise<WorkpackageRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM workpackage WHERE project_id = ? ORDER BY sort, title")
    .bind(projectId)
    .all<WorkpackageRow>();
  return results;
}

async function getWp(db: D1Database, id: string): Promise<WorkpackageRow | null> {
  return db.prepare("SELECT * FROM workpackage WHERE id = ?").bind(id).first<WorkpackageRow>();
}

function normalise(input: Record<string, unknown>): Partial<Record<WpField, unknown>> {
  const out: Partial<Record<WpField, unknown>> = {};
  for (const f of WP_FIELDS) {
    if (!(f in input) || input[f] === undefined) continue;
    let v = input[f];
    switch (f) {
      case "title":
        if (typeof v !== "string" || !v.trim()) throw new ValidationError("title is required");
        v = v.trim();
        break;
      case "status":
        if (!STATUSES.includes(String(v))) throw new ValidationError(`status must be one of ${STATUSES.join("|")}`);
        break;
      case "progress":
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) throw new ValidationError("progress must be 0..100");
        break;
      case "weight":
        if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new ValidationError("weight must be greater than 0");
        break;
      case "sort":
        if (typeof v !== "number" || !Number.isFinite(v)) throw new ValidationError("sort must be a number");
        v = Math.trunc(v);
        break;
      case "depends_on":
        v = toJsonArray(v);
        break;
      case "category":
        v = checkCategory(v, WP_CATEGORIES);
        break;
      case "human":
        v = checkHuman(v);
        break;
      case "start_date":
      case "end_date":
        if (v === "") v = null;
        if (v !== null && !DATE_RE.test(String(v))) throw new ValidationError(`${f} must be YYYY-MM-DD`);
        break;
      default:
        if (v !== null && typeof v !== "string") throw new ValidationError(`${f} must be a string`);
    }
    out[f] = v;
  }
  return out;
}

/** parent must be a WP of the same project and not the node itself or one of its descendants. */
async function checkParent(db: D1Database, projectId: string, selfId: string | null, parentId: unknown): Promise<void> {
  if (parentId === null || parentId === undefined) return;
  const all = await listWorkpackages(db, projectId);
  const byId = new Map(all.map((w) => [w.id, w]));
  if (!byId.has(String(parentId))) throw new ValidationError(`parent ${String(parentId)} is not a workpackage of project ${projectId}`);
  let cur: string | null = String(parentId);
  for (let depth = 0; cur && depth < 100; depth++) {
    if (cur === selfId) throw new ValidationError("cycle: a workpackage cannot be its own ancestor");
    cur = byId.get(cur)?.parent_id ?? null;
  }
}

/** Create, or update when input.id names an existing work package. */
export async function upsertWorkpackage(
  db: D1Database,
  projectId: string,
  input: Record<string, unknown> & { id?: string },
  actor: string,
  expectedVersion?: number,
): Promise<WorkpackageRow> {
  if (!(await db.prepare("SELECT 1 FROM project WHERE id = ?").bind(projectId).first()))
    throw new NotFoundError(`project ${projectId} not found`);
  const fields = normalise(input);
  if (fields.status === "done" && fields.progress === undefined) fields.progress = 100;

  const existing = input.id ? await getWp(db, String(input.id)) : null;
  if (existing) {
    if (existing.project_id !== projectId)
      throw new ValidationError(`workpackage ${existing.id} belongs to project ${existing.project_id}`);
    if (typeof expectedVersion === "number" && expectedVersion !== existing.version) throw new ConflictError("version conflict", existing);
    if ("parent_id" in fields) await checkParent(db, projectId, existing.id, fields.parent_id);
    const next = { ...existing, ...fields } as Record<string, unknown>;
    const diff = diffFields(existing as unknown as Record<string, unknown>, next, WP_FIELDS);
    const changed = Object.keys(diff);
    if (!changed.length) return existing;
    const res = await db.batch([
      db
        .prepare(
          `UPDATE workpackage SET ${changed.map((f) => `${f} = ?`).join(", ")}, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
        )
        .bind(...changed.map((f) => next[f] ?? null), now(), existing.id, existing.version),
      eventStmtIfChanged(db, {
        actor,
        project_id: projectId,
        entity: "workpackage",
        entity_id: existing.id,
        action: "update",
        summary: `${String(next.title)}: ${changed.join(", ")}`,
        diff,
      }),
      ...reachStmts(db, projectId, actor),
    ]);
    if (!res[0].meta.changes) throw new ConflictError("version conflict", await getWp(db, existing.id));
    return (await getWp(db, existing.id))!;
  }

  const title = String(fields.title ?? "");
  if (!title) throw new ValidationError("title is required");
  if (input.id !== undefined && !ID_RE.test(String(input.id))) throw new ValidationError("id must match ^[a-z0-9][a-z0-9-]{0,62}$");
  await checkParent(db, projectId, null, fields.parent_id);

  const base = input.id ? String(input.id) : `${projectId}-${slugify(title)}`.slice(0, 63).replace(/-+$/, "");
  let id = base;
  for (let n = 2; await getWp(db, id); n++) id = `${base}-${n}`;

  const ts = now();
  const row: WorkpackageRow = {
    id,
    project_id: projectId,
    parent_id: null,
    title,
    description_md: null,
    status: "todo",
    blocked_by: null,
    progress: 0,
    weight: 1,
    start_date: null,
    end_date: null,
    depends_on: null,
    sort: 0,
    category: null,
    human: null,
    ...(fields as Partial<WorkpackageRow>),
    version: 1,
    created_at: ts,
    updated_at: ts,
  };
  const cols = ["id", "project_id", ...WP_FIELDS, "version", "created_at", "updated_at"] as const;
  await db.batch([
    db
      .prepare(`INSERT INTO workpackage (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .bind(...cols.map((c) => (row as unknown as Record<string, unknown>)[c] ?? null)),
    eventStmt(db, {
      actor,
      project_id: projectId,
      entity: "workpackage",
      entity_id: id,
      action: "create",
      summary: title,
      diff: diffFields(null, row as unknown as Record<string, unknown>, WP_FIELDS),
    }),
    ...reachStmts(db, projectId, actor),
  ]);
  return (await getWp(db, id))!;
}
