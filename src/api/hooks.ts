import type { Env } from "../types";
import { CONTEXT_DOC_MAX_BYTES } from "../types";
import { linkBranch } from "../data/branches";
import { writeContext } from "../data/context-write";
import { logProgress } from "../data/logs";
import { eventStmt, utf8Bytes } from "../data/util";
import { serviceCaller } from "../auth/caller";
import { REST_ACTIONS, requireAction } from "../auth/permissions";
import { findProjectByPath, findProjectByRepo, normalisePath, repoFullName } from "./match";

const ACTOR = "hook:claude-code";
/** Route key of the hook endpoint in the permission table (src/auth/permissions.ts). */
export const HOOK_ROUTE = "POST /api/hooks/claude-code";

export interface HookBody {
  session_id?: string;
  cwd?: string;
  repo_url?: string | null;
  branch?: string | null;
  last_commit?: string | null;
  reason?: string | null;
  /** Optional (sent by hooks/tracker-session-end.mjs): cwd is a linked git worktree. */
  worktree?: boolean;
  /** Optional (sent by the hook script): the repo's default branch from origin/HEAD, e.g. "main". */
  default_branch?: string | null;
  context_file?: { name?: string; content?: string } | null;
  /** Optional: id or email of the person the session ran for; recorded as event.person_id (spec §4.1). */
  on_behalf_of?: string | null;
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** POST /api/hooks/claude-code (SPEC §6). Matches by repo_url, then by local_path. */
export async function handleClaudeCodeHook(body: HookBody, env: Env): Promise<Record<string, unknown>> {
  const db = env.DB;
  const by = await serviceCaller(db, ACTOR, typeof body.on_behalf_of === "string" ? body.on_behalf_of : null);
  requireAction(by, REST_ACTIONS[HOOK_ROUTE]);
  const sessionId = str(body.session_id, 100);
  const cwd = str(body.cwd, 500);
  const repoUrl = str(body.repo_url, 500);
  const branch = str(body.branch, 250);
  const lastCommit = str(body.last_commit, 200);
  const reason = str(body.reason, 50) ?? "other";

  let project = repoUrl ? await findProjectByRepo(db, repoUrl) : null;
  let nested = false;
  if (project && cwd) {
    const lp = normalisePath(project.local_path);
    const c = normalisePath(cwd);
    nested = !!lp && !!c && c !== lp && c.startsWith(`${lp}/`);
  }
  if (!project && cwd) {
    const byPath = await findProjectByPath(db, cwd);
    if (byPath) ({ project, nested } = byPath);
  }

  if (!project) {
    await db.batch([
      eventStmt(db, {
        by,
        project_id: null,
        entity: "hook",
        entity_id: sessionId,
        action: "unmatched",
        summary: `Claude Code session ended (${reason}) in ${cwd ?? "?"}${repoUrl ? ` · ${repoUrl}` : ""}`,
        diff: { hook: [null, { session_id: sessionId, cwd, repo_url: repoUrl, branch, last_commit: lastCommit, reason }] },
      }),
    ]);
    return { ok: true, matched: null };
  }

  const result: Record<string, unknown> = { ok: true, matched: project.id };
  const isWorktree = body.worktree ?? nested;
  // Like the GitHub webhook: the default branch gets no branch row (it is not "open work").
  // Without origin/HEAD (no remote) main/master count as default.
  const defaultBranch = str(body.default_branch, 250);
  const isDefault = !!branch && !isWorktree && (defaultBranch ? branch === defaultBranch : branch === "main" || branch === "master");
  if (branch && branch !== "HEAD" && !isDefault) {
    const repo =
      repoFullName(project.repo_url) ??
      repoFullName(repoUrl) ??
      `local:${(normalisePath(project.local_path) ?? project.id).split("/").pop()}`;
    const b = await linkBranch(
      db,
      project.id,
      { repo, name: branch, kind: isWorktree ? "worktree" : "branch", last_commit: lastCommit, last_activity: new Date().toISOString() },
      by,
    );
    result.branch_id = b.id;
  }

  await logProgress(
    db,
    { project_id: project.id, summary: `Claude Code session ended (${reason})${branch ? ` on ${branch}` : ""}`, session_id: sessionId },
    by,
  );

  const file = body.context_file;
  if (file && typeof file.content === "string") {
    const name = str(file.name, 200) ?? "session.md";
    const unchanged = await db
      .prepare(
        "SELECT id FROM context_doc WHERE owner_kind = 'project' AND owner_id = ? AND slug = 'session-md' AND content_md = ? AND deleted_at IS NULL",
      )
      .bind(project.id, file.content)
      .first<{ id: string }>();
    if (unchanged) {
      result.context_doc_id = unchanged.id;
      result.context_file = "unchanged";
    } else if (utf8Bytes(file.content) > CONTEXT_DOC_MAX_BYTES) {
      result.context_file = "skipped: larger than 256 KB";
    } else {
      const doc = await writeContext(
        db,
        {
          owner_kind: "project",
          owner_id: project.id,
          slug: "session-md",
          title: name,
          content_md: file.content,
          source: "sync",
          filename: name,
        },
        by,
      );
      result.context_doc_id = doc.id;
    }
  }
  return result;
}
