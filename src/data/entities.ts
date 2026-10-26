/**
 * Soft delete, trash, restore and purge (spec F10).
 *
 * Deleting moves an item to the trash: it gets `deleted_at` / `deleted_by`, and every read leaves it out
 * (see LIVE in util.ts). Children follow their parent with the same `deleted_at`: a project takes its WPs,
 * milestones and context docs (of all owners in it); a WP takes its sub-WPs, the milestones attached to any
 * of them and the docs they own. Restore clears exactly the rows carrying that `deleted_at`, so an item
 * deleted on its own earlier stays in the trash. Purge (admin only, after `policy.retention_days`) removes
 * the rows for good. Branches mirror git and stay hard-deleted (with the docs they own).
 */
import type { Caller } from "../types";
import { POLICY } from "../policy";
import { isAgent } from "../auth/caller";
import { requireAction } from "../auth/permissions";
import { reachStmts } from "./milestones";
import { agentGateRemovalError, gateClosedSql, gatesEnforced } from "./gates";
import { REDACTED_FIELDS } from "./persons";
import { OPEN_WP_STATUSES, TransitionError, isClosedProjectStatus, projectClosedError } from "./rules";
import { recomputeScheduleStmts, scheduleBatch, storeSchedule } from "./schedule";
import { NotFoundError, ValidationError, eventStmt, eventStmtIfChanged, eventStmtWhere, now, type Diff } from "./util";

export type EntityKind = "project" | "workpackage" | "branch" | "milestone" | "context_doc" | "person" | "risk";
export const ENTITY_KINDS: readonly EntityKind[] = ["project", "workpackage", "branch", "milestone", "context_doc", "person", "risk"];

/** Ids that follow an item into (or out of) the trash. */
export type Children = { workpackages: string[]; milestones: string[]; context_docs: string[]; risks: string[] };

export type TrashItem = {
  kind: EntityKind;
  id: string;
  title: string;
  project_id: string | null;
  deleted_at: string;
  deleted_by: string;
  /** Persons only: the access role they had (a deleted user needs an admin to be restored). */
  access_role?: string | null;
  children: number;
};

type Row = Record<string, unknown> & { id: string; deleted_at?: string | null };

const DAY_MS = 86_400_000;
const IN_IDS = "IN (SELECT value FROM json_each(?))";
/** Marks the slug of a doc deleted on its own, so a new doc can take the slug; restore puts it back. */
const SLUG_MARK = "~deleted-";
/** context_doc columns kept in delete / purge event payloads. */
const DOC_COLS = [
  "id",
  "project_id",
  "owner_kind",
  "owner_id",
  "title",
  "slug",
  "source",
  "filename",
  "content_md",
  "pinned",
  "sort",
  "bytes",
  "version",
  "status",
  "released_by",
  "released_at",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const;

const total = (c: Children): number => c.workpackages.length + c.milestones.length + c.context_docs.length + c.risks.length;
const titleOf = (kind: EntityKind, r: Row): string =>
  kind === "person" ? String(r.name) : kind === "branch" ? `${String(r.repo)}@${String(r.name)}` : String(r.title);
const projectOf = (kind: EntityKind, r: Row): string | null =>
  kind === "person" ? null : kind === "project" ? r.id : String(r.project_id);

function checkKind(kind: unknown): asserts kind is EntityKind {
  if (!ENTITY_KINDS.includes(kind as EntityKind)) throw new ValidationError(`kind must be one of ${ENTITY_KINDS.join("|")}`);
}

/** The row with this id, trash included (kind is checked, so the table name is safe). */
async function loadRow(db: D1Database, kind: EntityKind, id: string): Promise<Row | null> {
  return db.prepare(`SELECT * FROM ${kind} WHERE id = ?`).bind(id).first<Row>();
}

async function liveRow(db: D1Database, kind: EntityKind, id: string): Promise<Row> {
  const r = await loadRow(db, kind, id);
  if (!r || r.deleted_at) throw new NotFoundError(`${kind} ${id} not found`);
  return r;
}

async function trashedRow(db: D1Database, kind: EntityKind, id: string): Promise<Row & { deleted_at: string }> {
  const r = await loadRow(db, kind, id);
  if (!r || !r.deleted_at) throw new NotFoundError(`${kind} ${id} is not in the trash`);
  return r as Row & { deleted_at: string };
}

/** Event diff holding the whole row (each field [value, null]); contact data of persons is redacted (spec §4.1). */
function payloadDiff(kind: EntityKind, r: Row): Diff {
  const d: Diff = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === "deleted_at" || k === "deleted_by") continue;
    d[k] = [kind === "person" && REDACTED_FIELDS.includes(k) && v !== null ? "[redacted]" : v, null];
  }
  return d;
}

/**
 * Which rows go with an item. `live`: rows a delete takes along; `{ stamp }`: rows deleted together with it
 * (restore); `purge`: everything purging it removes (the whole subtree of a WP, whatever its stamp).
 */
type Mode = "live" | "purge" | { stamp: string };

async function collectChildren(db: D1Database, kind: EntityKind, r: Row, mode: Mode): Promise<Children> {
  const out: Children = { workpackages: [], milestones: [], context_docs: [], risks: [] };
  if (kind !== "project" && kind !== "workpackage") {
    if (kind === "branch") {
      const { results } = await db
        .prepare("SELECT id FROM context_doc WHERE owner_kind = 'branch' AND owner_id = ? ORDER BY id")
        .bind(r.id)
        .all<{ id: string }>();
      out.context_docs = results.map((x) => x.id);
    }
    return out;
  }
  const [cond, params]: [string, unknown[]] =
    mode === "live" ? ["deleted_at IS NULL", []] : mode === "purge" ? ["deleted_at IS NOT NULL", []] : ["deleted_at = ?", [mode.stamp]];
  const ids = async (sql: string, ...bind: unknown[]) =>
    (
      await db
        .prepare(`${sql} ORDER BY id`)
        .bind(...bind)
        .all<{ id: string }>()
    ).results.map((x) => x.id);

  if (kind === "project") {
    // A purge removes the whole project (FK cascade), whatever is or is not in the trash.
    const c = mode === "purge" ? "1 = 1" : cond;
    const p = mode === "purge" ? [] : params;
    out.workpackages = await ids(`SELECT id FROM workpackage WHERE project_id = ? AND ${c}`, r.id, ...p);
    out.milestones = await ids(`SELECT id FROM milestone WHERE project_id = ? AND ${c}`, r.id, ...p);
    out.context_docs = await ids(`SELECT id FROM context_doc WHERE project_id = ? AND ${c}`, r.id, ...p);
    out.risks = await ids(`SELECT id FROM risk WHERE project_id = ? AND ${c}`, r.id, ...p);
    return out;
  }

  const { results: wps } = await db
    .prepare("SELECT id, parent_id, deleted_at FROM workpackage WHERE project_id = ?")
    .bind(String(r.project_id))
    .all<{ id: string; parent_id: string | null; deleted_at: string | null }>();
  const follows = (w: { deleted_at: string | null }) =>
    mode === "live" ? w.deleted_at === null : mode === "purge" ? true : w.deleted_at === mode.stamp;
  const kids = new Map<string, typeof wps>();
  for (const w of wps) if (w.parent_id) kids.set(w.parent_id, [...(kids.get(w.parent_id) ?? []), w]);
  const seen = new Set<string>([r.id]);
  const stack = [r.id];
  while (stack.length) {
    for (const k of kids.get(stack.pop()!) ?? []) {
      if (seen.has(k.id) || !follows(k)) continue;
      seen.add(k.id);
      stack.push(k.id);
    }
  }
  const subtree = JSON.stringify([...seen]);
  out.workpackages = [...seen].filter((x) => x !== r.id).sort();
  out.milestones = await ids(
    `SELECT id FROM milestone WHERE project_id = ? AND workpackage_id ${IN_IDS} AND ${cond}`,
    r.project_id,
    subtree,
    ...params,
  );
  out.context_docs = await ids(
    `SELECT id FROM context_doc WHERE owner_kind = 'workpackage' AND owner_id ${IN_IDS} AND ${cond}`,
    subtree,
    ...params,
  );
  return out;
}

/** One event per context doc with its full row, e.g. before the docs are removed for good. */
function docEventsStmt(db: D1Database, ids: string[], action: string, by: Caller, ts: string, guard = "", guardParams: unknown[] = []) {
  const payload = `json_object(${DOC_COLS.map((c) => `'${c}', json_array(${c}, NULL)`).join(", ")})`;
  return db
    .prepare(
      `INSERT INTO event (ts, actor, person_id, project_id, entity, entity_id, action, summary, diff_json)
       SELECT ?, ?, ?, project_id, 'context_doc', id, ?, owner_kind || ':' || owner_id || '/' || slug, ${payload}
       FROM context_doc WHERE id ${IN_IDS}${guard}`,
    )
    .bind(ts, by.actor, by.personId, action, JSON.stringify(ids), ...guardParams);
}

/**
 * Users (persons with an access role) are deleted (deactivated) and restored by admins only, never by
 * agents (spec §4.1/§4.2, Ruling 23): that is managing access ("manage_roles").
 */
function checkPersonAccess(by: Caller, person: Row): void {
  if (person.access_role === null || person.access_role === undefined) return;
  requireAction(by, "manage_roles");
}

const CHILD_TABLES: Array<[keyof Children, string]> = [
  ["workpackages", "workpackage"],
  ["milestones", "milestone"],
  ["context_docs", "context_doc"],
  ["risks", "risk"],
];

/** Hard delete of a branch (it mirrors git) and the docs it owns; the events keep both payloads. */
async function deleteBranch(db: D1Database, id: string, by: Caller): Promise<{ deleted: string; children: number }> {
  const b = await loadRow(db, "branch", id);
  if (!b) throw new NotFoundError(`branch ${id} not found`);
  const docs = (await collectChildren(db, "branch", b, "live")).context_docs;
  const ts = now();
  await db.batch([
    docEventsStmt(db, docs, "delete", by, ts),
    db.prepare(`DELETE FROM context_doc WHERE id ${IN_IDS}`).bind(JSON.stringify(docs)),
    db.prepare("DELETE FROM branch WHERE id = ?").bind(id),
    eventStmt(db, {
      by,
      project_id: String(b.project_id),
      entity: "branch",
      entity_id: id,
      action: "delete",
      summary: titleOf("branch", b),
      diff: { ...payloadDiff("branch", b), deleted_context_docs: [docs, null] },
    }),
  ]);
  return { deleted: id, children: docs.length };
}

/**
 * Move an item to the trash with its children (branches: hard delete). The event diff holds the item's
 * full row and the ids of the children. A context doc deleted on its own gives up its slug.
 */
export async function deleteEntity(
  db: D1Database,
  kind: EntityKind,
  id: string,
  by: Caller,
): Promise<{ deleted: string; children: number }> {
  checkKind(kind);
  if (kind === "branch") return deleteBranch(db, id, by);
  const row = await liveRow(db, kind, id);
  if (kind === "person") {
    checkPersonAccess(by, row);
    if (by.personId === id) throw new ValidationError("you cannot delete your own person");
  }
  const children = await collectChildren(db, kind, row, "live");
  // F5: an agent may not trash an undecided gate (alone, or as the milestone of a deleted WP): that would
  // lift its lock. Checked here for the error and again in the UPDATE (a decision may change meanwhile).
  const gateIds = isAgent(by) && gatesEnforced() ? (kind === "milestone" ? [id] : kind === "workpackage" ? children.milestones : []) : [];
  const closedGate = gateIds.length
    ? `SELECT gx.title FROM milestone gx JOIN json_each(?) gj ON gx.id = gj.value WHERE ${gateClosedSql("gx")}`
    : null;
  if (closedGate) {
    const hit = await db.prepare(`${closedGate} LIMIT 1`).bind(JSON.stringify(gateIds)).first<{ title: string }>();
    if (hit) throw agentGateRemovalError(hit.title);
  }
  const ts = now();
  const projectId = projectOf(kind, row);
  const slug = kind === "context_doc" ? `${String(row.slug)}${SLUG_MARK}${Date.parse(ts)}` : null;
  const stamped = `EXISTS (SELECT 1 FROM ${kind} WHERE id = ? AND deleted_at = ?)`;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE ${kind} SET deleted_at = ?, deleted_by = ?${slug ? ", slug = ?" : ""} WHERE id = ? AND deleted_at IS NULL${closedGate ? ` AND NOT EXISTS (${closedGate})` : ""}`,
      )
      .bind(ts, by.actor, ...(slug ? [slug] : []), id, ...(closedGate ? [JSON.stringify(gateIds)] : [])),
    eventStmtIfChanged(db, {
      by,
      project_id: projectId,
      entity: kind,
      entity_id: id,
      action: "delete",
      summary: titleOf(kind, row),
      diff: { ...payloadDiff(kind, row), ...(total(children) ? { deleted_children: [children, null] } : {}) },
    }),
  ];
  for (const [key, table] of CHILD_TABLES)
    if (children[key].length)
      stmts.push(
        db
          .prepare(`UPDATE ${table} SET deleted_at = ?, deleted_by = ? WHERE id ${IN_IDS} AND deleted_at IS NULL AND ${stamped}`)
          .bind(ts, by.actor, JSON.stringify(children[key]), id, ts),
      );
  // Removing a required WP can complete a milestone.
  if (kind === "workpackage") stmts.push(...reachStmts(db, projectId!, by));
  // The schedule of the remaining plan is stored in the same batch (spec F4); never refused by strict mode.
  const scheduled = kind === "workpackage" || kind === "milestone";
  if (scheduled)
    stmts.push(
      ...(
        await recomputeScheduleStmts(db, projectId!, {
          removeWps: kind === "workpackage" ? [id, ...children.workpackages] : [],
          removeMilestones: kind === "milestone" ? [id] : [],
          strict: false,
        })
      ).stmts,
    );
  const res = await scheduleBatch(db, stmts);
  if (!res[0].meta.changes) {
    if (scheduled) await storeSchedule(db, projectId!);
    throw new NotFoundError(`${kind} ${id} not found`);
  }
  return { deleted: id, children: total(children) };
}

const parentDeleted = (message: string) => new TransitionError(message, { code: "PARENT_DELETED" });

/** Restoring needs a live parent: project, parent WP, the milestone's WP, the doc's owner. */
async function checkParents(db: D1Database, kind: EntityKind, r: Row): Promise<void> {
  const isLive = async (table: string, id: unknown) =>
    !!(await db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND deleted_at IS NULL`).bind(String(id)).first());
  if (kind === "person" || kind === "project") return;
  if (!(await isLive("project", r.project_id))) throw parentDeleted(`project ${String(r.project_id)} is in the trash; restore it first`);
  if (kind === "risk") return;
  const parent: [string, unknown] | null =
    kind === "workpackage"
      ? r.parent_id
        ? ["workpackage", r.parent_id]
        : null
      : kind === "milestone"
        ? r.workpackage_id
          ? ["workpackage", r.workpackage_id]
          : null
        : r.owner_kind === "project"
          ? null
          : [String(r.owner_kind), r.owner_id];
  if (!parent) return;
  if (parent[0] === "branch") {
    if (!(await db.prepare("SELECT 1 FROM branch WHERE id = ?").bind(String(parent[1])).first()))
      throw parentDeleted(`branch ${String(parent[1])} no longer exists`);
  } else if (!(await isLive(parent[0], parent[1])))
    throw parentDeleted(`${parent[0]} ${String(parent[1])} is in the trash; restore it first`);
}

/**
 * Take an item and everything deleted together with it out of the trash (admins, spec §4.2). Refused
 * (409 PARENT_DELETED) while its parent is in the trash, (409 SLUG_TAKEN) when a doc's slug has been
 * reused meanwhile, and (409 PROJECT_CLOSED) when open WPs would come back into a done/abandoned project.
 */
export async function restoreEntity(
  db: D1Database,
  kind: EntityKind,
  id: string,
  by: Caller,
): Promise<{ restored: string; children: number }> {
  checkKind(kind);
  // Restoring is an admin action (spec §4.2; the route and tool map to "restore" too).
  requireAction(by, "restore");
  if (kind === "branch") throw new ValidationError("branches are deleted permanently; link the branch again");
  const row = await trashedRow(db, kind, id);
  if (kind === "person") checkPersonAccess(by, row);
  await checkParents(db, kind, row);
  const stamp = row.deleted_at;
  const children = await collectChildren(db, kind, row, { stamp });
  const projectId = projectOf(kind, row);
  // A done/abandoned project gets no open work back (F3, Ruling 20): reopen the project first.
  if (kind === "workpackage") {
    const project = await db.prepare("SELECT status FROM project WHERE id = ?").bind(projectId).first<{ status: string }>();
    if (project && isClosedProjectStatus(project.status)) {
      const open = await db
        .prepare(`SELECT 1 FROM workpackage WHERE id ${IN_IDS} AND status IN (${OPEN_WP_STATUSES.map((s) => `'${s}'`).join(", ")}) LIMIT 1`)
        .bind(JSON.stringify([id, ...children.workpackages]))
        .first();
      if (open) throw projectClosedError(projectId!, project.status);
    }
  }

  let slug: string | null = null;
  if (kind === "context_doc" && String(row.slug).includes(SLUG_MARK)) {
    slug = String(row.slug).slice(0, String(row.slug).indexOf(SLUG_MARK));
    const taken = await db
      .prepare("SELECT 1 FROM context_doc WHERE owner_kind = ? AND owner_id = ? AND slug = ? AND id != ?")
      .bind(row.owner_kind, row.owner_id, slug, id)
      .first();
    if (taken) throw slugTaken(slug);
  }
  const restoredAgain = `EXISTS (SELECT 1 FROM ${kind} WHERE id = ? AND deleted_at IS NULL)`;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(`UPDATE ${kind} SET deleted_at = NULL, deleted_by = NULL${slug ? ", slug = ?" : ""} WHERE id = ? AND deleted_at = ?`)
      .bind(...(slug ? [slug] : []), id, stamp),
    eventStmtIfChanged(db, {
      by,
      project_id: projectId,
      entity: kind,
      entity_id: id,
      action: "restore",
      summary: titleOf(kind, row),
      diff: {
        ...(slug ? { slug: [row.slug, slug] } : {}),
        ...(total(children) ? { restored_children: [null, children] } : {}),
      },
    }),
  ];
  for (const [key, table] of CHILD_TABLES)
    if (children[key].length)
      stmts.push(
        db
          .prepare(`UPDATE ${table} SET deleted_at = NULL, deleted_by = NULL WHERE id ${IN_IDS} AND deleted_at = ? AND ${restoredAgain}`)
          .bind(JSON.stringify(children[key]), stamp, id),
      );
  const scheduled = kind === "project" || kind === "workpackage" || kind === "milestone";
  if (scheduled) stmts.push(...reachStmts(db, projectId!, by));
  // Restored entities bring their schedule issues back, stored in the same batch (spec F4).
  if (scheduled)
    stmts.push(
      ...(
        await recomputeScheduleStmts(db, projectId!, {
          restoreWps: [...(kind === "workpackage" ? [id] : []), ...children.workpackages],
          restoreMilestones: [...(kind === "milestone" ? [id] : []), ...children.milestones],
          strict: false,
        })
      ).stmts,
    );
  let res: D1Result[];
  try {
    res = await scheduleBatch(db, stmts);
  } catch (e) {
    if (slug && /UNIQUE/i.test(String((e as Error)?.message))) throw slugTaken(slug);
    throw e;
  }
  if (!res[0].meta.changes) {
    if (scheduled) await storeSchedule(db, projectId!);
    throw new NotFoundError(`${kind} ${id} is not in the trash`);
  }
  return { restored: id, children: total(children) };
}

const slugTaken = (slug: string) =>
  new TransitionError(`slug ${slug} is taken by another document; delete or rename it first`, { code: "SLUG_TAKEN" });

/**
 * Remove an item from the trash for good, with everything deleted together with it (a WP: its whole
 * subtree). Admins only, and only once it has been in the trash for `policy.retention_days` days (409
 * RETENTION otherwise). The purge events keep the item's row, child rows, and each removed doc's content.
 * `at` is the current time (tests pass their own).
 */
export async function purgeEntity(
  db: D1Database,
  kind: EntityKind,
  id: string,
  by: Caller,
  at: Date = new Date(),
): Promise<{ purged: string }> {
  checkKind(kind);
  // Purging is a manual admin action in the dashboard, never an agent's (the route maps to "purge" too).
  requireAction(by, "purge");
  if (kind === "branch") throw new NotFoundError(`branch ${id} is not in the trash`);
  const row = await trashedRow(db, kind, id);
  const stamp = row.deleted_at;
  const purgeableAt = new Date(Date.parse(stamp) + POLICY.retention_days * DAY_MS);
  if (at.getTime() < purgeableAt.getTime())
    throw new TransitionError(
      `${kind} ${id} can be purged from ${purgeableAt.toISOString()} (${POLICY.retention_days} days after deletion)`,
      { code: "RETENTION", purgeable_at: purgeableAt.toISOString() },
    );
  const children = await collectChildren(db, kind, row, "purge");
  const rowsOf = async (table: string, ids: string[]) =>
    ids.length ? (await db.prepare(`SELECT * FROM ${table} WHERE id ${IN_IDS} ORDER BY id`).bind(JSON.stringify(ids)).all()).results : [];
  const childRows = {
    workpackages: await rowsOf("workpackage", children.workpackages),
    milestones: await rowsOf("milestone", children.milestones),
    context_docs: children.context_docs,
    risks: await rowsOf("risk", children.risks),
  };
  const ts = now();
  // Every statement applies only while the item is still in the trash with the stamp read above.
  const guard = ` AND EXISTS (SELECT 1 FROM ${kind} WHERE id = ? AND deleted_at = ?)`;
  const g = [id, stamp];
  const stmts: D1PreparedStatement[] = [
    eventStmtWhere(
      db,
      {
        by,
        project_id: projectOf(kind, row),
        entity: kind,
        entity_id: id,
        action: "purge",
        summary: titleOf(kind, row),
        diff: { ...payloadDiff(kind, row), ...(total(children) ? { purged_children: [childRows, null] } : {}) },
      },
      guard.replace(" AND ", ""),
      g,
    ),
  ];
  if (children.context_docs.length)
    stmts.push(
      docEventsStmt(db, children.context_docs, "purge", by, ts, guard, g),
      db.prepare(`DELETE FROM context_doc WHERE id ${IN_IDS}${guard}`).bind(JSON.stringify(children.context_docs), ...g),
    );
  if (children.risks.length)
    stmts.push(db.prepare(`DELETE FROM risk WHERE id ${IN_IDS}${guard}`).bind(JSON.stringify(children.risks), ...g));
  if (children.milestones.length)
    stmts.push(db.prepare(`DELETE FROM milestone WHERE id ${IN_IDS}${guard}`).bind(JSON.stringify(children.milestones), ...g));
  if (children.workpackages.length)
    stmts.push(db.prepare(`DELETE FROM workpackage WHERE id ${IN_IDS}${guard}`).bind(JSON.stringify(children.workpackages), ...g));
  // Last: the item itself (a project cascades whatever is left of it: branches, scores, token cost, links).
  stmts.push(db.prepare(`DELETE FROM ${kind} WHERE id = ? AND deleted_at = ?`).bind(id, stamp));
  const res = await db.batch(stmts);
  if (!res[res.length - 1].meta.changes) throw new NotFoundError(`${kind} ${id} is not in the trash`);
  return { purged: id };
}

/**
 * Items in the trash, newest first: only the items that were deleted (children deleted together with their
 * parent are counted in `children`, not listed).
 */
export async function listTrash(db: D1Database): Promise<TrashItem[]> {
  type T = { id: string; title: string; project_id: string | null; deleted_at: string; deleted_by: string };
  const [p, w, m, d, pe, ri] = await db.batch([
    db.prepare("SELECT id, title, id AS project_id, deleted_at, deleted_by FROM project WHERE deleted_at IS NOT NULL"),
    db.prepare("SELECT id, title, project_id, parent_id, deleted_at, deleted_by FROM workpackage WHERE deleted_at IS NOT NULL"),
    db.prepare("SELECT id, title, project_id, workpackage_id, deleted_at, deleted_by FROM milestone WHERE deleted_at IS NOT NULL"),
    db.prepare("SELECT id, title, project_id, owner_kind, owner_id, deleted_at, deleted_by FROM context_doc WHERE deleted_at IS NOT NULL"),
    db.prepare(
      "SELECT id, name AS title, NULL AS project_id, access_role, deleted_at, deleted_by FROM person WHERE deleted_at IS NOT NULL",
    ),
    db.prepare("SELECT id, title, project_id, deleted_at, deleted_by FROM risk WHERE deleted_at IS NOT NULL"),
  ]);
  const projects = p.results as T[];
  const wps = w.results as Array<T & { parent_id: string | null }>;
  const ms = m.results as Array<T & { workpackage_id: string | null }>;
  const docs = d.results as Array<T & { owner_kind: string; owner_id: string }>;
  const projStamp = new Map(projects.map((x) => [x.id, x.deleted_at]));
  const wpStamp = new Map(wps.map((x) => [x.id, x.deleted_at]));
  const withProject = (x: T) => projStamp.get(x.project_id ?? "") === x.deleted_at;
  const withWp = (wpId: string | null, stamp: string) => !!wpId && wpStamp.get(wpId) === stamp;

  const kids = new Map<string, typeof wps>();
  for (const x of wps) if (x.parent_id) kids.set(x.parent_id, [...(kids.get(x.parent_id) ?? []), x]);
  const subtree = (root: T): Set<string> => {
    const seen = new Set([root.id]);
    const stack = [root.id];
    while (stack.length)
      for (const k of kids.get(stack.pop()!) ?? [])
        if (!seen.has(k.id) && k.deleted_at === root.deleted_at) {
          seen.add(k.id);
          stack.push(k.id);
        }
    return seen;
  };
  const out: TrashItem[] = [];
  const push = (kind: EntityKind, x: T, children: number) => out.push({ kind, ...x, children });
  for (const x of projects) {
    const same = (y: T) => y.project_id === x.id && y.deleted_at === x.deleted_at;
    push(
      "project",
      x,
      wps.filter(same).length + ms.filter(same).length + docs.filter(same).length + (ri.results as T[]).filter(same).length,
    );
  }
  for (const x of wps) {
    if (withProject(x) || withWp(x.parent_id, x.deleted_at)) continue;
    const set = subtree(x);
    const same = (y: T) => y.deleted_at === x.deleted_at;
    push(
      "workpackage",
      x,
      set.size -
        1 +
        ms.filter((y) => same(y) && y.workpackage_id !== null && set.has(y.workpackage_id)).length +
        docs.filter((y) => same(y) && y.owner_kind === "workpackage" && set.has(y.owner_id)).length,
    );
  }
  for (const x of ms) if (!withProject(x) && !withWp(x.workpackage_id, x.deleted_at)) push("milestone", x, 0);
  for (const x of docs)
    if (!withProject(x) && !(x.owner_kind === "workpackage" && withWp(x.owner_id, x.deleted_at))) push("context_doc", x, 0);
  for (const x of pe.results as T[]) push("person", x, 0);
  for (const x of ri.results as T[]) if (!withProject(x)) push("risk", x, 0);
  return out.sort((a, b) => (a.deleted_at < b.deleted_at ? 1 : a.deleted_at > b.deleted_at ? -1 : a.id.localeCompare(b.id)));
}

/** What deleting a live item would take along, for the confirm text ("Delete WP3 with 6 sub-WPs?"). */
export async function deletePreview(
  db: D1Database,
  kind: EntityKind,
  id: string,
): Promise<{
  kind: EntityKind;
  id: string;
  title: string;
  children: { workpackages: number; milestones: number; context_docs: number; risks: number };
}> {
  checkKind(kind);
  const row = kind === "branch" ? await loadRow(db, kind, id) : await liveRow(db, kind, id);
  if (!row) throw new NotFoundError(`${kind} ${id} not found`);
  const c = await collectChildren(db, kind, row, "live");
  return {
    kind,
    id,
    title: titleOf(kind, row),
    children: {
      workpackages: c.workpackages.length,
      milestones: c.milestones.length,
      context_docs: c.context_docs.length,
      risks: c.risks.length,
    },
  };
}

/** Number of rows a delete of this live item takes along. */
export async function countChildren(db: D1Database, kind: EntityKind, id: string): Promise<number> {
  const c = (await deletePreview(db, kind, id)).children;
  return c.workpackages + c.milestones + c.context_docs;
}
