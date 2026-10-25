import type { ProjectRow } from "../types";
import { LIVE } from "../data/util";

/** github.com URL variants → "https://github.com/owner/name" (lower case, no .git / trailing slash). */
export function normaliseRepoUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let u = url.trim();
  const ssh = /^git@([^:]+):(.+)$/.exec(u);
  if (ssh) u = `https://${ssh[1]}/${ssh[2]}`;
  u = u.replace(/^ssh:\/\/git@/, "https://").replace(/^git:\/\//, "https://");
  try {
    const parsed = new URL(u);
    const path = parsed.pathname.replace(/\.git$/i, "").replace(/\/+$/, "");
    return `https://${parsed.hostname}${path}`.toLowerCase();
  } catch {
    return null;
  }
}

/** "owner/name" (original case) for a GitHub repo URL, else null. */
export function repoFullName(url: string | null | undefined): string | null {
  if (!normaliseRepoUrl(url)) return null;
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/*$/i.exec(url!.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Windows/posix path → lower case, forward slashes, no trailing slash. */
export function normalisePath(p: string | null | undefined): string | null {
  if (!p) return null;
  const s = p.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return s || null;
}

export async function findProjectByRepo(db: D1Database, url: string): Promise<ProjectRow | null> {
  const want = normaliseRepoUrl(url);
  if (!want) return null;
  const { results } = await db.prepare(`SELECT * FROM project WHERE repo_url IS NOT NULL AND ${LIVE()}`).all<ProjectRow>();
  return results.find((p) => normaliseRepoUrl(p.repo_url) === want) ?? null;
}

/** Longest local_path that equals cwd or is a parent of it. */
export async function findProjectByPath(db: D1Database, cwd: string): Promise<{ project: ProjectRow; nested: boolean } | null> {
  const want = normalisePath(cwd);
  if (!want) return null;
  const { results } = await db.prepare(`SELECT * FROM project WHERE local_path IS NOT NULL AND ${LIVE()}`).all<ProjectRow>();
  let best: { project: ProjectRow; nested: boolean; len: number } | null = null;
  for (const p of results) {
    const lp = normalisePath(p.local_path);
    if (!lp) continue;
    if (want === lp || want.startsWith(`${lp}/`)) {
      if (!best || lp.length > best.len) best = { project: p, nested: want !== lp, len: lp.length };
    }
  }
  return best && { project: best.project, nested: best.nested };
}
