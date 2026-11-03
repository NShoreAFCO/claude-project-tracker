// My-dashboard data (QoL D4/D5): per-person dashboard prefs and the open gates list.
import type { Caller, PersonRefOut } from "../types";
import { gateClosedSql, latestDecisionSql } from "./gates";
import { personOuts, personRefOut } from "./persons";
import { eventStmt, ForbiddenError, LIVE, now, utf8Bytes, ValidationError } from "./util";

export const VIEW_KINDS = ["my_tasks", "my_human_tasks", "my_decisions", "all_decisions", "all_human_tasks", "active_projects"] as const;
export type DashView = { id: string; name: string; kind: (typeof VIEW_KINDS)[number]; project_id?: string | null };
export type DashPrefs = { version: 1; views: DashView[]; active_projects: string[] };
export const MAX_PREFS_BYTES = 8192;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validates and normalises a prefs object (throws ValidationError). */
export function validatePrefs(input: unknown): DashPrefs {
  if (!isObj(input)) throw new ValidationError("prefs must be an object");
  if (utf8Bytes(JSON.stringify(input)) > MAX_PREFS_BYTES) throw new ValidationError(`prefs are larger than ${MAX_PREFS_BYTES} bytes`);
  if (input.version !== 1) throw new ValidationError("prefs.version must be 1");
  const views = input.views ?? [];
  const active = input.active_projects ?? [];
  if (!Array.isArray(views) || views.length > 20) throw new ValidationError("prefs.views must be a list of at most 20 items");
  if (!Array.isArray(active) || active.length > 100) throw new ValidationError("prefs.active_projects must be a list of at most 100 ids");
  const outViews = views.map((v, i): DashView => {
    if (!isObj(v)) throw new ValidationError(`prefs.views[${i}] must be an object`);
    if (typeof v.id !== "string" || !v.id || v.id.length > 40) throw new ValidationError(`prefs.views[${i}].id must be a string of 1-40 characters`);
    if (typeof v.name !== "string" || !v.name || v.name.length > 80) throw new ValidationError(`prefs.views[${i}].name must be a string of 1-80 characters`);
    if (typeof v.kind !== "string" || !(VIEW_KINDS as readonly string[]).includes(v.kind))
      throw new ValidationError(`prefs.views[${i}].kind must be one of ${VIEW_KINDS.join("|")}`);
    if (v.project_id != null && typeof v.project_id !== "string") throw new ValidationError(`prefs.views[${i}].project_id must be a string or null`);
    const out: DashView = { id: v.id, name: v.name, kind: v.kind as DashView["kind"] };
    if (v.project_id !== undefined) out.project_id = v.project_id as string | null;
    return out;
  });
  if (active.some((a) => typeof a !== "string" || !a || a.length > 100)) throw new ValidationError("prefs.active_projects must hold project ids (strings)");
  return { version: 1, views: outViews, active_projects: active as string[] };
}

const defaultPrefs = (): DashPrefs => ({ version: 1, views: [], active_projects: [] });

function needPerson(by: Caller): string {
  if (!by.personId) throw new ForbiddenError("this is for people with a dashboard login; this caller has no person");
  return by.personId;
}

/** The caller's own prefs; unknown project ids are dropped. */
export async function getDashboardPrefs(db: D1Database, by: Caller): Promise<{ prefs: DashPrefs; version: 1 }> {
  const pid = needPerson(by);
  const row = await db.prepare(`SELECT dashboard_prefs FROM person WHERE id = ? AND ${LIVE()}`).bind(pid).first<{ dashboard_prefs: string | null }>();
  let prefs = defaultPrefs();
  if (row?.dashboard_prefs) {
    try {
      prefs = validatePrefs(JSON.parse(row.dashboard_prefs));
    } catch {
      prefs = defaultPrefs();
    }
  }
  if (prefs.active_projects.length) {
    const { results } = await db
      .prepare(`SELECT id FROM project WHERE ${LIVE()} AND id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(prefs.active_projects))
      .all<{ id: string }>();
    const known = new Set(results.map((r) => r.id));
    prefs = { ...prefs, active_projects: prefs.active_projects.filter((id) => known.has(id)) };
  }
  return { prefs, version: 1 };
}

/** Stores the caller's own prefs. The event carries a summary only, never the prefs body. */
export async function putDashboardPrefs(db: D1Database, input: unknown, by: Caller): Promise<{ prefs: DashPrefs; version: 1 }> {
  const pid = needPerson(by);
  const prefs = validatePrefs(input);
  await db.batch([
    db.prepare(`UPDATE person SET dashboard_prefs = ?, updated_at = ? WHERE id = ? AND ${LIVE()}`).bind(JSON.stringify(prefs), now(), pid),
    eventStmt(db, {
      by,
      project_id: null,
      entity: "person",
      entity_id: pid,
      action: "update",
      summary: `dashboard preferences: ${prefs.views.length} views, ${prefs.active_projects.length} active projects`,
    }),
  ]);
  return getDashboardPrefs(db, by);
}

export type OpenGate = {
  milestone_id: string;
  title: string;
  wp_code: string | null;
  project_id: string;
  project_title: string;
  due_date: string | null;
  reached: boolean;
  decision_state: string | null;
  decision_maker: PersonRefOut | null;
};

/** Closed live gates of open projects; scope=me limits to projects where the caller is the decision maker. */
export async function openGates(db: D1Database, by: Caller, opts: { scope: "me" | "all"; project_id?: string }): Promise<OpenGate[]> {
  const me = needPerson(by);
  const params: string[] = [];
  let extra = "";
  if (opts.scope === "me") {
    extra += " AND p.decision_maker_person_id = ?";
    params.push(me);
  }
  if (opts.project_id !== undefined) {
    extra += " AND m.project_id = ?";
    params.push(opts.project_id);
  }
  const { results } = await db
    .prepare(
      `SELECT m.id AS milestone_id, m.title, w.code AS wp_code, m.project_id, p.title AS project_title, m.due_date,
        m.reached_at IS NOT NULL AS reached, ${latestDecisionSql("m")} AS decision_state,
        p.decision_maker_person_id AS dm_id, p.decision_maker_text AS dm_text
       FROM milestone m
       JOIN project p ON p.id = m.project_id
       LEFT JOIN workpackage w ON w.id = m.workpackage_id AND w.deleted_at IS NULL
       WHERE ${gateClosedSql("m")} AND ${LIVE("p")} AND p.status NOT IN ('done', 'abandoned')${extra}
       ORDER BY m.due_date IS NULL, m.due_date, p.title, m.sort, m.id`,
    )
    .bind(...params)
    .all<{
      milestone_id: string;
      title: string;
      wp_code: string | null;
      project_id: string;
      project_title: string;
      due_date: string | null;
      reached: number;
      decision_state: string | null;
      dm_id: string | null;
      dm_text: string | null;
    }>();
  const people = await personOuts(db, results.map((r) => r.dm_id));
  return results.map((r) => ({
    milestone_id: r.milestone_id,
    title: r.title,
    wp_code: r.wp_code,
    project_id: r.project_id,
    project_title: r.project_title,
    due_date: r.due_date,
    reached: !!r.reached,
    decision_state: r.decision_state,
    decision_maker: personRefOut(r.dm_id, r.dm_text, people),
  }));
}
