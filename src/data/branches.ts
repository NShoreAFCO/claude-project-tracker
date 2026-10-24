import type { BranchRow } from "../types";
import { NotFoundError, ValidationError, diffFields, eventStmt, newId, now } from "./util";

export type BranchInput = {
  repo: string;
  name: string;
  kind?: string;
  base?: string | null;
  status?: string;
  pr_number?: number | null;
  pr_url?: string | null;
  last_commit?: string | null;
  last_activity?: string | null;
  note?: string | null;
  workpackage_id?: string | null;
};

const KINDS = ["branch", "fork", "worktree"];
const STATUSES = ["open", "merged", "closed", "abandoned", "stale"];
const MUTABLE = [
  "project_id",
  "workpackage_id",
  "kind",
  "base",
  "status",
  "pr_number",
  "pr_url",
  "last_commit",
  "last_activity",
  "note",
] as const;

export function findBranch(db: D1Database, repo: string, name: string): Promise<BranchRow | null> {
  return db.prepare("SELECT * FROM branch WHERE repo = ? COLLATE NOCASE AND name = ?").bind(repo, name).first<BranchRow>();
}

/** Upsert by (repo, name). undefined keeps a field, null clears it. */
export async function linkBranch(db: D1Database, projectId: string, input: BranchInput, actor: string): Promise<BranchRow> {
  const repo = input.repo?.trim();
  const name = input.name?.trim();
  if (!repo || !name) throw new ValidationError("repo and name are required");
  if (input.kind !== undefined && !KINDS.includes(input.kind)) throw new ValidationError(`kind must be one of ${KINDS.join("|")}`);
  if (input.status !== undefined && !STATUSES.includes(input.status))
    throw new ValidationError(`status must be one of ${STATUSES.join("|")}`);

  const project = await db.prepare("SELECT id FROM project WHERE id = ?").bind(projectId).first();
  if (!project) throw new NotFoundError(`project ${projectId} not found`);
  if (input.workpackage_id) {
    const wp = await db
      .prepare("SELECT project_id FROM workpackage WHERE id = ?")
      .bind(input.workpackage_id)
      .first<{ project_id: string }>();
    if (!wp || wp.project_id !== projectId)
      throw new ValidationError(`workpackage ${input.workpackage_id} is not part of project ${projectId}`);
  }

  const label = `${repo}@${name}`;
  const existing = await findBranch(db, repo, name);

  if (existing) {
    const next: Record<string, unknown> = { ...existing, project_id: projectId };
    for (const f of MUTABLE) {
      if (f === "project_id") continue;
      const v = (input as Record<string, unknown>)[f];
      if (v !== undefined) next[f] = v;
    }
    const diff = diffFields(existing as unknown as Record<string, unknown>, next, MUTABLE);
    const changed = Object.keys(diff);
    if (!changed.length) return existing;
    const sets = changed.map((f) => `${f} = ?`).join(", ");
    await db.batch([
      db.prepare(`UPDATE branch SET ${sets} WHERE id = ?`).bind(...changed.map((f) => next[f] ?? null), existing.id),
      eventStmt(db, {
        actor,
        project_id: projectId,
        entity: "branch",
        entity_id: existing.id,
        action: "update",
        summary: `${label}: ${changed.join(", ")}`,
        diff,
      }),
    ]);
    return (await findBranch(db, repo, name))!;
  }

  const row: BranchRow = {
    id: newId(),
    project_id: projectId,
    workpackage_id: input.workpackage_id ?? null,
    repo,
    name,
    kind: (input.kind ?? "branch") as BranchRow["kind"],
    base: input.base ?? null,
    status: (input.status ?? "open") as BranchRow["status"],
    pr_number: input.pr_number ?? null,
    pr_url: input.pr_url ?? null,
    last_commit: input.last_commit ?? null,
    last_activity: input.last_activity ?? now(),
    note: input.note ?? null,
  };
  await db.batch([
    db
      .prepare(
        "INSERT INTO branch (id, project_id, workpackage_id, repo, name, kind, base, status, pr_number, pr_url, last_commit, last_activity, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        row.id,
        row.project_id,
        row.workpackage_id,
        row.repo,
        row.name,
        row.kind,
        row.base,
        row.status,
        row.pr_number,
        row.pr_url,
        row.last_commit,
        row.last_activity,
        row.note,
      ),
    eventStmt(db, {
      actor,
      project_id: projectId,
      entity: "branch",
      entity_id: row.id,
      action: "create",
      summary: label,
      diff: diffFields(null, row as unknown as Record<string, unknown>, MUTABLE),
    }),
  ]);
  return row;
}
