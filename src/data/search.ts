import { LIVE, ValidationError } from "./util";

export type SearchHit = {
  kind: "project" | "workpackage" | "milestone" | "context_doc";
  id: string;
  project_id: string;
  title: string;
  snippet: string;
};

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** ±80 chars around the first case-insensitive hit, newlines collapsed. */
function snippetAround(text: string, query: string): string {
  const flat = text.replace(/\s+/g, " ");
  const i = flat.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return flat.slice(0, 160) + (flat.length > 160 ? "..." : "");
  const from = Math.max(0, i - 80);
  const to = Math.min(flat.length, i + query.length + 80);
  return (from > 0 ? "..." : "") + flat.slice(from, to) + (to < flat.length ? "..." : "");
}

const firstMatch = (q: string, ...fields: Array<string | null>) =>
  fields.find((f) => f && f.toLowerCase().includes(q.toLowerCase())) ?? fields[0] ?? "";

export async function search(db: D1Database, query: string, limit = 30): Promise<SearchHit[]> {
  const q = String(query ?? "").trim();
  if (q.length < 2 || q.length > 200) throw new ValidationError("query must be 2..200 characters");
  const like = `%${escapeLike(q)}%`;
  const lim = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const [projects, wps, docs, ms] = await db.batch([
    db
      .prepare(
        `SELECT id, title, summary, description_md FROM project WHERE ${LIVE()} AND (title LIKE ?1 ESCAPE '\\' OR summary LIKE ?1 ESCAPE '\\' OR description_md LIKE ?1 ESCAPE '\\') LIMIT ?2`,
      )
      .bind(like, lim),
    db
      .prepare(
        `SELECT id, project_id, title, description_md, blocked_by FROM workpackage WHERE ${LIVE()} AND (title LIKE ?1 ESCAPE '\\' OR description_md LIKE ?1 ESCAPE '\\' OR blocked_by LIKE ?1 ESCAPE '\\') LIMIT ?2`,
      )
      .bind(like, lim),
    // Only a 400-char window around the hit is transferred, never the full content.
    db
      .prepare(
        `SELECT id, project_id, title, CASE WHEN instr(lower(content_md), lower(?3)) > 0 THEN substr(content_md, max(1, instr(lower(content_md), lower(?3)) - 200), 400) ELSE '' END AS window FROM context_doc WHERE ${LIVE()} AND (title LIKE ?1 ESCAPE '\\' OR content_md LIKE ?1 ESCAPE '\\') LIMIT ?2`,
      )
      .bind(like, lim, q),
    db
      .prepare(
        `SELECT id, project_id, title, description_md FROM milestone WHERE ${LIVE()} AND (title LIKE ?1 ESCAPE '\\' OR description_md LIKE ?1 ESCAPE '\\') LIMIT ?2`,
      )
      .bind(like, lim),
  ]);

  const hits: SearchHit[] = [];
  for (const p of projects.results as Array<{ id: string; title: string; summary: string | null; description_md: string | null }>) {
    hits.push({
      kind: "project",
      id: p.id,
      project_id: p.id,
      title: p.title,
      snippet: snippetAround(firstMatch(q, p.title, p.summary, p.description_md), q),
    });
  }
  for (const w of wps.results as Array<{
    id: string;
    project_id: string;
    title: string;
    description_md: string | null;
    blocked_by: string | null;
  }>) {
    hits.push({
      kind: "workpackage",
      id: w.id,
      project_id: w.project_id,
      title: w.title,
      snippet: snippetAround(firstMatch(q, w.title, w.description_md, w.blocked_by), q),
    });
  }
  for (const m of ms.results as Array<{ id: string; project_id: string; title: string; description_md: string | null }>) {
    hits.push({
      kind: "milestone",
      id: m.id,
      project_id: m.project_id,
      title: m.title,
      snippet: snippetAround(firstMatch(q, m.title, m.description_md), q),
    });
  }
  for (const d of docs.results as Array<{ id: string; project_id: string; title: string; window: string }>) {
    hits.push({ kind: "context_doc", id: d.id, project_id: d.project_id, title: d.title, snippet: snippetAround(d.window || d.title, q) });
  }
  return hits.slice(0, lim);
}
