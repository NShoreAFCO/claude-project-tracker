import type {
  BranchRow,
  Caller,
  ContextDocRow,
  EventOut,
  PersonRefOut,
  ProjectRow,
  ScoreRow,
  TokenCostRow,
  WorkpackageRow,
  WriteWarning,
} from "../types";
import { buildWpTree, computeProjectProgress, leafCounts, type WpCounts } from "./progress";
import { QUALIFIES, listMilestones, lockedWpIds } from "./milestones";
import { PROJECT_CATEGORIES, checkCategory } from "./categories";
import { personOuts, personRefInput, personRefOut, refInitials } from "./persons";
import { withPersonOuts } from "./workpackages";
import { ensureSchedule, snapMs, snapWp } from "./schedule";
import { criticalPath } from "./critical-path";
import {
  baselineFields,
  baselineItemMap,
  latestBaselineItemsStmt,
  latestBaselineStmt,
  type BaselineItem,
  type BaselineRef,
} from "./baselines";
import {
  OPEN_WP_SQL,
  closureError,
  closureMissing,
  isClosedProjectStatus,
  openWorkpackages,
  openWorkpackagesError,
  projectFlags,
  projectLinks,
} from "./rules";
import {
  ConflictError,
  LIVE,
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
  "closure_note_md",
  "lessons_learned_md",
  "schedule_strict",
] as const;
type ProjectField = (typeof PROJECT_FIELDS)[number];
/** Person-or-text roles of a project; each is stored as <role>_person_id or <role>_text. */
const PERSON_ROLES = ["owner", "sponsor", "decision_maker"] as const;
type PersonRole = (typeof PERSON_ROLES)[number];
const PERSON_COLS = [
  "owner_person_id",
  "owner_text",
  "sponsor_person_id",
  "sponsor_text",
  "decision_maker_person_id",
  "decision_maker_text",
] as const;
type PersonCol = (typeof PERSON_COLS)[number];
/** Columns written by create/update and diffed into events. */
const WRITE_COLS = [...PROJECT_FIELDS, ...PERSON_COLS] as const;
export type ProjectInput = Partial<Record<ProjectField | PersonRole, unknown>> & { id?: string };

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
  owner_initials: string | null;
  /** open = todo, in_progress = doing, waiting_blocked = waiting + blocked; started = in_progress (alias until the UI moves). */
  wp_counts: WpCounts;
  stalled_blocked: boolean;
  closure_due: boolean;
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
    else if (f === "schedule_strict") {
      // true/false, or null to follow the policy default (spec F4)
      if (v !== null && typeof v !== "boolean") throw new ValidationError("schedule_strict must be true, false or null");
      v = v === null ? null : v ? 1 : 0;
    } else if (f === "category") v = checkCategory(v, PROJECT_CATEGORIES);
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

export type ProjectOut = Omit<ProjectRow, "tags"> & {
  tags: string[];
  owner: PersonRefOut;
  sponsor: PersonRefOut;
  decision_maker: PersonRefOut;
  /** Any top-level WP is blocked (status unchanged). */
  stalled_blocked: boolean;
  /** 100 % derived progress, all WPs done (or dropped), project not yet closed. */
  closure_due: boolean;
  /** Projects this one continues / its follow-up projects (project_link kind "follows"). */
  follows: string[];
  followed_by: string[];
};
/** Write result: the project plus non-blocking warnings. */
export type ProjectWriteOut = ProjectOut & { warnings: WriteWarning[] };

/** Derived progress regardless of the project's progress mode (closure_due looks at the WPs). */
const derivedProgress = (wps: WorkpackageRow[]): number => computeProjectProgress({ progress_mode: "derived", progress_manual: null }, wps);

/**
 * Client-facing project: tags parsed from their JSON column, person fields as chips or text, derived
 * flags and follow-up links. `wps` are the project's work packages when the caller already has them.
 */
export async function toProjectOut(db: D1Database, row: ProjectRow, wps?: WorkpackageRow[]): Promise<ProjectOut> {
  const people = await personOuts(db, [row.owner_person_id, row.sponsor_person_id, row.decision_maker_person_id]);
  const list =
    wps ?? (await db.prepare(`SELECT * FROM workpackage WHERE project_id = ? AND ${LIVE()}`).bind(row.id).all<WorkpackageRow>()).results;
  return {
    ...row,
    tags: parseJsonArray(row.tags),
    owner: personRefOut(row.owner_person_id, row.owner_text, people),
    sponsor: personRefOut(row.sponsor_person_id, row.sponsor_text, people),
    decision_maker: personRefOut(row.decision_maker_person_id, row.decision_maker_text, people),
    ...projectFlags(row.status, list, derivedProgress),
    ...(await projectLinks(db, row.id)),
  };
}

/** Resolve the person-or-text inputs of a project into their column values (only the given ones). */
async function personCols(db: D1Database, input: ProjectInput): Promise<Partial<Record<PersonCol, string | null>>> {
  const out: Partial<Record<PersonCol, string | null>> = {};
  for (const r of PERSON_ROLES) {
    const ref = await personRefInput(db, input[r], r);
    if (!ref) continue;
    out[`${r}_person_id`] = ref.person_id;
    out[`${r}_text`] = ref.text;
  }
  return out;
}

/**
 * Fields a project needs before it may be `active` (spec F1; F12 adds the target date for some types).
 * Returned names are API field names, so errors and warnings name what to fill in.
 */
function missingForActive(row: Pick<ProjectRow, "owner_person_id" | "owner_text">): string[] {
  const missing: string[] = [];
  if (!row.owner_person_id && !row.owner_text) missing.push("owner");
  return missing;
}

const activeError = (missing: string[]) =>
  new ValidationError(`status active requires ${missing.join(", ")} (a person id, an email or a name)`);

/** Test seam: runs between the open-WP pre-read and the conditional UPDATE when a project is closed as done. */
let beforeCloseWrite: (() => Promise<void>) | null = null;
export function setBeforeCloseWriteForTesting(f: (() => Promise<void>) | null): void {
  beforeCloseWrite = f;
}

export async function getProjectRow(db: D1Database, id: string): Promise<ProjectRow> {
  const p = await db.prepare(`SELECT * FROM project WHERE id = ? AND ${LIVE()}`).bind(id).first<ProjectRow>();
  if (!p) throw new NotFoundError(`project ${id} not found`);
  return p;
}

export async function listProjects(
  db: D1Database,
  filter: { status?: string; tag?: string; category?: string; owner?: string } = {},
): Promise<ProjectCard[]> {
  const [projects, wps, branches, docs, events, ms] = await db.batch([
    filter.status
      ? db.prepare(`SELECT * FROM project WHERE status = ? AND ${LIVE()} ORDER BY updated_at DESC`).bind(filter.status)
      : db.prepare(`SELECT * FROM project WHERE ${LIVE()} ORDER BY updated_at DESC`),
    db.prepare(`SELECT * FROM workpackage WHERE ${LIVE()}`),
    db.prepare("SELECT project_id, COUNT(*) AS n FROM branch WHERE status = 'open' GROUP BY project_id"),
    db.prepare(`SELECT project_id, COUNT(*) AS n FROM context_doc WHERE ${LIVE()} GROUP BY project_id`),
    db.prepare("SELECT project_id, MAX(ts) AS ts FROM event WHERE project_id IS NOT NULL GROUP BY project_id"),
    db.prepare(
      `SELECT m.project_id, m.id, m.title, m.due_date FROM milestone m WHERE ${LIVE("m")} AND NOT (${QUALIFIES}) ORDER BY m.due_date IS NULL, m.due_date, m.sort, m.title`,
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
  const rows = (projects.results as ProjectRow[]).filter((p) => !filter.owner || p.owner_person_id === filter.owner);
  const people = await personOuts(
    db,
    rows.map((p) => p.owner_person_id),
  );

  return rows
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
        owner_initials: refInitials(personRefOut(p.owner_person_id, p.owner_text, people)),
        wp_counts: leafCounts(list),
        ...projectFlags(p.status, list, derivedProgress),
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
  // Rows written before schedule validation (or by an older Worker) are computed once on first read.
  await ensureSchedule(db, id);
  const [wps, branches, scores, scoreCount, cost, costEntries, events, ctx, baseline, baselineItems] = await db.batch([
    db.prepare(`SELECT * FROM workpackage WHERE project_id = ? AND ${LIVE()} ORDER BY sort, title`).bind(id),
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
    db
      .prepare(
        "SELECT e.*, p.name AS person_name FROM event e LEFT JOIN person p ON p.id = e.person_id WHERE e.project_id = ? ORDER BY e.id DESC LIMIT 10",
      )
      .bind(id),
    db
      .prepare(
        `SELECT id, owner_kind, owner_id, title, slug, source, bytes, version, pinned, sort, status, released_by, released_at, updated_at, updated_by FROM context_doc WHERE project_id = ? AND ${LIVE()} ORDER BY owner_kind, owner_id, pinned DESC, sort, title`,
      )
      .bind(id),
    latestBaselineStmt(db, id),
    latestBaselineItemsStmt(db, id),
  ]);
  const wpRows = wps.results as WorkpackageRow[];
  const msRows = await listMilestones(db, id);
  // F4: baseline dates and slip against the latest baseline; critical path over the live plan.
  const items = baselineItemMap(baselineItems.results as BaselineItem[]);
  const critical = criticalPath({ wps: wpRows.map(snapWp), milestones: msRows.map(snapMs) });
  const milestones = msRows.map((m) => ({
    ...m,
    ...baselineFields(items, "milestone", m.id, m.due_date),
    critical: critical.has(m.id),
  }));
  const totals = cost.results[0] as { claude_tokens: number; copilot_prompts: number };
  return {
    project: await toProjectOut(db, project, wpRows),
    progress: computeProjectProgress(project, wpRows),
    workpackages: buildWpTree(
      (await withPersonOuts(db, project, wpRows)).map((w) => ({
        ...w,
        ...baselineFields(items, "workpackage", w.id, w.end_date),
        critical: critical.has(w.id),
      })),
      { locked: lockedWpIds(milestones) },
    ),
    milestones,
    baseline: (baseline.results[0] as BaselineRef | undefined) ?? null,
    branches: branches.results as BranchRow[],
    scores: scores.results as ScoreRow[],
    score_history_count: (scoreCount.results[0] as { n: number }).n,
    token_cost: { ...totals, entries: costEntries.results as TokenCostRow[] },
    events: events.results as EventOut[],
    context_index: ctx.results as Array<Omit<ContextDocRow, "content_md" | "project_id" | "filename" | "created_at" | "created_by">>,
  };
}

/**
 * Create a project. The owner defaults to the calling person when one is known (spec F1, creation
 * compatibility). Without an explicit status the project starts `active` when the active preconditions
 * hold, else as `idea` with a warning; an explicit `active` without them fails.
 */
export async function createProject(db: D1Database, input: ProjectInput, by: Caller): Promise<ProjectWriteOut> {
  const fields = normalise(input);
  const people = await personCols(db, input);
  if (input.owner === undefined && by.personId) {
    people.owner_person_id = by.personId;
    people.owner_text = null;
  }
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
    owner_person_id: null,
    owner_text: null,
    sponsor_person_id: null,
    sponsor_text: null,
    decision_maker_person_id: null,
    decision_maker_text: null,
    closure_note_md: null,
    lessons_learned_md: null,
    ...(fields as Partial<ProjectRow>),
    ...people,
    version: 1,
    created_at: ts,
    updated_at: ts,
  };
  const closure = closureMissing(row.status, row);
  if (closure.length) throw closureError(row.status, closure);
  const warnings: WriteWarning[] = [];
  const missing = missingForActive(row);
  if (missing.length && fields.status === "active") throw activeError(missing);
  if (missing.length && fields.status === undefined) {
    row.status = "idea";
    warnings.push({
      code: "ACTIVE_PRECONDITIONS_MISSING",
      message: `created as idea: status active requires ${missing.join(", ")}`,
      fields: missing,
    });
  }
  const cols = ["id", ...WRITE_COLS, "version", "created_at", "updated_at"] as const;
  await db.batch([
    db
      .prepare(`INSERT INTO project (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .bind(...cols.map((c) => (row as unknown as Record<string, unknown>)[c] ?? null)),
    eventStmt(db, {
      by,
      project_id: id,
      entity: "project",
      entity_id: id,
      action: "create",
      summary: title,
      diff: diffFields(null, row as unknown as Record<string, unknown>, WRITE_COLS),
    }),
  ]);
  return { ...(await toProjectOut(db, await getProjectRow(db, id))), warnings };
}

export async function updateProject(
  db: D1Database,
  id: string,
  patch: ProjectInput,
  by: Caller,
  expectedVersion?: number,
): Promise<ProjectWriteOut> {
  const current = await getProjectRow(db, id);
  if (typeof expectedVersion === "number" && expectedVersion !== current.version)
    throw new ConflictError("version conflict", await toProjectOut(db, current));
  const fields = normalise(patch);
  const people = await personCols(db, patch);
  const next = { ...current, ...fields, ...people } as Record<string, unknown>;
  // Checked where status becomes active, or when an active project's owner changes; other edits of a
  // legacy ownerless active project stay possible.
  const missing = missingForActive(next as unknown as ProjectRow);
  if (missing.length && next.status === "active" && (current.status !== "active" || "owner_person_id" in people))
    throw activeError(missing);
  // F3 closure: checked on the merged values when the project becomes done/abandoned, or when a closed
  // project's closure fields are edited.
  const status = String(next.status);
  if (isClosedProjectStatus(status) && (current.status !== status || "closure_note_md" in fields || "lessons_learned_md" in fields)) {
    const closure = closureMissing(status, next as unknown as ProjectRow);
    if (closure.length) throw closureError(status, closure);
  }
  // done needs every WP finished, dropped or moved; the UPDATE re-checks so a WP added meanwhile is caught.
  const toDone = status === "done" && current.status !== "done";
  if (toDone) {
    const open = await openWorkpackages(db, id);
    if (open.length) throw openWorkpackagesError(open);
  }
  const diff = diffFields(current as unknown as Record<string, unknown>, next, WRITE_COLS);
  const changed = Object.keys(diff);
  if (!changed.length) return { ...(await toProjectOut(db, current)), warnings: [] };

  if (toDone && beforeCloseWrite) await beforeCloseWrite();
  const noOpenWps = toDone ? ` AND NOT EXISTS (SELECT 1 FROM workpackage WHERE project_id = ? AND ${OPEN_WP_SQL})` : "";
  const res = await db.batch([
    db
      .prepare(
        `UPDATE project SET ${changed.map((f) => `${f} = ?`).join(", ")}, version = version + 1, updated_at = ? WHERE id = ? AND version = ?${noOpenWps}`,
      )
      .bind(...changed.map((f) => next[f] ?? null), now(), id, current.version, ...(toDone ? [id] : [])),
    eventStmtIfChanged(db, {
      by,
      project_id: id,
      entity: "project",
      entity_id: id,
      action: "update",
      summary: changed.join(", "),
      diff,
    }),
  ]);
  if (!res[0].meta.changes) {
    // Lost a race: a rule failure if the version is unchanged (an open WP appeared), else a version conflict.
    const fresh = await getProjectRow(db, id);
    if (toDone && fresh.version === current.version) {
      const open = await openWorkpackages(db, id);
      if (open.length) throw openWorkpackagesError(open);
    }
    throw new ConflictError("version conflict", await toProjectOut(db, fresh));
  }
  return { ...(await toProjectOut(db, await getProjectRow(db, id))), warnings: [] };
}
