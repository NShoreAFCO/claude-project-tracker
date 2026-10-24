import type { BranchRow, ContextDocRow, EventRow, ProjectRow, ScoreRow, TokenCostRow, WorkpackageRow } from "../types";
import { buildWpTree, computeProjectProgress, leafCounts } from "./progress";
import { QUALIFIES, listMilestones, lockedWpIds } from "./milestones";
import { PROJECT_CATEGORIES, checkCategory } from "./categories";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  diffFields,
  eventStmt,
  eventStmtIfChanged,
  now,
  parseJsonArray,
  slugify,
  toJsonArray,
} from "./util";

export const PROJECT_FIELDS = [
  "title",
  "summary",
  "description_md",
  "status",
  "origin",
  "repo_url",
  "local_path",
  "context_file",
  "session_id",
  "start_date",
  "target_date",
  "progress_mode",
  "progress_manual",
  "tags",
  "category",
] as const;
type ProjectField = (typeof PROJECT_FIELDS)[number];
export type ProjectInput = Partial<Record<ProjectField, unknown>> & { id?: string };

const STATUSES = ["idea", "active", "on_hold", "done", "abandoned"];
const ORIGINS = ["claude-web", "claude-code", "manual", "mixed"];
const MODES = ["derived", "manual"];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type ProjectCard = {
  id: string;
  title: string;
  summary: string | null;
  status: string;
  origin: string;
  progress: number;
  start_date: string | null;
  target_date: string | null;
  tags: string[];
  category: string | null;
  wp_counts: { open: number; started: number; done: number };
  next_milestone: { id: string; title: string; due_date: string | null } | null;
  last_activity: string | null;
  open_branches: number;
  context_docs: number;
  blocked: string[];
  repo_url: string | null;
  local_path: string | null;
  session_id: string | null;
  version: number;
};

/** Validate and normalise the given fields; returns column values (tags as JSON text). */
function normalise(input: ProjectInput): Partial<Record<ProjectField, unknown>> {
  const out: Partial<Record<ProjectField, unknown>> = {};
  for (const f of PROJECT_FIELDS) {
    if (!(f in input) || input[f] === undefined) continue;
    let v = input[f];
    if (f === "tags") v = toJsonArray(v);
    else if (f === "category") v = checkCategory(v, PROJECT_CATEGORIES);
    else if (f === "progress_manual") {
      if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100))
        throw new ValidationError("progress_manual must be 0..100");
    } else if (v !== null && typeof v !== "string") throw new ValidationError(`${f} must be a string`);
    if (f === "title" && !String(v ?? "").trim()) throw new ValidationError("title is required");
    if (f === "status" && !STATUSES.includes(String(v))) throw new ValidationError(`status must be one of ${STATUSES.join("|")}`);
    if (f === "origin" && !ORIGINS.includes(String(v))) throw new ValidationError(`origin must be one of ${ORIGINS.join("|")}`);
    if (f === "progress_mode" && !MODES.includes(String(v))) throw new ValidationError(`progress_mode must be one of ${MODES.join("|")}`);
    if ((f === "start_date" || f === "target_date") && v !== null && v !== "" && !DATE_RE.test(String(v)))
      throw new ValidationError(`${f} must be YYYY-MM-DD`);
    if ((f === "start_date" || f === "target_date") && v === "") v = null;
    out[f] = typeof v === "string" && f === "title" ? v.trim() : v;
  }
  return out;
}

export type ProjectOut = Omit<ProjectRow, "tags"> & { tags: string[] };

/** Client-facing project: tags parsed from their JSON column. */
export const toProjectOut = (row: ProjectRow): ProjectOut => ({ ...row, tags: parseJsonArray(row.tags) });

export async function getProjectRow(db: D1Database, id: string): Promise<ProjectRow> {
  const p = await db.prepare("SELECT * FROM project WHERE id = ?").bind(id).first<ProjectRow>();
  if (!p) throw new NotFoundError(`project ${id} not found`);
  return p;
}

export async function listProjects(
  db: D1Database,
  filter: { status?: string; tag?: string; category?: string } = {},
): Promise<ProjectCard[]> {
  const [projects, wps, branches, docs, events, ms] = await db.batch([
    filter.status
      ? db.prepare("SELECT * FROM project WHERE status = ? ORDER BY updated_at DESC").bind(filter.status)
      : db.prepare("SELECT * FROM project ORDER BY updated_at DESC"),
    db.prepare("SELECT * FROM workpackage"),
    db.prepare("SELECT project_id, COUNT(*) AS n FROM branch WHERE status = 'open' GROUP BY project_id"),
    db.prepare("SELECT project_id, COUNT(*) AS n FROM context_doc GROUP BY project_id"),
    db.prepare("SELECT project_id, MAX(ts) AS ts FROM event WHERE project_id IS NOT NULL GROUP BY project_id"),
    db.prepare(
      `SELECT m.project_id, m.id, m.title, m.due_date FROM milestone m WHERE NOT (${QUALIFIES}) ORDER BY m.due_date IS NULL, m.due_date, m.sort, m.title`,
    ),
  ]);
  const nextMs = new Map<string, { id: string; title: string; due_date: string | null }>();
  for (const m of ms.results as Array<{ project_id: string; id: string; title: string; due_date: string | null }>)
    if (!nextMs.has(m.project_id)) nextMs.set(m.project_id, { id: m.id, title: m.title, due_date: m.due_date });
  const wpBy = new Map<string, WorkpackageRow[]>();
  for (const w of wps.results as WorkpackageRow[]) wpBy.set(w.project_id, [...(wpBy.get(w.project_id) ?? []), w]);
  const count = (rows: unknown[]) => new Map((rows as Array<{ project_id: string; n: number }>).map((r) => [r.project_id, r.n]));
  const openBranches = count(branches.results);
  const docCount = count(docs.results);
  const lastEvent = new Map((events.results as Array<{ project_id: string; ts: string }>).map((r) => [r.project_id, r.ts]));
  const tag = filter.tag?.toLowerCase();

  return (projects.results as ProjectRow[])
    .map((p) => {
      const list = wpBy.get(p.id) ?? [];
      const ev = lastEvent.get(p.id) ?? null;
      return {
        id: p.id,
        title: p.title,
        summary: p.summary,
        status: p.status,
        origin: p.origin,
        progress: computeProjectProgress(p, list),
        start_date: p.start_date,
        target_date: p.target_date,
        tags: parseJsonArray(p.tags),
        category: p.category,
        wp_counts: leafCounts(list),
        next_milestone: nextMs.get(p.id) ?? null,
        last_activity: ev && ev > p.updated_at ? ev : p.updated_at,
        open_branches: openBranches.get(p.id) ?? 0,
        context_docs: docCount.get(p.id) ?? 0,
        blocked: list
          .filter((w) => (w.status === "blocked" || w.status === "waiting") && w.blocked_by?.trim())
          .map((w) => w.blocked_by!.trim()),
        repo_url: p.repo_url,
        local_path: p.local_path,
        session_id: p.session_id,
        version: p.version,
      };
    })
    .filter((c) => !tag || c.tags.some((t) => t.toLowerCase() === tag))
    .filter((c) => !filter.category || (filter.category === "none" ? c.category === null : c.category === filter.category));
}

export async function getProjectDetail(db: D1Database, id: string) {
  const project = await getProjectRow(db, id);
  const [wps, branches, scores, scoreCount, cost, costEntries, events, ctx] = await db.batch([
    db.prepare("SELECT * FROM workpackage WHERE project_id = ? ORDER BY sort, title").bind(id),
    db.prepare("SELECT * FROM branch WHERE project_id = ? ORDER BY last_activity DESC").bind(id),
    db
      .prepare(
        "SELECT s.* FROM score s JOIN (SELECT criterion, MAX(recorded_at) AS m FROM score WHERE project_id = ? GROUP BY criterion) l ON s.criterion = l.criterion AND s.recorded_at = l.m WHERE s.project_id = ? ORDER BY s.criterion",
      )
      .bind(id, id),
    db.prepare("SELECT COUNT(*) AS n FROM score WHERE project_id = ?").bind(id),
    db
      .prepare(
        "SELECT COALESCE(SUM(claude_tokens), 0) AS claude_tokens, COALESCE(SUM(copilot_prompts), 0) AS copilot_prompts FROM token_cost WHERE project_id = ?",
      )
      .bind(id),
    db.prepare("SELECT * FROM token_cost WHERE project_id = ? ORDER BY recorded_at DESC LIMIT 20").bind(id),
    db.prepare("SELECT * FROM event WHERE project_id = ? ORDER BY id DESC LIMIT 10").bind(id),
    db
      .prepare(
        "SELECT id, owner_kind, owner_id, title, slug, source, bytes, version, pinned, sort, updated_at, updated_by FROM context_doc WHERE project_id = ? ORDER BY owner_kind, owner_id, pinned DESC, sort, title",
      )
      .bind(id),
  ]);
  const wpRows = wps.results as WorkpackageRow[];
  const milestones = await listMilestones(db, id);
  const totals = cost.results[0] as { claude_tokens: number; copilot_prompts: number };
  return {
    project: toProjectOut(project),
    progress: computeProjectProgress(project, wpRows),
    workpackages: buildWpTree(wpRows, { locked: lockedWpIds(milestones) }),
    milestones,
    branches: branches.results as BranchRow[],
    scores: scores.results as ScoreRow[],
    score_history_count: (scoreCount.results[0] as { n: number }).n,
    token_cost: { ...totals, entries: costEntries.results as TokenCostRow[] },
    events: events.results as EventRow[],
    context_index: ctx.results as Array<Omit<ContextDocRow, "content_md" | "project_id" | "filename" | "created_at" | "created_by">>,
  };
}

export async function createProject(db: D1Database, input: ProjectInput, actor: string): Promise<ProjectOut> {
  const fields = normalise(input);
  const title = String(fields.title ?? "").trim();
  if (!title) throw new ValidationError("title is required");
  if (input.id !== undefined && !ID_RE.test(String(input.id))) throw new ValidationError("id must match ^[a-z0-9][a-z0-9-]{0,62}$");

  const base = input.id ? String(input.id) : slugify(title);
  let id = base;
  for (let n = 2; await db.prepare("SELECT 1 FROM project WHERE id = ?").bind(id).first(); n++) id = `${base}-${n}`;

  const ts = now();
  const row: ProjectRow = {
    id,
    title,
    summary: null,
    description_md: null,
    status: "active",
    origin: "manual",
    repo_url: null,
    local_path: null,
    context_file: null,
    session_id: null,
    start_date: null,
    target_date: null,
    progress_mode: "derived",
    progress_manual: null,
    tags: null,
    category: null,
    ...(fields as Partial<ProjectRow>),
    version: 1,
    created_at: ts,
    updated_at: ts,
  };
  const cols = ["id", ...PROJECT_FIELDS, "version", "created_at", "updated_at"] as const;
  await db.batch([
    db
      .prepare(`INSERT INTO project (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .bind(...cols.map((c) => (row as unknown as Record<string, unknown>)[c] ?? null)),
    eventStmt(db, {
      actor,
      project_id: id,
      entity: "project",
      entity_id: id,
      action: "create",
      summary: title,
      diff: diffFields(null, row as unknown as Record<string, unknown>, PROJECT_FIELDS),
    }),
  ]);
  return toProjectOut(await getProjectRow(db, id));
}

export async function updateProject(
  db: D1Database,
  id: string,
  patch: ProjectInput,
  actor: string,
  expectedVersion?: number,
): Promise<ProjectOut> {
  const current = await getProjectRow(db, id);
  if (typeof expectedVersion === "number" && expectedVersion !== current.version)
    throw new ConflictError("version conflict", toProjectOut(current));
  const fields = normalise(patch);
  const next = { ...current, ...fields } as Record<string, unknown>;
  const diff = diffFields(current as unknown as Record<string, unknown>, next, PROJECT_FIELDS);
  const changed = Object.keys(diff);
  if (!changed.length) return toProjectOut(current);

  const res = await db.batch([
    db
      .prepare(
        `UPDATE project SET ${changed.map((f) => `${f} = ?`).join(", ")}, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
      )
      .bind(...changed.map((f) => next[f] ?? null), now(), id, current.version),
    eventStmtIfChanged(db, {
      actor,
      project_id: id,
      entity: "project",
      entity_id: id,
      action: "update",
      summary: changed.join(", "),
      diff,
    }),
  ]);
  if (!res[0].meta.changes) throw new ConflictError("version conflict", toProjectOut(await getProjectRow(db, id)));
  return toProjectOut(await getProjectRow(db, id));
}
