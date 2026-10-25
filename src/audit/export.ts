import type { BranchRow, ContextDocRow, Env, EventRow, ProjectRow, ScoreRow, TokenCostRow, WorkpackageRow, MilestoneRow } from "../types";
import { LIVE, now } from "../data/util";
import {
  commitFiles,
  type FileChange,
  getDefaultBranch,
  getHead,
  GitHubError,
  listBlobPaths,
  putFilesViaContents,
  readRawFile,
} from "./github";

/** Events per run; the rest goes out with the next hourly run. Keeps request size and the Free-plan limits in bounds. */
/** The audit export is optional: it runs only when both the repo and the token are set. */
export function isAuditConfigured(env: Pick<Env, "AUDIT_REPO" | "AUDIT_GITHUB_TOKEN">): boolean {
  return !!env.AUDIT_REPO?.trim() && !!env.AUDIT_GITHUB_TOKEN?.trim();
}

export const MAX_EVENTS_PER_RUN = 500;

const META_LAST_ID = "last_export_event_id";

export type AuditResult =
  | { status: "noop"; last_event_id: number }
  | { status: "committed"; via: "git-data" | "contents"; events: number; first: number; last: number; files: number; commit?: string };

type DocKey = Pick<ContextDocRow, "id" | "project_id" | "owner_kind" | "owner_id" | "slug">;

export const contextPath = (d: Pick<DocKey, "project_id" | "owner_kind" | "owner_id" | "slug">): string =>
  `context/${d.project_id}/${d.owner_kind}-${d.owner_id}/${d.slug}.md`;

/** Readable file for the audit repo: a small front matter, then the content unchanged. */
export function contextFile(d: ContextDocRow): string {
  const fm = [
    "---",
    `id: ${d.id}`,
    `title: ${JSON.stringify(d.title)}`,
    `owner: ${d.owner_kind}:${d.owner_id}`,
    `source: ${d.source}`,
    `version: ${d.version}`,
    `pinned: ${d.pinned ? "true" : "false"}`,
    `updated_at: ${d.updated_at}`,
    `updated_by: ${JSON.stringify(d.updated_by)}`,
    "---",
    "",
  ];
  return fm.join("\n") + "\n" + d.content_md + (d.content_md.endsWith("\n") ? "" : "\n");
}

const byKey =
  <T>(...keys: (keyof T)[]) =>
  (a: T, b: T): number => {
    for (const k of keys) {
      const x = String(a[k] ?? "");
      const y = String(b[k] ?? "");
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  };

/**
 * `snapshot/projects.json`: every project with its WPs, branches, latest score per criterion, token cost and context index
 * (no content). Items in the trash are left out (spec F10); their delete events stay in the event log.
 */
export async function buildSnapshot(db: D1Database): Promise<string> {
  const [p, w, b, s, t, c, ms, ml] = await db.batch([
    db.prepare(`SELECT * FROM project WHERE ${LIVE()} ORDER BY id`),
    db.prepare(`SELECT * FROM workpackage WHERE ${LIVE()} ORDER BY project_id, sort, id`),
    db.prepare("SELECT * FROM branch ORDER BY project_id, repo, name"),
    db.prepare(
      "SELECT s.* FROM score s WHERE s.recorded_at = (SELECT max(recorded_at) FROM score x WHERE x.project_id = s.project_id AND x.criterion = s.criterion) ORDER BY s.project_id, s.criterion",
    ),
    db.prepare("SELECT * FROM token_cost ORDER BY project_id, recorded_at, id"),
    db.prepare(
      `SELECT id, project_id, owner_kind, owner_id, title, slug, source, filename, pinned, sort, bytes, version, status, released_by, released_at, created_at, updated_at, created_by, updated_by FROM context_doc WHERE ${LIVE()} ORDER BY project_id, owner_kind, owner_id, slug`,
    ),
    db.prepare(`SELECT * FROM milestone WHERE ${LIVE()} ORDER BY project_id, id`),
    db.prepare(
      `SELECT l.* FROM milestone_link l JOIN workpackage w ON w.id = l.workpackage_id AND ${LIVE("w")} ORDER BY l.milestone_id, l.role, l.workpackage_id`,
    ),
  ]);
  const group = <T extends { project_id: string }>(rows: T[]) => {
    const m = new Map<string, Omit<T, "project_id">[]>();
    for (const { project_id, ...rest } of rows) {
      if (!m.has(project_id)) m.set(project_id, []);
      m.get(project_id)!.push(rest);
    }
    return m;
  };
  const links = new Map<string, { requires: string[]; unlocks: string[] }>();
  for (const l of ml.results as Array<{ milestone_id: string; workpackage_id: string; role: string }>) {
    const e = links.get(l.milestone_id) ?? { requires: [], unlocks: [] };
    (l.role === "requires" ? e.requires : e.unlocks).push(l.workpackage_id);
    links.set(l.milestone_id, e);
  }
  const milestones = group((ms.results as MilestoneRow[]).map((m) => ({ ...m, ...(links.get(m.id) ?? { requires: [], unlocks: [] }) })));
  const wps = group(w.results as WorkpackageRow[]);
  const branches = group(b.results as BranchRow[]);
  const scores = group(s.results as ScoreRow[]);
  const costs = group(t.results as TokenCostRow[]);
  const docs = group(c.results as Omit<ContextDocRow, "content_md">[]);
  const projects = (p.results as ProjectRow[]).sort(byKey<ProjectRow>("id")).map((row) => ({
    ...row,
    tags: parseJson(row.tags),
    workpackages: (wps.get(row.id) ?? []).map((x) => ({ ...x, depends_on: parseJson((x as WorkpackageRow).depends_on) })),
    branches: branches.get(row.id) ?? [],
    scores: scores.get(row.id) ?? [],
    token_cost: costs.get(row.id) ?? [],
    context_docs: docs.get(row.id) ?? [],
    milestones: milestones.get(row.id) ?? [],
  }));
  return JSON.stringify({ projects }, null, 2) + "\n";
}

function parseJson(v: string | null): unknown {
  if (v == null) return null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

const eventLine = (e: EventRow): string =>
  JSON.stringify({
    id: e.id,
    ts: e.ts,
    actor: e.actor,
    project_id: e.project_id,
    entity: e.entity,
    entity_id: e.entity_id,
    action: e.action,
    summary: e.summary,
    diff: parseJson(e.diff_json),
  });

/** Highest event id already in a JSONL file, so a run whose meta update failed never duplicates lines. */
function maxIdInJsonl(text: string): number {
  const lines = text.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const id = Number(JSON.parse(lines[i]).id);
      if (Number.isFinite(id)) return id;
    } catch {
      /* skip malformed line */
    }
  }
  return 0;
}

async function docsByIds(db: D1Database, ids: string[]): Promise<ContextDocRow[]> {
  const out: ContextDocRow[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT * FROM context_doc WHERE id IN (${chunk.map(() => "?").join(", ")}) AND ${LIVE()}`)
      .bind(...chunk)
      .all<ContextDocRow>();
    out.push(...results);
  }
  return out;
}

/**
 * Hourly audit export (SPEC §8). Does nothing unless there are events after meta.last_export_event_id.
 * Changed context docs come from context_doc events; files of docs that no longer exist (in the trash, purged, cascaded or renamed)
 * are removed by comparing the repo tree with the current doc paths. Git is write-only: only the tree listing and the
 * current month's JSONL are read, to build the next commit.
 */
export async function runAuditExport(env: Env): Promise<AuditResult> {
  const db = env.DB;
  const lastRow = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(META_LAST_ID).first<{ value: string }>();
  const lastId = Number(lastRow?.value ?? 0) || 0;

  const { results: events } = await db
    .prepare("SELECT * FROM event WHERE id > ? ORDER BY id LIMIT ?")
    .bind(lastId, MAX_EVENTS_PER_RUN)
    .all<EventRow>();
  if (!events.length) return { status: "noop", last_event_id: lastId };

  const first = events[0].id;
  const last = events[events.length - 1].id;
  const message = `audit: ${events.length} events (${first}-${last})`;

  const changedIds = [...new Set(events.filter((e) => e.entity === "context_doc" && e.entity_id).map((e) => e.entity_id!))];
  const { results: allDocs } = await db
    .prepare(`SELECT id, project_id, owner_kind, owner_id, slug FROM context_doc WHERE ${LIVE()}`)
    .all<DocKey>();
  const snapshot = await buildSnapshot(db);

  const token = env.AUDIT_GITHUB_TOKEN;
  const repo = env.AUDIT_REPO;
  const branch = await getDefaultBranch(token, repo);

  /** Builds the change set against the current head; called again on retry so it sees the new head. */
  const buildChanges = async (head: { commitSha: string; treeSha: string }): Promise<FileChange[]> => {
    const treePaths = await listBlobPaths(token, repo, head.treeSha);
    const expected = new Map(allDocs.map((d) => [contextPath(d), d.id]));
    // Docs named by events, plus docs whose file is missing (self-heal after a failed run).
    const toWrite = new Set(changedIds.filter((id) => allDocs.some((d) => d.id === id)));
    for (const [path, id] of expected) if (!treePaths.has(path)) toWrite.add(id);

    const changes: FileChange[] = [{ path: "snapshot/projects.json", content: snapshot }];
    for (const d of await docsByIds(db, [...toWrite])) changes.push({ path: contextPath(d), content: contextFile(d) });
    for (const p of treePaths)
      if (p.startsWith("context/") && p.endsWith(".md") && !expected.has(p)) changes.push({ path: p, content: null });

    const byMonth = new Map<string, EventRow[]>();
    for (const e of events) {
      const m = e.ts.slice(0, 7);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m)!.push(e);
    }
    for (const [month, list] of byMonth) {
      const path = `events/${month}.jsonl`;
      const existing = treePaths.has(path) ? ((await readRawFile(token, repo, path, head.commitSha)) ?? "") : "";
      const already = maxIdInJsonl(existing);
      const lines = list.filter((e) => e.id > already).map(eventLine);
      if (!lines.length) continue;
      const base = existing && !existing.endsWith("\n") ? existing + "\n" : existing;
      changes.push({ path, content: base + lines.join("\n") + "\n" });
    }
    return changes;
  };

  let result: AuditResult;
  try {
    result = await viaGitData();
  } catch (e) {
    // Auth errors will fail the fallback as well; surface them directly.
    if (e instanceof GitHubError && (e.status === 401 || e.status === 403)) throw e;
    console.error("audit: git data API failed, falling back to contents API", e);
    const head = await getHead(token, repo, branch);
    const changes = await buildChanges(head);
    const files = await putFilesViaContents(token, repo, branch, changes, message);
    result = { status: "committed", via: "contents", events: events.length, first, last, files };
  }

  await db.batch([
    db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(META_LAST_ID, String(last)),
    db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind("last_export_at", now()),
    db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind("last_export_commit", result.status === "committed" && result.commit ? result.commit : ""),
  ]);
  return result;

  async function viaGitData(): Promise<AuditResult> {
    for (let attempt = 1; ; attempt++) {
      const head = await getHead(token, repo, branch);
      const changes = await buildChanges(head);
      try {
        const commit = await commitFiles(token, repo, branch, head, changes, message);
        return { status: "committed", via: "git-data", events: events.length, first, last, files: changes.length, commit };
      } catch (e) {
        // 409/422: head moved or ref update rejected → re-fetch and retry once.
        if (attempt === 1 && e instanceof GitHubError && (e.status === 409 || e.status === 422)) continue;
        throw e;
      }
    }
  }
}
