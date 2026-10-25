import type { Caller, MilestoneRow } from "../types";
import { ConflictError, LIVE, NotFoundError, ValidationError, diffFields, eventStmt, eventStmtIfChanged, newId, now } from "./util";

export type MilestoneOut = MilestoneRow & { requires: string[]; unlocks: string[]; done: boolean };
export type MilestoneInput = {
  id?: string;
  title?: unknown;
  description_md?: unknown;
  due_date?: unknown;
  workpackage_id?: unknown;
  sort?: unknown;
  requires?: unknown;
  unlocks?: unknown;
};

const MS_FIELDS = ["title", "description_md", "due_date", "workpackage_id", "sort"] as const;
type MsField = (typeof MS_FIELDS)[number];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A milestone qualifies (is done) when it has at least one non-dropped `requires` WP and every
 * `requires` WP is done or dropped. WPs in the trash do not count. `m` is the milestone alias.
 */
export const QUALIFIES = `EXISTS (SELECT 1 FROM milestone_link l JOIN workpackage w ON w.id = l.workpackage_id
    WHERE l.milestone_id = m.id AND l.role = 'requires' AND w.deleted_at IS NULL AND w.status != 'dropped')
  AND NOT EXISTS (SELECT 1 FROM milestone_link l JOIN workpackage w ON w.id = l.workpackage_id
    WHERE l.milestone_id = m.id AND l.role = 'requires' AND w.deleted_at IS NULL AND w.status NOT IN ('done', 'dropped'))`;

/**
 * Statements to append at the end of any batch that writes work packages or milestones of a project:
 * one `milestone/reached` event per newly qualifying milestone, then `reached_at` (set once, never cleared).
 */
export function reachStmts(db: D1Database, projectId: string, by: Caller): D1PreparedStatement[] {
  const ts = now();
  return [
    db
      .prepare(
        `INSERT INTO event (ts, actor, person_id, project_id, entity, entity_id, action, summary, diff_json)
         SELECT ?, ?, ?, m.project_id, 'milestone', m.id, 'reached', m.title, NULL FROM milestone m
         WHERE m.project_id = ? AND m.reached_at IS NULL AND ${LIVE("m")} AND ${QUALIFIES}`,
      )
      .bind(ts, by.actor, by.personId, projectId),
    db
      .prepare(`UPDATE milestone AS m SET reached_at = ? WHERE m.project_id = ? AND m.reached_at IS NULL AND ${LIVE("m")} AND ${QUALIFIES}`)
      .bind(ts, projectId),
  ];
}

export async function listMilestones(db: D1Database, projectId: string): Promise<MilestoneOut[]> {
  const [ms, links] = await db.batch([
    db
      .prepare(
        `SELECT m.*, (${QUALIFIES}) AS done FROM milestone m WHERE m.project_id = ? AND ${LIVE("m")} ORDER BY m.due_date IS NULL, m.due_date, m.sort, m.title`,
      )
      .bind(projectId),
    db
      .prepare(
        `SELECT l.* FROM milestone_link l JOIN milestone m ON m.id = l.milestone_id JOIN workpackage w ON w.id = l.workpackage_id
         WHERE m.project_id = ? AND ${LIVE("m")} AND ${LIVE("w")} ORDER BY l.workpackage_id`,
      )
      .bind(projectId),
  ]);
  const by = new Map<string, { requires: string[]; unlocks: string[] }>();
  for (const l of links.results as Array<{ milestone_id: string; workpackage_id: string; role: string }>) {
    const e = by.get(l.milestone_id) ?? { requires: [], unlocks: [] };
    (l.role === "requires" ? e.requires : e.unlocks).push(l.workpackage_id);
    by.set(l.milestone_id, e);
  }
  return (ms.results as Array<MilestoneRow & { done: number }>).map((m) => ({
    ...m,
    done: m.done === 1,
    ...(by.get(m.id) ?? { requires: [], unlocks: [] }),
  }));
}

/** WPs unlocked by a milestone that has never been reached. */
export function lockedWpIds(ms: MilestoneOut[]): Set<string> {
  return new Set(ms.filter((m) => !m.reached_at).flatMap((m) => m.unlocks));
}

function normalise(input: MilestoneInput): Partial<Record<MsField, unknown>> {
  const out: Partial<Record<MsField, unknown>> = {};
  for (const f of MS_FIELDS) {
    if (!(f in input) || input[f] === undefined) continue;
    let v = input[f];
    if (f === "title") {
      if (typeof v !== "string" || !v.trim()) throw new ValidationError("title is required");
      v = v.trim();
    } else if (f === "sort") {
      if (typeof v !== "number" || !Number.isFinite(v)) throw new ValidationError("sort must be a number");
      v = Math.trunc(v);
    } else {
      if (v === "") v = null;
      if (v !== null && typeof v !== "string") throw new ValidationError(`${f} must be a string`);
      if (f === "due_date" && v !== null && !DATE_RE.test(String(v))) throw new ValidationError("due_date must be YYYY-MM-DD");
    }
    out[f] = v;
  }
  return out;
}

function idList(v: unknown, name: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ValidationError(`${name} must be an array of workpackage ids`);
  return [...new Set(v as string[])];
}

async function checkWps(db: D1Database, projectId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { results } = await db
    .prepare(`SELECT id FROM workpackage WHERE project_id = ? AND ${LIVE()}`)
    .bind(projectId)
    .all<{ id: string }>();
  const own = new Set(results.map((r) => r.id));
  const bad = ids.filter((id) => !own.has(id));
  if (bad.length) throw new ValidationError(`not workpackages of project ${projectId}: ${bad.join(", ")}`);
}

async function getOne(db: D1Database, projectId: string, id: string): Promise<MilestoneOut> {
  const m = (await listMilestones(db, projectId)).find((x) => x.id === id);
  if (!m) throw new NotFoundError(`milestone ${id} not found`);
  return m;
}

/** Create, or update when input.id names an existing milestone. `requires` / `unlocks` replace the stored links. */
export async function upsertMilestone(
  db: D1Database,
  projectId: string,
  input: MilestoneInput,
  by: Caller,
  expectedVersion?: number,
): Promise<MilestoneOut> {
  if (!(await db.prepare(`SELECT 1 FROM project WHERE id = ? AND ${LIVE()}`).bind(projectId).first()))
    throw new NotFoundError(`project ${projectId} not found`);
  const fields = normalise(input);
  const requires = idList(input.requires, "requires");
  const unlocks = idList(input.unlocks, "unlocks");
  await checkWps(db, projectId, [
    ...(requires ?? []),
    ...(unlocks ?? []),
    ...(typeof fields.workpackage_id === "string" ? [fields.workpackage_id] : []),
  ]);

  const existing = input.id ? await db.prepare("SELECT * FROM milestone WHERE id = ?").bind(input.id).first<MilestoneRow>() : null;
  if (existing?.deleted_at) throw new NotFoundError(`milestone ${existing.id} is in the trash; restore it first`);
  const ts = now();
  const linkStmts = (id: string, guard: { version: number } | null): D1PreparedStatement[] => {
    // On update the link writes only apply if this batch's versioned UPDATE won (same batch = same transaction).
    const where = guard ? " WHERE EXISTS (SELECT 1 FROM milestone WHERE id = ? AND version = ?)" : "";
    const g = guard ? [id, guard.version] : [];
    const out: D1PreparedStatement[] = [];
    for (const [role, list] of [
      ["requires", requires],
      ["unlocks", unlocks],
    ] as const) {
      if (list === undefined) continue;
      out.push(
        db
          .prepare(
            `DELETE FROM milestone_link WHERE milestone_id = ? AND role = ?${guard ? " AND EXISTS (SELECT 1 FROM milestone WHERE id = ? AND version = ?)" : ""}`,
          )
          .bind(id, role, ...g),
      );
      for (const wp of list)
        out.push(
          db.prepare(`INSERT INTO milestone_link (milestone_id, workpackage_id, role) SELECT ?, ?, ?${where}`).bind(id, wp, role, ...g),
        );
    }
    return out;
  };

  if (existing) {
    if (existing.project_id !== projectId) throw new ValidationError(`milestone ${existing.id} belongs to project ${existing.project_id}`);
    if (typeof expectedVersion === "number" && expectedVersion !== existing.version)
      throw new ConflictError("version conflict", await getOne(db, projectId, existing.id));
    const current = await getOne(db, projectId, existing.id);
    const next = { ...existing, ...fields } as Record<string, unknown>;
    const diff = diffFields(existing as unknown as Record<string, unknown>, next, MS_FIELDS);
    const same = (a: string[] | undefined, b: string[]) => a === undefined || [...a].sort().join() === [...b].sort().join();
    if (!same(requires, current.requires)) diff.requires = [current.requires, requires];
    if (!same(unlocks, current.unlocks)) diff.unlocks = [current.unlocks, unlocks];
    const changed = Object.keys(diff).filter((k) => (MS_FIELDS as readonly string[]).includes(k));
    if (!Object.keys(diff).length) return current;
    const res = await db.batch([
      db
        .prepare(
          `UPDATE milestone SET ${changed.map((f) => `${f} = ?, `).join("")}version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
        )
        .bind(...changed.map((f) => next[f] ?? null), ts, existing.id, existing.version),
      eventStmtIfChanged(db, {
        by,
        project_id: projectId,
        entity: "milestone",
        entity_id: existing.id,
        action: "update",
        summary: `${String(next.title)}: ${Object.keys(diff).join(", ")}`,
        diff,
      }),
      ...linkStmts(existing.id, { version: existing.version + 1 }),
      ...reachStmts(db, projectId, by),
    ]);
    if (!res[0].meta.changes) throw new ConflictError("version conflict", await getOne(db, projectId, existing.id));
    return getOne(db, projectId, existing.id);
  }

  const title = String(fields.title ?? "");
  if (!title) throw new ValidationError("title is required");
  const row: MilestoneRow = {
    id: input.id ? String(input.id) : newId(),
    project_id: projectId,
    workpackage_id: null,
    title,
    description_md: null,
    due_date: null,
    reached_at: null,
    sort: 0,
    ...(fields as Partial<MilestoneRow>),
    version: 1,
    created_at: ts,
    updated_at: ts,
  };
  const cols = ["id", "project_id", ...MS_FIELDS, "version", "created_at", "updated_at"] as const;
  await db.batch([
    db
      .prepare(`INSERT INTO milestone (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .bind(...cols.map((c) => (row as unknown as Record<string, unknown>)[c] ?? null)),
    eventStmt(db, {
      by,
      project_id: projectId,
      entity: "milestone",
      entity_id: row.id,
      action: "create",
      summary: title,
      diff: {
        ...diffFields(null, row as unknown as Record<string, unknown>, MS_FIELDS),
        requires: [null, requires ?? []],
        unlocks: [null, unlocks ?? []],
      },
    }),
    ...linkStmts(row.id, null),
    ...reachStmts(db, projectId, by),
  ]);
  return getOne(db, projectId, row.id);
}
