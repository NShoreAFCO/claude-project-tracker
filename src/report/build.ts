/**
 * Report model (spec F9): project data reduced to what a reader of a report may see. Names only for
 * people (never phone, contact note or email), no ids of other entities, no internal bookkeeping.
 */
import type { PersonRefOut } from "../types";
import { POLICY } from "../policy";
import { getProjectRow, toProjectOut } from "../data/projects";
import { listWorkpackagesOut } from "../data/workpackages";
import { listMilestones } from "../data/milestones";
import { listRisks } from "../data/risks";
import { computeProjectProgress } from "../data/progress";
import { reportLocale } from "../i18n/server";

export interface ReportWorkpackage {
  level: number;
  title: string;
  status: string;
  progress: number;
  start_date: string | null;
  end_date: string | null;
  owner: string | null;
  deliverable: string | null;
}
export interface ReportDecision {
  decision: string;
  decided_by: string | null;
  decided_at: string;
  note_md: string | null;
}
export interface ReportMilestone {
  title: string;
  due_date: string | null;
  reached_at: string | null;
  gate: boolean;
  decision_state: string;
  decisions: ReportDecision[];
}
export interface ReportRisk {
  type: string;
  title: string;
  probability: number;
  impact: number;
  score: number;
  status: string;
  owner: string | null;
  action: string | null;
  due_date: string | null;
}
export interface ReportNc {
  title: string;
  status: string;
  description_md: string | null;
  cause: string | null;
  correction: string | null;
  corrective_action: string | null;
  effectiveness_check_date: string | null;
}
export interface ReportModel {
  locale: string;
  paper: "a4" | "letter";
  /** YYYY-MM-DD the report was generated. */
  generated: string;
  project: {
    title: string;
    summary: string | null;
    status: string;
    start_date: string | null;
    target_date: string | null;
    progress: number;
    owner: string | null;
    sponsor: string | null;
    decision_maker: string | null;
  };
  objectives_md: string | null;
  scope_in_md: string | null;
  scope_out_md: string | null;
  success_criteria_md: string | null;
  closure_note_md: string | null;
  lessons_learned_md: string | null;
  workpackages: ReportWorkpackage[];
  milestones: ReportMilestone[];
  risks: ReportRisk[];
  ncs: ReportNc[];
}

const refName = (r: PersonRefOut | undefined): string | null => (!r ? null : "text" in r ? r.text : r.name);

export async function buildReport(db: D1Database, projectId: string, today = new Date().toISOString().slice(0, 10)): Promise<ReportModel> {
  const row = await getProjectRow(db, projectId);
  const [wps, milestones, risks] = await Promise.all([
    listWorkpackagesOut(db, projectId),
    listMilestones(db, projectId),
    listRisks(db, { project_id: projectId }),
  ]);
  const out = await toProjectOut(db, row, wps);

  const kids = new Map<string | null, typeof wps>();
  for (const w of wps) kids.set(w.parent_id, [...(kids.get(w.parent_id) ?? []), w]);
  const ids = new Set(wps.map((w) => w.id));
  const flat: ReportWorkpackage[] = [];
  const walk = (parent: string | null, level: number) => {
    for (const w of (kids.get(parent) ?? []).sort((a, b) => a.sort - b.sort || a.title.localeCompare(b.title))) {
      flat.push({
        level,
        title: w.code ? `${w.code} ${w.title}` : w.title,
        status: w.status,
        progress: w.progress,
        start_date: w.start_date,
        end_date: w.end_date,
        owner: refName(w.owner),
        deliverable: w.deliverable ?? null,
      });
      walk(w.id, level + 1);
    }
  };
  walk(null, 0);
  // Orphans (parent not in the live set) still appear, at top level.
  const missingParents = new Set(wps.map((w) => w.parent_id).filter((p): p is string => !!p && !ids.has(p)));
  for (const p of missingParents) walk(p, 0);

  return {
    locale: reportLocale(row),
    paper: POLICY.report?.paper === "letter" ? "letter" : "a4",
    generated: today,
    project: {
      title: row.title,
      summary: row.summary,
      status: row.status,
      start_date: row.start_date,
      target_date: row.target_date,
      progress: computeProjectProgress(row, wps),
      owner: refName(out.owner),
      sponsor: refName(out.sponsor),
      decision_maker: refName(out.decision_maker),
    },
    objectives_md: row.objectives_md ?? null,
    scope_in_md: row.scope_in_md ?? null,
    scope_out_md: row.scope_out_md ?? null,
    success_criteria_md: row.success_criteria_md ?? null,
    closure_note_md: row.closure_note_md,
    lessons_learned_md: row.lessons_learned_md,
    workpackages: flat,
    milestones: milestones.map((m) => ({
      title: m.title,
      due_date: m.due_date,
      reached_at: m.reached_at,
      gate: m.gate,
      decision_state: m.decision_state,
      decisions: m.decisions.map((d) => ({
        decision: d.decision,
        decided_by: d.decided_by?.name ?? null,
        decided_at: d.decided_at,
        note_md: d.note_md,
      })),
    })),
    risks: risks
      .filter((r) => r.type !== "nc")
      .map((r) => ({
        type: r.type,
        title: r.title,
        probability: r.probability,
        impact: r.impact,
        score: r.score,
        status: r.status,
        owner: refName(r.owner),
        action: r.action,
        due_date: r.due_date,
      })),
    ncs: risks
      .filter((r) => r.type === "nc")
      .map((r) => ({
        title: r.title,
        status: r.status,
        description_md: r.description_md,
        cause: r.nc_cause,
        correction: r.nc_correction,
        corrective_action: r.nc_corrective_action,
        effectiveness_check_date: r.nc_effectiveness_check_date,
      })),
  };
}
