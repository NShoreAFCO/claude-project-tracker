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
import { buildWpTree, computeProjectProgress, leafCounts, progressBasis, type ProgressBasis, type WpCounts } from "./progress";
import { QUALIFIES, listMilestones, lockedWpIds } from "./milestones";
import { PROJECT_CATEGORIES, checkCategory } from "./categories";
import { personOuts, personRefInput, personRefOut, refInitials } from "./persons";
import { withPersonOuts } from "./workpackages";
import { riskCriterion, riskSummaries, type RiskSummary } from "./risks";
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
  TransitionError,
} from "./rules";
import { gateClosedSql, gateLockedWpIds } from "./gates";
import { isAgent } from "../auth/caller";
import { requireAction } from "../auth/permissions";
import { POLICY } from "../policy";
import { activitySet, isSystem, projectStale } from "./activity";
import { omitInternal, redactEvents } from "./internal";
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
  "local_host",
  "context_file",
  "session_id",
  "start_date",
  "target_date",
  "progress_mode",
  "progress_manual",
  "progress_manual_reason",
  "tags",
  "category",
  "closure_note_md",
  "lessons_learned_md",
  "schedule_strict",
  "objectives_md",
  "scope_in_md",
  "scope_out_md",
  "success_criteria_md",
  "language",
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
const LOCAL_HOST_MAX = 100;

export type ProjectCard = {
  /** Open risks, highest open score, and open risks scored 15+ without an action (spec F6). */
  risk_summary: RiskSummary;
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
  /** Person id of the owner (for the Owner filter); null for a free-text or missing owner. */
  owner_id: string | null;
  /** open = todo, in_progress = doing, waiting_blocked = waiting + blocked. */
  wp_counts: WpCounts;
  progress_basis: ProgressBasis;
  stalled_blocked: boolean;
  closure_due: boolean;
  /** Oldest `blocked_since` among blocked WPs (YYYY-MM-DD), for the card's age hint; null when none is blocked. */
  blocked_since: string | null;
  /** Number of waiting WPs (deferrals), for the card's Waiting chip. */
  waiting_count: number;
  next_milestone: { id: string; title: string; due_date: string | null } | null;
  /** Last progress (log_progress, status change, WP done); not touched by system writes. */
  last_activity: string | null;
  /** Active project without progress for stale_days (policy, per-category override). */
  stale: boolean;
  open_branches: number;
  context_docs: number;
  blocked: string[];
  repo_url: string | null;
  local_path: string | null;
  local_host: string | null;
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
    } else if (f === "local_host") {
      // Host name of the machine that holds local_path (spec D3): trimmed, max 100 characters, "" or null clears.
      if (v !== null && typeof v !== "string") throw new ValidationError("local_host must be a string");
      v = typeof v === "string" ? v.trim() || null : null;
      if (typeof v === "string" && v.length > LOCAL_HOST_MAX) throw new ValidationError(`local_host must be at most ${LOCAL_HOST_MAX} characters`);
    } else if (f === "language") {
      // Report language (spec F2, §4.4): one of the instance's offered locales, null = instance default.
      if (v === "") v = null;
      if (v !== null && !POLICY.locales.includes(String(v)))
        throw new ValidationError(`language must be one of ${POLICY.locales.join("|")} or null`);
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
  /** Active project without progress for stale_days (spec F8). */
  stale: boolean;
  /** What the percentage rests on (spec F7): mode, done/total leaf WPs, derived weighted percent, manual reason. */
  progress_basis: ProgressBasis;
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
    stale: projectStale(row),
    tags: parseJsonArray(row.tags),
    owner: personRefOut(row.owner_person_id, row.owner_text, people),
    sponsor: personRefOut(row.sponsor_person_id, row.sponsor_text, people),
    decision_maker: personRefOut(row.decision_maker_person_id, row.decision_maker_text, people),
    progress_basis: progressBasis(
      row,
      list.filter((w) => !(w as { deleted_at?: string | null }).deleted_at),
    ),
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
 * Fields a project needs before it may be `active` (spec F1; F12 adds the target date for the project
 * types in policy.target_date_required_categories). Returned names are API field names, so errors and
 * warnings name what to fill in. `activating` = the write makes the project active (or creates it active):
 * the target date rule bites only then, so legacy active projects without a date stay editable.
 */
function missingForActive(
  row: Pick<ProjectRow, "owner_person_id" | "owner_text" | "category" | "target_date">,
  activating = true,
): string[] {
  const missing: string[] = [];
  if (!row.owner_person_id && !row.owner_text) missing.push("owner");
  if (activating && targetDateRequired(row.category) && !row.target_date) missing.push("target_date");
  return missing;
}

/** Spec F12: whether projects of this type need a target date before they become active. */
export const targetDateRequired = (category: string | null | undefined): boolean =>
  !!category && POLICY.target_date_required_categories.includes(category);

/** Spec F7: manual progress needs a reason when a write switches to manual or changes the manual value. */
export function manualReasonError(
  current: { progress_mode: string; progress_manual: number | null } | null,
  next: {
    progress_mode: string;
    progress_manual: number | null;
    progress_manual_reason?: string | null;
  },
): string | null {
  if (next.progress_mode !== "manual") {
    return null;
  }

  const reasonRequired =
    current === null || current.progress_mode !== "manual" || (current.progress_manual ?? null) !== (next.progress_manual ?? null);

  const reasonPresent = typeof next.progress_manual_reason === "string" && next.progress_manual_reason.trim().length > 0;

  return reasonRequired && !reasonPresent
    ? "progress_manual_reason is required when progress_mode is manual or the manual progress changes"
    : null;
}

const MISSING_HINT: Record<string, string> = {
  owner: "owner (a person id, an email or a name)",
  target_date: "target_date (YYYY-MM-DD; required for this project category)",
};
const activeError = (missing: string[]) =>
  new ValidationError(`status active requires ${missing.map((f) => MISSING_HINT[f] ?? f).join(", ")}`);

/** Test seam: runs between the open-WP pre-read and the conditional UPDATE when a project is closed as done. */
let beforeCloseWrite: (() => Promise<void>) | null = null;
export function setBeforeCloseWriteForTesting(f: (() => Promise<void>) | null): void {
  beforeCloseWrite = f;
}

/** Test seam: runs between the reads of updateProject and its batch (any update). */
let beforeProjectWrite: (() => Promise<void>) | null = null;
export function setBeforeProjectWriteForTesting(f: (() => Promise<void>) | null): void {
  beforeProjectWrite = f;
}

export async function getProjectRow(db: D1Database, id: string): Promise<ProjectRow> {
  const p = await db.prepare(`SELECT * FROM project WHERE id = ? AND ${LIVE()}`).bind(id).first<ProjectRow>();
  if (!p) throw new NotFoundError(`project ${id} not found`);
  return p;
}

export async function listProjects(
  db: D1Database,
  filter: { status?: string; tag?: string; category?: string; owner?: string } = {},
  /** The reader; viewers get cards without the internal fields (spec F12). Omitted = internal read. */
  by?: Caller,
): Promise<ProjectCard[]> {
  const [projects, wps, branches, docs, ms] = await db.batch([
    filter.status
      ? db.prepare(`SELECT * FROM project WHERE status = ? AND ${LIVE()} ORDER BY updated_at DESC`).bind(filter.status)
      : db.prepare(`SELECT * FROM project WHERE ${LIVE()} ORDER BY updated_at DESC`),
    db.prepare(`SELECT * FROM workpackage WHERE ${LIVE()}`),
    db.prepare("SELECT project_id, COUNT(*) AS n FROM branch WHERE status = 'open' GROUP BY project_id"),
    db.prepare(`SELECT project_id, COUNT(*) AS n FROM context_doc WHERE ${LIVE()} GROUP BY project_id`),
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
  const tag = filter.tag?.toLowerCase();
  const rows = (projects.results as ProjectRow[]).filter((p) => !filter.owner || p.owner_person_id === filter.owner);
  const people = await personOuts(
    db,
    rows.map((p) => p.owner_person_id),
  );
  const risks = await riskSummaries(
    db,
    rows.map((p) => p.id),
  );

  return rows
    .map((p) => {
      const list = wpBy.get(p.id) ?? [];
      return {
        risk_summary: risks.get(p.id)!,
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
        owner_id: p.owner_person_id && people.has(p.owner_person_id) ? p.owner_person_id : null,
        wp_counts: leafCounts(list),
        progress_basis: progressBasis(p, list),
        ...projectFlags(p.status, list, derivedProgress),
        blocked_since:
          list
            .filter((w) => !w.deleted_at && w.status === "blocked" && w.blocked_since)
            .map((w) => w.blocked_since as string)
            .sort()[0] ?? null,
        waiting_count: list.filter((w) => !w.deleted_at && w.status === "waiting").length,
        next_milestone: nextMs.get(p.id) ?? null,
        last_activity: p.last_progress_at ?? p.created_at,
        stale: projectStale(p),
        open_branches: openBranches.get(p.id) ?? 0,
        context_docs: docCount.get(p.id) ?? 0,
        blocked: list
          .filter((w) => (w.status === "blocked" || w.status === "waiting") && w.blocked_by?.trim())
          .map((w) => w.blocked_by!.trim()),
        repo_url: p.repo_url,
        local_path: p.local_path,
        local_host: p.local_host ?? null,
        session_id: p.session_id,
        version: p.version,
      };
    })
    .filter((c) => !tag || c.tags.some((t) => t.toLowerCase() === tag))
    .filter((c) => !filter.category || (filter.category === "none" ? c.category === null : c.category === filter.category))
    .map((c) => omitInternal(c, by));
}

/** Full project view; `by` = the reader (viewers get it without the internal fields, spec F12). */
export async function getProjectDetail(db: D1Database, id: string, by?: Caller) {
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
  // F6: the risk criterion follows the highest open risk score while open risks exist; the manual value is the fallback.
  const risk_summary = (await riskSummaries(db, [id])).get(id)!;
  const derivedRisk = riskCriterion(risk_summary.max_score === null ? [] : [risk_summary.max_score]);
  const scoreRows = scores.results as Array<ScoreRow & { derived?: boolean }>;
  const shownScores =
    derivedRisk === null
      ? scoreRows
      : [
          ...scoreRows.filter((s) => s.criterion !== "risk"),
          {
            id: "derived:risk",
            project_id: id,
            criterion: "risk",
            value: derivedRisk,
            note: `derived from the highest open risk score (${risk_summary.max_score})`,
            recorded_at: now(),
            actor: "system",
            derived: true,
          },
        ].sort((a, b) => a.criterion.localeCompare(b.criterion));
  // F5: `locked` = unlocked by a never-reached milestone, or gate-locked (`gate_locked` names the gate).
  const gateLocks = await gateLockedWpIds(db, id);
  const locked = new Set([...lockedWpIds(milestones), ...gateLocks.keys()]);
  return {
    project: omitInternal(await toProjectOut(db, project, wpRows), by),
    progress: computeProjectProgress(project, wpRows),
    workpackages: buildWpTree(
      (await withPersonOuts(db, project, wpRows)).map((w) => ({
        ...w,
        ...baselineFields(items, "workpackage", w.id, w.end_date),
        critical: critical.has(w.id),
        gate_locked: gateLocks.get(w.id) ?? null,
      })),
      { locked },
    ),
    milestones,
    baseline: (baseline.results[0] as BaselineRef | undefined) ?? null,
    branches: branches.results as BranchRow[],
    scores: shownScores,
    risk_summary,
    score_history_count: (scoreCount.results[0] as { n: number }).n,
    token_cost: { ...totals, entries: costEntries.results as TokenCostRow[] },
    events: redactEvents(events.results as EventOut[], by),
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

  const createReasonErr = manualReasonError(null, {
    progress_mode: String(fields.progress_mode ?? "derived"),
    progress_manual: (fields.progress_manual as number | null | undefined) ?? null,
    progress_manual_reason: fields.progress_manual_reason as string | null | undefined,
  });
  if (createReasonErr) throw new ValidationError(createReasonErr);

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
    local_host: null,
    context_file: null,
    session_id: null,
    start_date: null,
    target_date: null,
    progress_mode: "derived",
    progress_manual: null,
    progress_manual_reason: null,
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
    objectives_md: null,
    scope_in_md: null,
    scope_out_md: null,
    success_criteria_md: null,
    language: null,
    ...(fields as Partial<ProjectRow>),
    ...people,
    version: 1,
    created_at: ts,
    updated_at: ts,
    last_progress_at: isSystem(by) ? null : ts,
    last_changed_at: isSystem(by) ? null : ts,
  };
  // F11: creating a project as done/abandoned is closing it (decider or above; never a service token).
  if (isClosedProjectStatus(row.status)) requireAction(by, "close");
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
  const cols = ["id", ...WRITE_COLS, "version", "created_at", "updated_at", "last_progress_at", "last_changed_at"] as const;
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
  const reasonErr = manualReasonError(current, next as unknown as ProjectRow);
  if (reasonErr) throw new ValidationError(reasonErr);
  const activating = next.status === "active" && current.status !== "active";
  const missing = missingForActive(next as unknown as ProjectRow, activating);
  if (missing.length && next.status === "active" && (activating || "owner_person_id" in people)) throw activeError(missing);
  // F3 closure: checked on the merged values when the project becomes done/abandoned, or when a closed
  // project's closure fields are edited.
  const status = String(next.status);
  // F11: moving a project to done/abandoned (also abandoned → done) is closing it, and reopening a closed
  // project undoes a closure (Ruling 47): both need "close" (decider or above, never a service token).
  // Editing a closed project's other fields, closure fields included, stays an ordinary write.
  if (current.status !== status && (isClosedProjectStatus(status) || isClosedProjectStatus(current.status))) requireAction(by, "close");
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
  // F5: once the project has a gate, its decision maker (person or text) can be changed but not cleared;
  // the UPDATE re-checks, so a gate added meanwhile is caught.
  const hadDm = !!(current.decision_maker_person_id || current.decision_maker_text);
  const clearsDm = hadDm && !next.decision_maker_person_id && !next.decision_maker_text;
  const hasGate = async () => !!(await db.prepare(`SELECT 1 FROM milestone WHERE ${GATE_OF_PROJECT}`).bind(id).first());
  // F5: agents may not set or clear the decision maker while a gate is undecided (else an agent could make
  // its own login, or free text, the decider and record a go). Re-checked in the UPDATE.
  const dmChanged =
    (next.decision_maker_person_id ?? null) !== (current.decision_maker_person_id ?? null) ||
    (next.decision_maker_text ?? null) !== (current.decision_maker_text ?? null);
  const agentDm = isAgent(by) && dmChanged;
  const hasUndecidedGate = async () =>
    !!(await db.prepare(`SELECT 1 FROM milestone gm WHERE ${undecidedGateOfProject()}`).bind(id).first());
  if (agentDm && (await hasUndecidedGate())) throw decisionMakerLockedError();
  if (clearsDm && (await hasGate())) throw decisionMakerRequiredError();
  const diff = diffFields(current as unknown as Record<string, unknown>, next, WRITE_COLS);
  // F5: a stop decision's closure_decision_pending ends when the project is reactivated or closed.
  if (current.closure_decision_pending && status !== "on_hold") {
    next.closure_decision_pending = 0;
    diff.closure_decision_pending = [current.closure_decision_pending, 0];
  }
  const changed = Object.keys(diff);
  if (!changed.length) return { ...(await toProjectOut(db, current)), warnings: [] };

  if (toDone && beforeCloseWrite) await beforeCloseWrite();
  if (beforeProjectWrite) await beforeProjectWrite();
  const noOpenWps = toDone ? ` AND NOT EXISTS (SELECT 1 FROM workpackage WHERE project_id = ? AND ${OPEN_WP_SQL})` : "";
  const noGate = clearsDm ? ` AND NOT EXISTS (SELECT 1 FROM milestone WHERE ${GATE_OF_PROJECT})` : "";
  const noUndecided = agentDm ? ` AND NOT EXISTS (SELECT 1 FROM milestone gm WHERE ${undecidedGateOfProject()})` : "";
  const ts = now();
  // Spec F8: a status or manual-progress change is progress; other edits only count as a change.
  const act = activitySet(by, ts, changed.includes("status") || changed.includes("progress_manual"));
  const res = await db.batch([
    db
      .prepare(
        `UPDATE project SET ${changed.map((f) => `${f} = ?`).join(", ")}, version = version + 1, updated_at = ?${act.sql} WHERE id = ? AND version = ?${noOpenWps}${noGate}${noUndecided}`,
      )
      .bind(
        ...changed.map((f) => next[f] ?? null),
        ts,
        ...act.params,
        id,
        current.version,
        ...(toDone ? [id] : []),
        ...(clearsDm ? [id] : []),
        ...(agentDm ? [id] : []),
      ),
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
    if (agentDm && fresh.version === current.version && (await hasUndecidedGate())) throw decisionMakerLockedError();
    if (clearsDm && fresh.version === current.version && (await hasGate())) throw decisionMakerRequiredError();
    throw new ConflictError("version conflict", await toProjectOut(db, fresh));
  }
  return { ...(await toProjectOut(db, await getProjectRow(db, id))), warnings: [] };
}

/** SQL (one bound project id): a live gate milestone of the project. */
const GATE_OF_PROJECT = "project_id = ? AND gate = 1 AND deleted_at IS NULL";
/** SQL (alias gm, one bound project id): a live gate of the project without a go / go_with_conditions decision. */
const undecidedGateOfProject = (): string => `gm.project_id = ? AND ${gateClosedSql("gm")}`;

const decisionMakerLockedError = () =>
  new TransitionError(
    "the project has an undecided gate: agents cannot change its decision_maker; a person can change it in the dashboard",
    { code: "DECISION_MAKER_LOCKED" },
  );

const decisionMakerRequiredError = () =>
  new TransitionError("the project has gate milestones: its decision_maker can be changed but not cleared", {
    code: "DECISION_MAKER_REQUIRED",
    missing: ["decision_maker"],
  });
