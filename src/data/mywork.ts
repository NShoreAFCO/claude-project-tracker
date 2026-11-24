// "My work" feed: recent changes on what is mine (read only).
import type { Caller, EventOut } from "../types";
import { mineOwnership } from "./portfolio";
import { ForbiddenError, LIVE } from "./util";

export type RecentChange = EventOut & { project_title: string; wp_code: string | null };

/**
 * Events of the last `days` days on my work: work packages `mineWorkpackages` would return (done and dropped ones
 * included), milestones of projects where I am the decision maker, and projects I own. Live projects only, and
 * never my own actions. Newest first. One query.
 */
export async function recentForMe(
  db: D1Database,
  by: Caller,
  opts: { days?: number; limit?: number; assigned_only?: boolean; project_id?: string } = {},
): Promise<RecentChange[]> {
  if (!by.personId) throw new ForbiddenError("this is for people with a dashboard login; this caller has no person");
  const me = by.personId;
  const days = Math.min(Math.max(Math.trunc(opts.days ?? 7), 1), 30);
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20), 1), 100);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const own = mineOwnership(me, opts.assigned_only);

  const params: (string | number)[] = [since, me, by.actor, ...own.params, me, me];
  let projectFilter = "";
  if (opts.project_id !== undefined) {
    projectFilter = " AND e.project_id = ?";
    params.push(opts.project_id);
  }
  params.push(limit);

  const { results } = await db
    .prepare(
      `SELECT e.*, pe.name AS person_name, p.title AS project_title, w.code AS wp_code
       FROM event e
       JOIN project p ON p.id = e.project_id AND ${LIVE("p")}
       LEFT JOIN workpackage w ON e.entity = 'workpackage' AND w.id = e.entity_id AND w.project_id = p.id AND ${LIVE("w")}
       LEFT JOIN milestone m ON e.entity = 'milestone' AND m.id = e.entity_id AND m.project_id = p.id AND ${LIVE("m")}
       LEFT JOIN person pe ON pe.id = e.person_id
       WHERE e.ts >= ?
         AND (e.person_id IS NULL OR e.person_id <> ?)
         AND e.actor <> ?
         AND (
           (w.id IS NOT NULL AND ${own.sql})
           OR (m.id IS NOT NULL AND p.decision_maker_person_id = ?)
           OR (e.entity = 'project' AND e.entity_id = p.id AND p.owner_person_id = ?)
         )${projectFilter}
       ORDER BY e.id DESC
       LIMIT ?`,
    )
    .bind(...params)
    .all<RecentChange>();
  return results;
}
