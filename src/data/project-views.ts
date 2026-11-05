import type { getProjectDetail } from "./projects";
import { NotFoundError, ValidationError, now } from "./util";

type Detail = Awaited<ReturnType<typeof getProjectDetail>>;
type WpNode = Detail["workpackages"][number];

export type ProjectView = "full" | "summary" | "outline";
export interface ProjectViewOptions {
  view?: ProjectView;
  status?: WpNode["status"][];
  wp?: string;
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

const header = (d: Detail) => ({
  id: d.project.id,
  title: d.project.title,
  status: d.project.status,
  target_date: d.project.target_date,
  version: d.project.version,
});

/** Cuts a get_project result down for token-sensitive callers. Works on the redacted detail, so viewers lose nothing extra. */
export function shapeProjectDetail(detail: Detail, opts: ProjectViewOptions = {}) {
  const { view = "full", status, wp } = opts;
  if (status && view !== "outline") throw new ValidationError("status needs view=outline");
  const items = flatten(detail.workpackages);
  if (wp !== undefined) {
    const workpackage = items.find((w) => w.code === wp || w.id === wp);
    if (!workpackage) throw new NotFoundError(`work package ${wp} not found in project ${detail.project.id}`);
    return { project: header(detail), workpackage };
  }
  if (view === "full") return detail;
  const today = now().slice(0, 10);
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
