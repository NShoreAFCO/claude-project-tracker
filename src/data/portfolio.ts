// Portfolio overview (spec F9, release R4.2): summary counters, upcoming deadlines, my work packages.
// Read-only. The SQL builders and the two WP lists were drafted by Copilot. Every query requires the
// child AND its project to be live (a trashed project hides its children even if they kept deleted_at NULL).
import type { ProjectRow, PersonRefOut } from "../types";
import { LIVE } from "./util";
import { isStale, staleDaysFor } from "./activity";
import { INSTANCE } from "../generated/instance";
import { POLICY } from "../policy";
import { latestDecisionSql } from "./gates";
import { riskSummaries } from "./risks";
import { personOuts, personRefOut } from "./persons";

export type Counter = { count: number; project_ids: string[] };
export type PortfolioSummary = {
  by_status: Record<string, number>;
  overdue_milestones: Counter;
  gates_awaiting_decision: Counter;
  blocked: Counter;
  stale: Counter;
  missing_target_date: Counter;
  missing_owner: Counter;
  schedule_issues: Counter;
  open_high_risks: Counter;
};

const PROJECT_STATUSES = ["idea", "active", "on_hold", "done", "abandoned"];
const counter = (project_ids: string[]): Counter => ({ count: project_ids.length, project_ids });

async function ids(db: D1Database, sql: string): Promise<string[]> {
  const { results } = await db.prepare(sql).all<{ project_id: string }>();
  return [...new Set(results.map(({ project_id }) => project_id))].sort();
}

const OPEN_PROJECTS = "p.deleted_at IS NULL AND p.status NOT IN ('done','abandoned')";

const validateToday = (today: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new Error("today must be YYYY-MM-DD");
  }
  return today;
};

export const QUERIES: Record<
  "overdue_milestones" | "gates_awaiting_decision" | "blocked" | "schedule_issues" | "missing_target_date" | "missing_owner",
  (today: string) => string
> = {
  overdue_milestones: (today) => {
    today = validateToday(today);
    return `SELECT DISTINCT p.id AS project_id FROM project p WHERE ${OPEN_PROJECTS} AND EXISTS (
      SELECT 1 FROM milestone m
      WHERE m.project_id = p.id
        AND m.deleted_at IS NULL
        AND m.due_date < '${today}'
        AND m.reached_at IS NULL
    )`;
  },

  gates_awaiting_decision: (_today) =>
    `SELECT DISTINCT p.id AS project_id FROM project p WHERE ${OPEN_PROJECTS} AND EXISTS (
      SELECT 1 FROM milestone m
      WHERE m.project_id = p.id
        AND m.deleted_at IS NULL
        AND m.gate = 1
        AND m.reached_at IS NOT NULL
        AND ${latestDecisionSql("m")} IS NULL
    )`,

  blocked: (_today) =>
    `SELECT DISTINCT p.id AS project_id FROM project p WHERE ${OPEN_PROJECTS} AND EXISTS (
      SELECT 1 FROM workpackage w
      WHERE w.project_id = p.id
        AND w.deleted_at IS NULL
        AND w.status = 'blocked'
    )`,

  schedule_issues: (_today) =>
    `SELECT DISTINCT p.id AS project_id FROM project p WHERE ${OPEN_PROJECTS} AND (
      EXISTS (
        SELECT 1 FROM workpackage w
        WHERE w.project_id = p.id
          AND w.deleted_at IS NULL
          AND w.schedule_issues IS NOT NULL
          AND w.schedule_issues != '[]'
      )
      OR EXISTS (
        SELECT 1 FROM milestone m
        WHERE m.project_id = p.id
          AND m.deleted_at IS NULL
          AND m.schedule_issues IS NOT NULL
          AND m.schedule_issues != '[]'
      )
    )`,

  missing_target_date: (_today) =>
    `SELECT DISTINCT p.id AS project_id FROM project p WHERE ${OPEN_PROJECTS} AND (
      p.target_date IS NULL OR trim(p.target_date) = ''
    )`,

  missing_owner: (_today) =>
    `SELECT DISTINCT p.id AS project_id FROM project p WHERE ${OPEN_PROJECTS} AND
      p.owner_person_id IS NULL
      AND (p.owner_text IS NULL OR trim(p.owner_text) = '')`,
};

/**
 * Portfolio counters as of `today` (YYYY-MM-DD). by_status counts all live projects; every other counter
 * covers open projects only (not done/abandoned). Stale reuses isStale/staleDaysFor, risks riskSummaries
 * (high = score >= 15), schedule issues are the stored ones ("[]" computed and clean, NULL not computed).
 */
export async function summary(db: D1Database, today: string): Promise<PortfolioSummary> {
  const statusRows = await db
    .prepare(`SELECT status, COUNT(*) AS n FROM project WHERE ${LIVE()} GROUP BY status`)
    .all<{ status: string; n: number }>();
  const by_status: Record<string, number> = Object.fromEntries(PROJECT_STATUSES.map((s) => [s, 0]));
  for (const r of statusRows.results) by_status[r.status] = Number(r.n);

  const open = await db.prepare(`SELECT * FROM project p WHERE ${OPEN_PROJECTS}`).all<ProjectRow>();
  const now = new Date(`${today}T00:00:00Z`);
  const stale = open.results
    .filter((p) => isStale(p, staleDaysFor(p.category, INSTANCE.categories.project, POLICY.stale_days), now))
    .map((p) => p.id)
    .sort();
  const risks = await riskSummaries(
    db,
    open.results.map((p) => p.id),
  );
  const highRisk = [...risks.entries()]
    .filter(([, r]) => r.max_score !== null && r.max_score >= 15)
    .map(([id]) => id)
    .sort();

  const [overdue, gates, blocked, issues, noTarget, noOwner] = await Promise.all([
    ids(db, QUERIES.overdue_milestones(today)),
    ids(db, QUERIES.gates_awaiting_decision(today)),
    ids(db, QUERIES.blocked(today)),
    ids(db, QUERIES.schedule_issues(today)),
    ids(db, QUERIES.missing_target_date(today)),
    ids(db, QUERIES.missing_owner(today)),
  ]);
  return {
    by_status,
    overdue_milestones: counter(overdue),
    gates_awaiting_decision: counter(gates),
    blocked: counter(blocked),
    stale: counter(stale),
    missing_target_date: counter(noTarget),
    missing_owner: counter(noOwner),
    schedule_issues: counter(issues),
    open_high_risks: counter(highRisk),
  };
}

export type PortfolioWp = {
  id: string;
  project_id: string;
  project_title: string;
  title: string;
  status: string;
  progress: number;
  start_date: string | null;
  end_date: string | null;
  effective_owner: PersonRefOut | null;
};

type PortfolioWpRow = {
  id: string;
  project_id: string;
  project_title: string;
  title: string;
  status: string;
  progress: number;
  start_date: string | null;
  end_date: string | null;
  owner_person_id: string | null;
  owner_text: string | null;
  project_owner_person_id: string | null;
  project_owner_text: string | null;
};

async function toPortfolioWps(db: D1Database, rows: PortfolioWpRow[]): Promise<PortfolioWp[]> {
  const people = await personOuts(
    db,
    rows.flatMap((row) => [row.owner_person_id, row.project_owner_person_id]),
  );

  return rows.map((row) => ({
    id: row.id,
    project_id: row.project_id,
    project_title: row.project_title,
    title: row.title,
    status: row.status,
    progress: row.progress,
    start_date: row.start_date,
    end_date: row.end_date,
    effective_owner:
      personRefOut(row.owner_person_id, row.owner_text, people) ??
      personRefOut(row.project_owner_person_id, row.project_owner_text, people),
  }));
}

export async function upcomingWorkpackages(db: D1Database, opts: { project_id?: string; limit?: number }): Promise<PortfolioWp[]> {
  const requestedLimit = opts.limit ?? 50;
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(200, Math.trunc(requestedLimit))) : 50;

  const params: (string | number)[] = [];
  let projectFilter = "";

  if (opts.project_id !== undefined) {
    projectFilter = " AND w.project_id = ?";
    params.push(opts.project_id);
  }

  params.push(limit);

  const result = await db
    .prepare(
      `
      SELECT
        w.id,
        w.project_id,
        p.title AS project_title,
        w.title,
        w.status,
        w.progress,
        w.start_date,
        w.end_date,
        w.owner_person_id,
        w.owner_text,
        p.owner_person_id AS project_owner_person_id,
        p.owner_text AS project_owner_text
      FROM workpackage w
      JOIN project p ON p.id = w.project_id
      WHERE ${LIVE("w")}
        AND ${LIVE("p")}
        AND w.end_date IS NOT NULL
        AND w.status NOT IN ('done', 'dropped')
        ${projectFilter}
      ORDER BY w.end_date, p.title, w.sort, w.id
      LIMIT ?
    `,
    )
    .bind(...params)
    .all<PortfolioWpRow>();

  return toPortfolioWps(db, result.results);
}

export async function mineWorkpackages(
  db: D1Database,
  personId: string | null,
  opts: {
    assigned_only?: boolean;
    sort?: "project" | "in_progress" | "start" | "end";
  },
): Promise<PortfolioWp[]> {
  if (personId === null) {
    return [];
  }

  const sort = opts.sort ?? "project";

  const projectOrder = "p.title, p.id, w.sort, w.title, w.id";
  let orderBy: string;

  switch (sort) {
    case "project":
      orderBy = projectOrder;
      break;
    case "in_progress":
      orderBy = `CASE WHEN w.status = 'doing' THEN 0 ELSE 1 END, ${projectOrder}`;
      break;
    case "start":
      orderBy = `w.start_date IS NULL, w.start_date, ${projectOrder}`;
      break;
    case "end":
      orderBy = `w.end_date IS NULL, w.end_date, ${projectOrder}`;
      break;
    default: {
      const error = new Error("sort must be project|in_progress|start|end") as Error & { status: number };
      error.status = 400;
      throw error;
    }
  }

  const ownership = opts.assigned_only
    ? "w.owner_person_id = ?"
    : `(
        w.owner_person_id = ?
        OR (
          w.owner_person_id IS NULL
          AND (w.owner_text IS NULL OR trim(w.owner_text) = '')
          AND p.owner_person_id = ?
        )
      )`;

  const params = opts.assigned_only ? [personId] : [personId, personId];

  const result = await db
    .prepare(
      `
      SELECT
        w.id,
        w.project_id,
        p.title AS project_title,
        w.title,
        w.status,
        w.progress,
        w.start_date,
        w.end_date,
        w.owner_person_id,
        w.owner_text,
        p.owner_person_id AS project_owner_person_id,
        p.owner_text AS project_owner_text
      FROM workpackage w
      JOIN project p ON p.id = w.project_id
      WHERE ${LIVE("w")}
        AND ${LIVE("p")}
        AND w.status NOT IN ('done', 'dropped')
        AND ${ownership}
      ORDER BY ${orderBy}
    `,
    )
    .bind(...params)
    .all<PortfolioWpRow>();

  return toPortfolioWps(db, result.results);
}
