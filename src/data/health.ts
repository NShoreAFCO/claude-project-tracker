// Project health for the dashboard (REST only): loads the facts of all live projects in one batch and
// feeds projectHealth. Stale, high risk and gate decision state reuse the rules of the portfolio counters.
import { INSTANCE } from "../generated/instance";
import { POLICY } from "../policy";
import { projectHealth, type Health, type HealthFacts, type HealthOptions } from "../report/health";
import { isStale, staleDaysFor, utcDayNumber } from "./activity";
import { latestDecisionSql } from "./gates";
import { LIVE } from "./util";

type ProjectFactsRow = {
  id: string;
  status: string;
  category: string | null;
  target_date: string | null;
  last_progress_at: string | null;
  created_at: string;
};
type MilestoneFactsRow = {
  project_id: string;
  title: string;
  due_date: string | null;
  reached_at: string | null;
  gate: number;
  latest: string | null;
};
type WpFactsRow = { project_id: string; code: string | null; title: string; status: string; end_date: string | null };
type RiskFactsRow = { project_id: string; title: string; score: number };

/** The health thresholds from the policy. */
export const healthOptions = (): HealthOptions => ({
  wp_late_days: POLICY.health_wp_late_days,
  gate_soon_days: POLICY.health_gate_soon_days,
});

/** Whole UTC days from the last progress (else creation) to `now`; null when no timestamp parses. */
function daysSinceActivity(p: ProjectFactsRow, now: Date): number | null {
  for (const s of [p.last_progress_at, p.created_at]) {
    if (s == null) continue;
    try {
      return utcDayNumber(now.toISOString()) - utcDayNumber(s);
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Health of each live project as of `today` (YYYY-MM-DD), keyed by project id; a closed project maps to null.
 * `projectIds` limits the load. Four queries in one batch, none per project.
 */
export async function healthByProject(db: D1Database, today: string, projectIds?: string[]): Promise<Map<string, Health | null>> {
  const out = new Map<string, Health | null>();
  if (projectIds !== undefined && projectIds.length === 0) return out;
  const filter = projectIds === undefined ? null : JSON.stringify(projectIds);
  // `?1 IS NULL` = all live projects
  const inScope = (col: string) => `(?1 IS NULL OR ${col} IN (SELECT value FROM json_each(?1)))`;

  const [projects, milestones, wps, risks] = await db.batch([
    db
      .prepare(
        `SELECT id, status, category, target_date, last_progress_at, created_at FROM project p WHERE ${LIVE("p")} AND ${inScope("p.id")}`,
      )
      .bind(filter),
    db
      .prepare(
        `SELECT m.project_id, m.title, m.due_date, m.reached_at, m.gate, ${latestDecisionSql("m")} AS latest
         FROM milestone m JOIN project p ON p.id = m.project_id
         WHERE ${LIVE("m")} AND ${LIVE("p")} AND ${inScope("m.project_id")}`,
      )
      .bind(filter),
    db
      .prepare(
        `SELECT w.project_id, w.code, w.title, w.status, w.end_date
         FROM workpackage w JOIN project p ON p.id = w.project_id
         WHERE ${LIVE("w")} AND ${LIVE("p")} AND ${inScope("w.project_id")}`,
      )
      .bind(filter),
    db
      .prepare(
        `SELECT r.project_id, r.title, r.score FROM risk r JOIN project p ON p.id = r.project_id
         WHERE ${LIVE("r")} AND ${LIVE("p")} AND r.status != 'closed' AND r.type != 'opportunity' AND r.score >= 15
           AND ${inScope("r.project_id")}`,
      )
      .bind(filter),
  ]);

  const facts = new Map<string, HealthFacts>();
  const now = new Date(`${today}T00:00:00Z`);
  for (const p of projects.results as ProjectFactsRow[]) {
    facts.set(p.id, {
      status: p.status,
      target_date: p.target_date,
      milestones: [],
      workpackages: [],
      high_risks: [],
      stale: isStale(p, staleDaysFor(p.category, INSTANCE.categories.project, POLICY.stale_days), now),
      days_since_activity: daysSinceActivity(p, now),
    });
  }
  for (const m of milestones.results as MilestoneFactsRow[]) {
    facts.get(m.project_id)?.milestones.push({
      code: null, // milestones carry no code
      title: m.title,
      due_date: m.due_date,
      reached: m.reached_at !== null,
      gate: m.gate === 1,
      decided: m.latest !== null,
    });
  }
  for (const w of wps.results as WpFactsRow[]) {
    facts.get(w.project_id)?.workpackages.push({ code: w.code, title: w.title, status: w.status, end_date: w.end_date });
  }
  for (const r of risks.results as RiskFactsRow[]) {
    facts.get(r.project_id)?.high_risks.push({ title: r.title, score: r.score });
  }

  const options = healthOptions();
  for (const [id, f] of facts) out.set(id, projectHealth(f, today, options));
  return out;
}
