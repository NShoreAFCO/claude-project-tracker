import type { getProjectDetail } from "./projects";
import { LIVE, NotFoundError, ValidationError, now } from "./util";

type Detail = Awaited<ReturnType<typeof getProjectDetail>>;
type WpNode = Detail["workpackages"][number];

export type ProjectView = "full" | "summary" | "outline";
export interface ProjectViewOptions {
  view?: ProjectView;
  status?: WpNode["status"][];
  wp?: string;
  depth?: number;
}

/** How get_project wp= matches a work package: by code, or by id. (The wp_code locator below matches the code only.) */
export const matchesWp = (key: string) => (w: { id: string; code?: string | null }) => w.code === key || w.id === key;

/**
 * Resolves a work package code to the id of the one live work package of that project it names.
 * Not found (unknown, trashed or in another project) is a NotFoundError; codes are not unique, so two matches are refused.
 */
export async function resolveWpCode(db: D1Database, projectId: string, code: string): Promise<string> {
  const rows = await db
    .prepare(`SELECT id, code FROM workpackage WHERE project_id = ? AND ${LIVE()} AND code = ?`)
    .bind(projectId, code)
    .all<{ id: string; code: string | null }>();
  const hits = rows.results;
  if (!hits.length) throw new NotFoundError(`work package ${code} not found in project ${projectId}`);
  if (hits.length > 1) throw new ValidationError(`work package code ${code} is ambiguous in project ${projectId}: ${hits.map((w) => w.id).join(", ")}; give the id`);
  return hits[0].id;
}

const flatten = (nodes: WpNode[]): WpNode[] => nodes.flatMap((n) => [n, ...flatten(n.children as WpNode[])]);
const isOverdue = (w: WpNode, today: string) => w.status !== "done" && w.status !== "dropped" && !!w.end_date && w.end_date < today;

const ownerLabel = (o: WpNode["effective_owner"]) => (o && "initials" in o ? o.initials : (o?.text ?? null));

// Allow-lists: a new work package or milestone column stays out of the cheap views until added here.
const outlineRow = (w: WpNode, today: string) => ({
  id: w.id,
  code: w.code,
  parent_id: w.parent_id,
  title: w.title,
  status: w.status,
  progress: w.effective_progress,
  owner: ownerLabel(w.effective_owner),
  start_date: w.start_date,
  end_date: w.end_date,
  overdue: isOverdue(w, today),
  blocked_by: w.blocked_by,
  waiting_reason: w.waiting_reason,
  gate_locked: w.gate_locked,
  version: w.version,
});

const milestoneRow = (m: Detail["milestones"][number]) => ({
  id: m.id,
  title: m.title,
  due_date: m.due_date,
  reached_at: m.reached_at,
  gate: !!m.gate,
  critical: m.critical,
});

/** MCP views: rows nested in a project result do not repeat the project id. */
const dropProjectId = <T extends { project_id?: unknown; children?: unknown }>(w: T): T => {
  const { project_id: _p, ...rest } = w;
  const kids = (w.children as T[] | undefined)?.map(dropProjectId);
  return (kids ? { ...rest, children: kids } : rest) as T;
};

/** view=full keeps this many of the newest branches and context index rows. */
const FULL_KEEP = 20;
const newest = <T>(rows: T[], at: (r: T) => string | null | undefined) => ({
  total: rows.length,
  rows: [...rows].sort((a, b) => (at(b) ?? "").localeCompare(at(a) ?? "")).slice(0, FULL_KEEP),
});

const header = (d: Detail) => ({
  id: d.project.id,
  title: d.project.title,
  status: d.project.status,
  target_date: d.project.target_date,
  version: d.project.version,
});

/** Cuts a get_project result down for token-sensitive callers. Works on the redacted detail, so viewers lose nothing extra. */
export function shapeProjectDetail(detail: Detail, opts: ProjectViewOptions = {}) {
  const { view = "summary", status, wp, depth = 1 } = opts;
  if (status && view !== "outline" && wp === undefined) throw new ValidationError("status needs view=outline or wp");
  const items = flatten(detail.workpackages);
  const today = now().slice(0, 10);
  if (wp !== undefined) {
    const node = items.find(matchesWp(wp));
    if (!node) throw new NotFoundError(`work package ${wp} not found in project ${detail.project.id}`);
    const rows: Array<ReturnType<typeof outlineRow> & { depth: number }> = [];
    const walk = (n: WpNode, d: number) => {
      for (const c of n.children as WpNode[]) {
        if (!status || status.includes(c.status)) rows.push({ ...outlineRow(c, today), depth: d });
        if (d < depth) walk(c, d + 1);
      }
    };
    walk(node, 1);
    const { children: _c, ...own } = dropProjectId(node);
    return { project: header(detail), workpackage: own, children: rows };
  }
  if (view === "full") {
    const branches = newest(detail.branches, (b) => b.last_activity);
    const ctx = newest(detail.context_index, (c) => c.updated_at);
    return {
      ...detail,
      workpackages: detail.workpackages.map(dropProjectId),
      milestones: detail.milestones.map(dropProjectId),
      branches: branches.rows,
      context_index: ctx.rows,
      ...(branches.total > FULL_KEEP ? { branches_total: branches.total } : {}),
      ...(ctx.total > FULL_KEEP ? { context_total: ctx.total } : {}),
    };
  }
  if (view === "outline") {
    const rows = status ? items.filter((w) => status.includes(w.status)) : items;
    return { project: header(detail), progress: detail.progress, workpackages: rows.map((w) => outlineRow(w, today)) };
  }
  const counts = { items: items.length, todo: 0, doing: 0, blocked: 0, waiting: 0, done: 0, dropped: 0, overdue: 0 };
  for (const w of items) {
    counts[w.status]++;
    if (isOverdue(w, today)) counts.overdue++;
  }
  return {
    project: header(detail),
    progress: detail.progress,
    counts,
    milestones: detail.milestones.map(milestoneRow),
    risk_summary: detail.risk_summary,
    context_index: detail.context_index.map((c) => ({ slug: c.slug, title: c.title, owner_kind: c.owner_kind, owner_id: c.owner_id, bytes: c.bytes, status: c.status })),
  };
}
