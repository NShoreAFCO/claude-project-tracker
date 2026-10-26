import type { Caller, PersonRefOut } from "../types";
import {
  ConflictError,
  LIVE,
  NotFoundError,
  ValidationError,
  diffFields,
  eventStmt,
  eventStmtIfChanged,
  newId,
  now,
  slugify,
} from "./util";
import { touchProject } from "./activity";
import { personOuts, personRefInput, personRefOut } from "./persons";

export type RiskType = "risk" | "issue" | "opportunity" | "nc";

type RiskResponse = "avoid" | "reduce" | "transfer" | "accept" | "exploit";
type RiskStatus = "open" | "monitoring" | "closed";

export interface RiskRow {
  id: string;
  project_id: string;
  type: RiskType;
  title: string;
  description_md: string | null;
  probability: number;
  impact: number;
  score: number;
  owner_person_id: string | null;
  owner_text: string | null;
  response: RiskResponse | null;
  action: string | null;
  due_date: string | null;
  status: RiskStatus;
  workpackage_id: string | null;
  milestone_id: string | null;
  nc_detected_in_wp: string | null;
  nc_cause: string | null;
  nc_correction: string | null;
  nc_corrective_action: string | null;
  nc_effectiveness_check_date: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export type RiskOut = RiskRow & { owner: PersonRefOut };

export type RiskSummary = {
  open: number;
  max_score: number | null;
  high_without_action: number;
};

const TYPES: readonly RiskType[] = ["risk", "issue", "opportunity", "nc"];
const RESPONSES: readonly RiskResponse[] = ["avoid", "reduce", "transfer", "accept", "exploit"];
const STATUSES: readonly RiskStatus[] = ["open", "monitoring", "closed"];

const COLS = [
  "type",
  "title",
  "description_md",
  "probability",
  "impact",
  "score",
  "owner_person_id",
  "owner_text",
  "response",
  "action",
  "due_date",
  "status",
  "workpackage_id",
  "milestone_id",
  "nc_detected_in_wp",
  "nc_cause",
  "nc_correction",
  "nc_corrective_action",
  "nc_effectiveness_check_date",
] as const;

const UPDATABLE = [
  "type",
  "title",
  "description_md",
  "probability",
  "impact",
  "response",
  "action",
  "due_date",
  "status",
  "workpackage_id",
  "milestone_id",
  "nc_detected_in_wp",
  "nc_cause",
  "nc_correction",
  "nc_corrective_action",
  "nc_effectiveness_check_date",
] as const;

const NC_FIELDS = ["nc_detected_in_wp", "nc_cause", "nc_correction", "nc_corrective_action", "nc_effectiveness_check_date"] as const;

const TEXT_FIELDS = ["description_md", "action", "nc_detected_in_wp", "nc_cause", "nc_correction", "nc_corrective_action"] as const;

const DATE_FIELDS = ["due_date", "nc_effectiveness_check_date"] as const;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function has(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
}

function requireTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError("title must be a non-empty string");
  }
  const valueTrimmed = value.trim();
  if (valueTrimmed.length > 300) {
    throw new ValidationError("title must be at most 300 characters");
  }
  return valueTrimmed;
}

function requireScorePart(value: unknown, field: "probability" | "impact"): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) {
    throw new ValidationError(`${field} must be an integer from 1 to 5`);
  }
  return value;
}

function riskType(value: unknown): RiskType {
  if (typeof value !== "string" || !TYPES.includes(value as RiskType)) {
    throw new ValidationError("type must be risk, issue, opportunity, or nc");
  }
  return value as RiskType;
}

function riskResponse(value: unknown): RiskResponse | null {
  if (value === null) return null;
  if (typeof value !== "string" || !RESPONSES.includes(value as RiskResponse)) {
    throw new ValidationError("response must be avoid, reduce, transfer, accept, exploit, or null");
  }
  return value as RiskResponse;
}

function riskStatus(value: unknown): RiskStatus {
  if (typeof value !== "string" || !STATUSES.includes(value as RiskStatus)) {
    throw new ValidationError("status must be open, monitoring, or closed");
  }
  return value as RiskStatus;
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string or null`);
  }
  if (value.length > 20000) {
    throw new ValidationError(`${field} must be at most 20000 characters`);
  }
  return value;
}

function nullableDate(value: unknown, field: string): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new ValidationError(`${field} must be YYYY-MM-DD or null`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new ValidationError(`${field} must be a valid YYYY-MM-DD date`);
  }
  return value;
}

function nullableId(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value) {
    throw new ValidationError(`${field} must be a string or null`);
  }
  return value;
}

async function projectExists(db: D1Database, projectId: string): Promise<void> {
  const found = await db
    .prepare(`SELECT 1 AS found FROM project WHERE id = ? AND ${LIVE()} LIMIT 1`)
    .bind(projectId)
    .first<{ found: number }>();
  if (!found) throw new NotFoundError(`project ${projectId} not found`);
}

async function validateLinkedEntity(
  db: D1Database,
  table: "workpackage" | "milestone",
  id: string | null,
  projectId: string,
): Promise<void> {
  if (id === null) return;
  const found = await db
    .prepare(`SELECT 1 AS found FROM ${table} WHERE id = ? AND project_id = ? AND ${LIVE()} LIMIT 1`)
    .bind(id, projectId)
    .first<{ found: number }>();
  if (!found) {
    throw new ValidationError(`${table}_id must reference a live ${table} of the same project`);
  }
}

async function loadRiskRow(db: D1Database, id: string): Promise<RiskRow | null> {
  return db.prepare("SELECT * FROM risk WHERE id = ?").bind(id).first<RiskRow>();
}

async function riskOut(db: D1Database, rowOrId: RiskRow | string): Promise<RiskOut> {
  const row = typeof rowOrId === "string" ? await loadRiskRow(db, rowOrId) : rowOrId;
  if (!row) throw new NotFoundError(`risk ${String(rowOrId)} not found`);
  const ids = row.owner_person_id ? [row.owner_person_id] : [];
  const people = await personOuts(db, ids);
  return {
    ...row,
    owner: personRefOut(row.owner_person_id, row.owner_text, people),
  };
}

async function risksOut(db: D1Database, rows: RiskRow[]): Promise<RiskOut[]> {
  const ids = Array.from(new Set(rows.map((row) => row.owner_person_id).filter((id): id is string => id !== null)));
  const people = await personOuts(db, ids);
  return rows.map((row) => ({
    ...row,
    owner: personRefOut(row.owner_person_id, row.owner_text, people),
  }));
}

async function uniqueGeneratedId(db: D1Database, projectId: string, title: string): Promise<string> {
  const prefix = `${projectId}-risk-`;
  const slug = slugify(title);
  const base = `${prefix}${slug}`.slice(0, 63).replace(/-+$/g, "") || "risk";

  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? "" : `-${n}`;
    const candidate = `${base.slice(0, 63 - suffix.length).replace(/-+$/g, "")}${suffix}`;
    const found = await db.prepare("SELECT 1 AS found FROM risk WHERE id = ? LIMIT 1").bind(candidate).first<{ found: number }>();
    if (!found) return candidate;
  }
}

function changedNames(diff: Record<string, [unknown, unknown]>): string[] {
  return Object.keys(diff);
}

export async function upsertRisk(
  db: D1Database,
  projectId: string,
  input: Record<string, unknown> & { id?: string },
  by: Caller,
  expectedVersion?: number,
): Promise<RiskOut> {
  await projectExists(db, projectId);

  const requestedId = input.id;
  if (requestedId !== undefined && (typeof requestedId !== "string" || !ID_RE.test(requestedId))) {
    throw new ValidationError("id must match /^[a-z0-9][a-z0-9-]{0,62}$/");
  }

  const existing = requestedId ? await loadRiskRow(db, requestedId) : null;

  if (existing) {
    if (existing.deleted_at !== null) {
      throw new NotFoundError(`risk ${existing.id} is in the trash; restore it first`);
    }
    if (existing.project_id !== projectId) {
      throw new ValidationError("risk belongs to another project");
    }
    if (typeof expectedVersion === "number" && expectedVersion !== existing.version) {
      throw new ConflictError("version conflict", existing);
    }

    const next: RiskRow = { ...existing };

    if (has(input, "type")) next.type = riskType(input.type);
    if (has(input, "title")) next.title = requireTitle(input.title);
    if (has(input, "probability")) {
      next.probability = requireScorePart(input.probability, "probability");
    }
    if (has(input, "impact")) next.impact = requireScorePart(input.impact, "impact");
    if (has(input, "response")) next.response = riskResponse(input.response);
    if (has(input, "status")) next.status = riskStatus(input.status);

    for (const field of TEXT_FIELDS) {
      if (has(input, field)) next[field] = nullableText(input[field], field);
    }
    for (const field of DATE_FIELDS) {
      if (has(input, field)) next[field] = nullableDate(input[field], field);
    }
    if (has(input, "workpackage_id")) {
      next.workpackage_id = nullableId(input.workpackage_id, "workpackage_id");
    }
    if (has(input, "milestone_id")) {
      next.milestone_id = nullableId(input.milestone_id, "milestone_id");
    }

    if (has(input, "owner")) {
      const owner = await personRefInput(db, input.owner, "owner");
      if (owner !== undefined) {
        next.owner_person_id = owner.person_id;
        next.owner_text = owner.text;
      }
    }

    if (next.type !== "nc") {
      for (const field of NC_FIELDS) {
        if (has(input, field) && input[field] !== null && input[field] !== "") {
          throw new ValidationError("nc fields are only allowed for type nc");
        }
        next[field] = null;
      }
    }

    await validateLinkedEntity(db, "workpackage", next.workpackage_id, projectId);
    await validateLinkedEntity(db, "milestone", next.milestone_id, projectId);

    next.score = next.probability * next.impact;

    const diff = diffFields(existing as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>, COLS);
    const fields = changedNames(diff);
    if (fields.length === 0) return riskOut(db, existing);

    const changedColumns = fields.filter((field) => field !== "score" && (COLS as readonly string[]).includes(field));
    const timestamp = now();
    const assignments = changedColumns.map((field) => `${field} = ?`);
    assignments.push("score = ?", "version = version + 1", "updated_at = ?");

    const values: unknown[] = changedColumns.map((field) => next[field as keyof RiskRow]);
    values.push(next.score, timestamp, existing.id, existing.version);

    const update = db.prepare(`UPDATE risk SET ${assignments.join(", ")} WHERE id = ? AND version = ?`).bind(...values);

    const event = eventStmtIfChanged(db, {
      by,
      project_id: projectId,
      entity: "risk",
      entity_id: existing.id,
      action: "update",
      summary: `${next.title}: ${fields.join(", ")}`,
      diff,
    });

    const results = await db.batch([update, event, ...touchProject(db, by, projectId, timestamp, false, true)]);
    const updateResult = results[0];
    if (!updateResult.meta.changes) {
      const current = await loadRiskRow(db, existing.id);
      throw new ConflictError("version conflict", current);
    }

    return riskOut(db, existing.id);
  }

  if (!has(input, "title")) throw new ValidationError("title is required");
  if (!has(input, "probability")) throw new ValidationError("probability is required");
  if (!has(input, "impact")) throw new ValidationError("impact is required");

  const title = requireTitle(input.title);
  const probability = requireScorePart(input.probability, "probability");
  const impact = requireScorePart(input.impact, "impact");
  const type = has(input, "type") ? riskType(input.type) : "risk";
  const status = has(input, "status") ? riskStatus(input.status) : "open";
  const timestamp = now();
  const id = requestedId ?? (await uniqueGeneratedId(db, projectId, title));

  let ownerPersonId: string | null = null;
  let ownerText: string | null = null;
  if (has(input, "owner")) {
    const owner = await personRefInput(db, input.owner, "owner");
    if (owner !== undefined) {
      ownerPersonId = owner.person_id;
      ownerText = owner.text;
    }
  }

  const row: RiskRow = {
    id,
    project_id: projectId,
    type,
    title,
    description_md: has(input, "description_md") ? nullableText(input.description_md, "description_md") : null,
    probability,
    impact,
    score: probability * impact,
    owner_person_id: ownerPersonId,
    owner_text: ownerText,
    response: has(input, "response") ? riskResponse(input.response) : null,
    action: has(input, "action") ? nullableText(input.action, "action") : null,
    due_date: has(input, "due_date") ? nullableDate(input.due_date, "due_date") : null,
    status,
    workpackage_id: has(input, "workpackage_id") ? nullableId(input.workpackage_id, "workpackage_id") : null,
    milestone_id: has(input, "milestone_id") ? nullableId(input.milestone_id, "milestone_id") : null,
    nc_detected_in_wp: has(input, "nc_detected_in_wp") ? nullableText(input.nc_detected_in_wp, "nc_detected_in_wp") : null,
    nc_cause: has(input, "nc_cause") ? nullableText(input.nc_cause, "nc_cause") : null,
    nc_correction: has(input, "nc_correction") ? nullableText(input.nc_correction, "nc_correction") : null,
    nc_corrective_action: has(input, "nc_corrective_action") ? nullableText(input.nc_corrective_action, "nc_corrective_action") : null,
    nc_effectiveness_check_date: has(input, "nc_effectiveness_check_date")
      ? nullableDate(input.nc_effectiveness_check_date, "nc_effectiveness_check_date")
      : null,
    version: 1,
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    deleted_by: null,
  };

  if (row.type !== "nc") {
    for (const field of NC_FIELDS) {
      if (row[field] !== null) {
        throw new ValidationError("nc fields are only allowed for type nc");
      }
    }
  }

  await validateLinkedEntity(db, "workpackage", row.workpackage_id, projectId);
  await validateLinkedEntity(db, "milestone", row.milestone_id, projectId);

  const insert = db
    .prepare(
      `INSERT INTO risk (
        id, project_id, type, title, description_md, probability, impact, score,
        owner_person_id, owner_text, response, action, due_date, status,
        workpackage_id, milestone_id, nc_detected_in_wp, nc_cause, nc_correction,
        nc_corrective_action, nc_effectiveness_check_date, version, created_at,
        updated_at, deleted_at, deleted_by
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )`,
    )
    .bind(
      row.id,
      row.project_id,
      row.type,
      row.title,
      row.description_md,
      row.probability,
      row.impact,
      row.score,
      row.owner_person_id,
      row.owner_text,
      row.response,
      row.action,
      row.due_date,
      row.status,
      row.workpackage_id,
      row.milestone_id,
      row.nc_detected_in_wp,
      row.nc_cause,
      row.nc_correction,
      row.nc_corrective_action,
      row.nc_effectiveness_check_date,
      row.version,
      row.created_at,
      row.updated_at,
      row.deleted_at,
      row.deleted_by,
    );

  const event = eventStmt(db, {
    by,
    project_id: projectId,
    entity: "risk",
    entity_id: row.id,
    action: "create",
    summary: row.title,
    diff: diffFields(null, row as unknown as Record<string, unknown>, COLS),
  });

  await db.batch([insert, event, ...touchProject(db, by, projectId, row.created_at)]);
  return riskOut(db, row.id);
}

export async function listRisks(db: D1Database, filter: { project_id?: string; status?: string; type?: RiskType }): Promise<RiskOut[]> {
  const where: string[] = [LIVE(), "project_id IN (SELECT id FROM project WHERE deleted_at IS NULL)"];
  const values: unknown[] = [];

  if (filter.project_id !== undefined) {
    if (typeof filter.project_id !== "string") {
      throw new ValidationError("project_id must be a string");
    }
    where.push("project_id = ?");
    values.push(filter.project_id);
  }

  if (filter.status !== undefined) {
    const status = riskStatus(filter.status);
    where.push("status = ?");
    values.push(status);
  }

  if (filter.type !== undefined) {
    const type = riskType(filter.type);
    where.push("type = ?");
    values.push(type);
  }

  const result = await db
    .prepare(
      `SELECT * FROM risk
       WHERE ${where.join(" AND ")}
       ORDER BY score DESC, due_date IS NULL, due_date, id`,
    )
    .bind(...values)
    .all<RiskRow>();

  return risksOut(db, result.results);
}

export function riskCriterion(openScores: number[]): number | null {
  if (openScores.length === 0) return null;
  const max = Math.max(...openScores);
  return Math.round(((max - 1) / 24) * 10);
}

export async function riskSummaries(db: D1Database, projectIds: string[]): Promise<Map<string, RiskSummary>> {
  const out = new Map<string, RiskSummary>();
  for (const id of projectIds) {
    out.set(id, { open: 0, max_score: null, high_without_action: 0 });
  }

  const ids = Array.from(new Set(projectIds));
  for (let offset = 0; offset < ids.length; offset += 90) {
    const chunk = ids.slice(offset, offset + 90);
    if (chunk.length === 0) continue;

    const placeholders = chunk.map(() => "?").join(", ");
    const result = await db
      .prepare(
        `SELECT
           project_id,
           COUNT(*) AS open,
           MAX(score) AS max_score,
           SUM(CASE
             WHEN score >= 15 AND (action IS NULL OR trim(action) = '') THEN 1
             ELSE 0
           END) AS high_without_action
         FROM risk
         WHERE ${LIVE()}
           AND status != 'closed'
           AND type != 'opportunity'
           AND project_id IN (${placeholders})
         GROUP BY project_id`,
      )
      .bind(...chunk)
      .all<{
        project_id: string;
        open: number;
        max_score: number | null;
        high_without_action: number;
      }>();

    for (const row of result.results) {
      out.set(row.project_id, {
        open: Number(row.open),
        max_score: row.max_score === null ? null : Number(row.max_score),
        high_without_action: Number(row.high_without_action),
      });
    }
  }

  return out;
}

export async function openRisksMarkdown(db: D1Database, projectId: string): Promise<string> {
  const result = await db
    .prepare(
      `SELECT type, score, title, status, action, due_date
       FROM risk
       WHERE project_id = ?
         AND ${LIVE()}
         AND status != 'closed'
       ORDER BY score DESC`,
    )
    .bind(projectId)
    .all<Pick<RiskRow, "type" | "score" | "title" | "status" | "action" | "due_date">>();

  if (result.results.length === 0) return "";

  const lines = result.results.map((row) => {
    const action = row.action === null || row.action.trim() === "" ? "none" : row.action;
    const due = row.due_date ?? "none";
    return `- [${row.type} ${row.score}] ${row.title} (${row.status}; action: ${action}; due ${due})`;
  });

  return `## Open risks\n\n${lines.join("\n")}\n`;
}
