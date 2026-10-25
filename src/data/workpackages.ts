import type { Caller, PersonOut, PersonRefOut, ProjectRow, WorkpackageRow } from "../types";
import {
  ConflictError,
  LIVE,
  NotFoundError,
  ValidationError,
  diffFields,
  eventStmt,
  eventStmtIfChanged,
  now,
  parseJsonArray,
  slugify,
} from "./util";
import { dependsOnInput, issuesOf, recomputeScheduleStmts, storeSchedule, type ScheduleIssue } from "./schedule";
import { WP_CATEGORIES, checkCategory, checkHuman } from "./categories";
import { reachStmts } from "./milestones";
import { personOuts, personRefInput, personRefOut, resolvePersonRef } from "./persons";
import {
  applyWpRules,
  checkBlockedRef,
  isClosedProjectStatus,
  isOpenWpStatus,
  parseBlockedBy,
  projectClosedError,
  type BlockedRef,
} from "./rules";

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
  "drop_reason",
  "blocked_since",
  "waiting_reason",
] as const;
type WpField = (typeof WP_FIELDS)[number];
/** Columns written by create/update and diffed into events (WP fields plus the owner columns). */
const WRITE_COLS = [...WP_FIELDS, "owner_person_id", "owner_text"] as const;

/**
 * Client shape of a work package: owner as chip or text, effective owner (WP owner, else project owner),
 * stakeholders, and `blocked_by` classified as a wp:/ms:/ext: reference or free text.
 */
export type WpOut = WorkpackageRow & {
  owner: PersonRefOut;
  effective_owner: PersonRefOut;
  priority_stakeholders: PersonOut[];
  blocked_ref: BlockedRef | null;
};

/** Write result: the work package plus the schedule issues that concern it (spec F4). */
export type WpWriteOut = WpOut & { warnings: ScheduleIssue[] };

const STATUSES = ["todo", "doing", "blocked", "waiting", "done", "dropped"];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function listWorkpackages(db: D1Database, projectId: string): Promise<WorkpackageRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM workpackage WHERE project_id = ? AND ${LIVE()} ORDER BY sort, title`)
    .bind(projectId)
    .all<WorkpackageRow>();
  return results;
}

/** A live work package (null when missing or in the trash). */
async function getWp(db: D1Database, id: string): Promise<WorkpackageRow | null> {
  return db.prepare(`SELECT * FROM workpackage WHERE id = ? AND ${LIVE()}`).bind(id).first<WorkpackageRow>();
}

/** Any row with this id, trash included (ids stay taken while an item is in the trash). */
async function getWpAny(db: D1Database, id: string): Promise<WorkpackageRow | null> {
  return db.prepare("SELECT * FROM workpackage WHERE id = ?").bind(id).first<WorkpackageRow>();
}

async function stakeholderIds(db: D1Database, wpIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < wpIds.length; i += 90) {
    const chunk = wpIds.slice(i, i + 90);
    const { results } = await db
      .prepare(
        `SELECT s.workpackage_id, s.person_id FROM wp_stakeholder s JOIN person p ON p.id = s.person_id AND ${LIVE("p")} WHERE s.workpackage_id IN (${chunk.map(() => "?").join(", ")}) ORDER BY p.name COLLATE NOCASE, p.id`,
      )
      .bind(...chunk)
      .all<{ workpackage_id: string; person_id: string }>();
    for (const r of results) out.set(r.workpackage_id, [...(out.get(r.workpackage_id) ?? []), r.person_id]);
  }
  return out;
}

/** Adds owner, effective_owner and priority_stakeholders to work packages of one project (computed on read). */
export async function withPersonOuts(
  db: D1Database,
  project: Pick<ProjectRow, "owner_person_id" | "owner_text">,
  wps: WorkpackageRow[],
): Promise<WpOut[]> {
  const stake = await stakeholderIds(
    db,
    wps.map((w) => w.id),
  );
  const people = await personOuts(db, [project.owner_person_id, ...wps.map((w) => w.owner_person_id), ...[...stake.values()].flat()]);
  const projectOwner = personRefOut(project.owner_person_id, project.owner_text, people);
  return wps.map((w) => {
    const owner = personRefOut(w.owner_person_id, w.owner_text, people);
    return {
      ...w,
      owner,
      effective_owner: owner ?? projectOwner,
      priority_stakeholders: (stake.get(w.id) ?? []).map((id) => people.get(id)).filter((p): p is PersonOut => !!p),
      blocked_ref: parseBlockedBy(w.blocked_by),
    };
  });
}

/** Work packages of a project in client shape. */
export async function listWorkpackagesOut(db: D1Database, projectId: string): Promise<WpOut[]> {
  const project = await db
    .prepare(`SELECT owner_person_id, owner_text FROM project WHERE id = ? AND ${LIVE()}`)
    .bind(projectId)
    .first<Pick<ProjectRow, "owner_person_id" | "owner_text">>();
  if (!project) throw new NotFoundError(`project ${projectId} not found`);
  return withPersonOuts(db, project, await listWorkpackages(db, projectId));
}

async function getWpOut(db: D1Database, project: Pick<ProjectRow, "owner_person_id" | "owner_text">, id: string): Promise<WpOut> {
  const w = await getWp(db, id);
  if (!w) throw new NotFoundError(`workpackage ${id} not found`);
  return (await withPersonOuts(db, project, [w]))[0];
}

/**
 * priority_stakeholders input: an array of person refs (id, email, exact name); null or [] clears.
 * Every entry must match a person, so a typo never silently becomes a stakeholder.
 */
async function stakeholderInput(db: D1Database, v: unknown): Promise<string[] | undefined> {
  if (v === undefined) return undefined;
  if (v === null) return [];
  if (!Array.isArray(v) || v.length > 50 || v.some((x) => typeof x !== "string"))
    throw new ValidationError("priority_stakeholders must be a list of up to 50 person ids, emails or names");
  const ids: string[] = [];
  for (const ref of v as string[]) {
    const r = await resolvePersonRef(db, ref);
    if (!r.person_id) throw new ValidationError(`priority_stakeholders: "${ref}" matches no person; add them with upsert_person first`);
    if (!ids.includes(r.person_id)) ids.push(r.person_id);
  }
  return ids.sort();
}

/**
 * Statements that replace a WP's stakeholders, applied only while the WP still has `version`
 * (so a lost version race in the same batch changes nothing).
 */
function stakeholderStmts(db: D1Database, wpId: string, version: number, ids: string[]): D1PreparedStatement[] {
  const guard = "EXISTS (SELECT 1 FROM workpackage WHERE id = ? AND version = ?)";
  return [
    db.prepare(`DELETE FROM wp_stakeholder WHERE workpackage_id = ? AND ${guard}`).bind(wpId, wpId, version),
    ...ids.map((pid) =>
      db.prepare(`INSERT INTO wp_stakeholder (workpackage_id, person_id) SELECT ?, ? WHERE ${guard}`).bind(wpId, pid, wpId, version),
    ),
  ];
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
        v = JSON.stringify(dependsOnInput(v));
        break;
      case "category":
        v = checkCategory(v, WP_CATEGORIES);
        break;
      case "human":
        v = checkHuman(v);
        break;
      case "start_date":
      case "end_date":
      case "blocked_since":
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

/** The schedule view of a WP row. */
const scheduleWp = (w: Pick<WorkpackageRow, "id" | "parent_id" | "start_date" | "end_date" | "depends_on">) => ({
  id: w.id,
  parent_id: w.parent_id ?? null,
  start_date: w.start_date ?? null,
  end_date: w.end_date ?? null,
  depends_on: parseJsonArray(w.depends_on ?? null),
});

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

/**
 * Create, or update when input.id names an existing work package. `owner` is a person ref (id, email,
 * name) or free text; `priority_stakeholders` replaces the stored list.
 */
export async function upsertWorkpackage(
  db: D1Database,
  projectId: string,
  input: Record<string, unknown> & { id?: string },
  by: Caller,
  expectedVersion?: number,
): Promise<WpWriteOut> {
  const project = await db
    .prepare(`SELECT owner_person_id, owner_text, status FROM project WHERE id = ? AND ${LIVE()}`)
    .bind(projectId)
    .first<Pick<ProjectRow, "owner_person_id" | "owner_text" | "status">>();
  if (!project) throw new NotFoundError(`project ${projectId} not found`);
  const closed = isClosedProjectStatus(project.status);
  const fields: Partial<Record<(typeof WRITE_COLS)[number], unknown>> = normalise(input);
  if (fields.status === "done" && fields.progress === undefined) fields.progress = 100;
  const owner = await personRefInput(db, input.owner, "owner");
  if (owner) {
    fields.owner_person_id = owner.person_id;
    fields.owner_text = owner.text;
  }
  const stakeholders = await stakeholderInput(db, input.priority_stakeholders);
  if (fields.blocked_by !== undefined) await checkBlockedRef(db, fields.blocked_by);

  const existing = input.id ? await getWpAny(db, String(input.id)) : null;
  if (existing?.deleted_at) throw new NotFoundError(`workpackage ${existing.id} is in the trash; restore it first`);
  if (existing) {
    if (existing.project_id !== projectId)
      throw new ValidationError(`workpackage ${existing.id} belongs to project ${existing.project_id}`);
    if (typeof expectedVersion === "number" && expectedVersion !== existing.version) throw new ConflictError("version conflict", existing);
    applyWpRules(existing, fields);
    // A done/abandoned project gets no open work back (edits that keep the status stay possible).
    if (closed && fields.status !== undefined && fields.status !== existing.status && isOpenWpStatus(String(fields.status)))
      throw projectClosedError(projectId, project.status);
    if ("parent_id" in fields) await checkParent(db, projectId, existing.id, fields.parent_id);
    const next = { ...existing, ...fields } as Record<string, unknown>;
    const diff = diffFields(existing as unknown as Record<string, unknown>, next, WRITE_COLS);
    const changed = Object.keys(diff);
    let stakeStmts: D1PreparedStatement[] = [];
    if (stakeholders) {
      const before = [...((await stakeholderIds(db, [existing.id])).get(existing.id) ?? [])].sort();
      if (JSON.stringify(before) !== JSON.stringify(stakeholders)) {
        diff.priority_stakeholders = [before, stakeholders];
        stakeStmts = stakeholderStmts(db, existing.id, existing.version, stakeholders);
      }
    }
    if (!Object.keys(diff).length) {
      const { issues } = await recomputeScheduleStmts(db, projectId);
      return { ...(await withPersonOuts(db, project, [existing]))[0], warnings: issuesOf(issues, existing.id) };
    }
    const schedule = await recomputeScheduleStmts(db, projectId, {
      wp: scheduleWp(next as unknown as WorkpackageRow),
      checkDependsOn: "depends_on" in diff,
    });
    const res = await db.batch([
      ...stakeStmts,
      db
        .prepare(
          `UPDATE workpackage SET ${changed.map((f) => `${f} = ?, `).join("")}version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
        )
        .bind(...changed.map((f) => next[f] ?? null), now(), existing.id, existing.version),
      eventStmtIfChanged(db, {
        by,
        project_id: projectId,
        entity: "workpackage",
        entity_id: existing.id,
        action: "update",
        summary: `${String(next.title)}: ${Object.keys(diff).join(", ")}`,
        diff,
      }),
      ...reachStmts(db, projectId, by),
      ...schedule.stmts,
    ]);
    if (!res[stakeStmts.length].meta.changes) {
      // The batch stored issues computed for this write; put back the ones of the stored plan.
      await storeSchedule(db, projectId);
      throw new ConflictError("version conflict", await getWp(db, existing.id));
    }
    return { ...(await getWpOut(db, project, existing.id)), warnings: issuesOf(schedule.issues, existing.id) };
  }

  if (closed) throw projectClosedError(projectId, project.status);
  const title = String(fields.title ?? "");
  if (!title) throw new ValidationError("title is required");
  if (input.id !== undefined && !ID_RE.test(String(input.id))) throw new ValidationError("id must match ^[a-z0-9][a-z0-9-]{0,62}$");
  await checkParent(db, projectId, null, fields.parent_id);
  applyWpRules(null, fields);

  const base = input.id ? String(input.id) : `${projectId}-${slugify(title)}`.slice(0, 63).replace(/-+$/, "");
  let id = base;
  for (let n = 2; await getWpAny(db, id); n++) id = `${base}-${n}`;

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
    owner_person_id: null,
    owner_text: null,
    drop_reason: null,
    blocked_since: null,
    waiting_reason: null,
    ...(fields as Partial<WorkpackageRow>),
    version: 1,
    created_at: ts,
    updated_at: ts,
  };
  const schedule = await recomputeScheduleStmts(db, projectId, { wp: scheduleWp(row), checkDependsOn: fields.depends_on !== undefined });
  const cols = ["id", "project_id", ...WRITE_COLS, "version", "created_at", "updated_at"] as const;
  await db.batch([
    db
      .prepare(`INSERT INTO workpackage (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .bind(...cols.map((c) => (row as unknown as Record<string, unknown>)[c] ?? null)),
    eventStmt(db, {
      by,
      project_id: projectId,
      entity: "workpackage",
      entity_id: id,
      action: "create",
      summary: title,
      diff: {
        ...diffFields(null, row as unknown as Record<string, unknown>, WRITE_COLS),
        ...(stakeholders?.length ? { priority_stakeholders: [null, stakeholders] } : {}),
      },
    }),
    ...(stakeholders?.length ? stakeholderStmts(db, id, 1, stakeholders) : []),
    ...reachStmts(db, projectId, by),
    ...schedule.stmts,
  ]);
  return { ...(await getWpOut(db, project, id)), warnings: issuesOf(schedule.issues, id) };
}
