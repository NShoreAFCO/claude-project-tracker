import { NotFoundError, eventStmt } from "./util";
import { reachStmts } from "./milestones";

export type EntityKind = "project" | "workpackage" | "branch" | "milestone";

const chunk = <T>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/**
 * Delete a project, work package (with descendants) or branch, including the context docs they own.
 * context_doc has no FK to workpackage/branch, so those docs are deleted explicitly.
 */
export async function deleteEntity(
  db: D1Database,
  kind: EntityKind,
  id: string,
  actor: string,
): Promise<{ deleted: string; kind: EntityKind }> {
  let projectId: string;
  let label: string;
  let ownerKind: "workpackage" | "branch" | null = null;
  let ownerIds: string[] = [];

  if (kind === "project") {
    const p = await db.prepare("SELECT id, title FROM project WHERE id = ?").bind(id).first<{ id: string; title: string }>();
    if (!p) throw new NotFoundError(`project ${id} not found`);
    projectId = p.id;
    label = `project ${id} deleted: ${p.title}`;
  } else if (kind === "workpackage") {
    const w = await db
      .prepare("SELECT project_id, title FROM workpackage WHERE id = ?")
      .bind(id)
      .first<{ project_id: string; title: string }>();
    if (!w) throw new NotFoundError(`workpackage ${id} not found`);
    projectId = w.project_id;
    label = w.title;
    const { results } = await db
      .prepare("SELECT id, parent_id FROM workpackage WHERE project_id = ?")
      .bind(projectId)
      .all<{ id: string; parent_id: string | null }>();
    const kids = new Map<string, string[]>();
    for (const r of results) if (r.parent_id) kids.set(r.parent_id, [...(kids.get(r.parent_id) ?? []), r.id]);
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(kids.get(cur) ?? []));
    }
    ownerKind = "workpackage";
    ownerIds = [...seen];
  } else if (kind === "milestone") {
    const m = await db
      .prepare("SELECT project_id, title FROM milestone WHERE id = ?")
      .bind(id)
      .first<{ project_id: string; title: string }>();
    if (!m) throw new NotFoundError(`milestone ${id} not found`);
    projectId = m.project_id;
    label = m.title;
  } else {
    const b = await db
      .prepare("SELECT project_id, repo, name FROM branch WHERE id = ?")
      .bind(id)
      .first<{ project_id: string; repo: string; name: string }>();
    if (!b) throw new NotFoundError(`branch ${id} not found`);
    projectId = b.project_id;
    label = `${b.repo}@${b.name}`;
    ownerKind = "branch";
    ownerIds = [id];
  }

  const countRow =
    kind === "project"
      ? await db.prepare("SELECT COUNT(*) AS n FROM context_doc WHERE project_id = ?").bind(id).first<{ n: number }>()
      : null;
  let docCount = countRow?.n ?? 0;
  const stmts: D1PreparedStatement[] = [];
  if (ownerKind) {
    for (const part of chunk(ownerIds, 90)) {
      const r = await db
        .prepare(`SELECT COUNT(*) AS n FROM context_doc WHERE owner_kind = ? AND owner_id IN (${part.map(() => "?").join(", ")})`)
        .bind(ownerKind, ...part)
        .first<{ n: number }>();
      docCount += r?.n ?? 0;
      stmts.push(
        db
          .prepare(`DELETE FROM context_doc WHERE owner_kind = ? AND owner_id IN (${part.map(() => "?").join(", ")})`)
          .bind(ownerKind, ...part),
      );
    }
  }
  // Project deletion cascades work packages, branches, scores, token cost and context docs (FKs).
  stmts.push(db.prepare(`DELETE FROM ${kind} WHERE id = ?`).bind(id));
  stmts.push(
    eventStmt(db, {
      actor,
      project_id: kind === "project" ? null : projectId,
      entity: kind,
      entity_id: id,
      action: "delete",
      summary: label,
      diff: { deleted_context_docs: [docCount, 0] },
    }),
  );
  // Removing a required WP can complete a milestone.
  if (kind === "workpackage") stmts.push(...reachStmts(db, projectId, actor));
  await db.batch(stmts);
  return { deleted: id, kind };
}
