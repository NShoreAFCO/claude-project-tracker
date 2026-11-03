import type { Env } from "../types";
import { CONTEXT_DOC_MAX_BYTES } from "../types";
import { linkBranch } from "../data/branches";
import { writeContext } from "../data/context-write";
import { logProgress } from "../data/logs";
import { activitySet } from "../data/activity";
import { eventStmt, eventStmtIfChanged, utf8Bytes } from "../data/util";
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
  /** Optional (hook script): host name of the machine; stored as project.local_host on a match (max 100 chars). */
  host?: string | null;
  context_file?: { name?: string; content?: string } | null;
  /** Up to two files: session.md and HANDOFF.md; other names are ignored. */
  context_files?: { name?: string; content?: string }[] | null;
  /** Optional: id or email of the person the session ran for; recorded as event.person_id (spec §4.1). */
  on_behalf_of?: string | null;
}

const HOST_MAX = 100;
/** Hook file name → context doc slug, title and pinning on creation. */
const HOOK_FILES: Record<string, { slug: string; title: string; pinned: boolean }> = {
  "session.md": { slug: "session-md", title: "session.md", pinned: false },
  "HANDOFF.md": { slug: "handoff", title: "HANDOFF", pinned: true },
};

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

  if (body.host !== undefined && body.host !== null) {
    const host = typeof body.host === "string" ? body.host.trim() : "";
    if (host && host.length <= HOST_MAX) {
      const ts = new Date().toISOString();
      const act = activitySet(by, ts, false);
      const before = await db.prepare("SELECT local_host FROM project WHERE id = ?").bind(project.id).first<{ local_host: string | null }>();
      if (before?.local_host !== host) {
        await db.batch([
          db
            .prepare(`UPDATE project SET local_host = ?, version = version + 1, updated_at = ?${act.sql} WHERE id = ?`)
            .bind(host, ts, ...act.params, project.id),
          eventStmtIfChanged(db, {
            by,
            project_id: project.id,
            entity: "project",
            entity_id: project.id,
            action: "update",
            summary: "Host name updated by session hook",
            diff: { local_host: [before?.local_host ?? null, host] },
          }),
        ]);
      }
    } else {
      result.host = host ? `ignored: longer than ${HOST_MAX} characters` : "ignored: not a non-empty string";
    }
  }

  // The old single context_file is session.md-style input; context_files (max 2) is the current form.
  const files: { name?: string; content?: string }[] = Array.isArray(body.context_files) ? body.context_files.slice(0, 2) : [];
  if (body.context_file) files.unshift(body.context_file);
  const results: Record<string, string> = {};
  for (const file of files) {
    if (!file || typeof file.content !== "string") continue;
    const rawName = str(file.name, 200) ?? (body.context_file === file ? "session.md" : "");
    const spec = (Object.hasOwn(HOOK_FILES, rawName) ? HOOK_FILES[rawName] : undefined) ?? (body.context_file === file ? HOOK_FILES["session.md"] : undefined);
    if (!spec) continue; // unknown name: ignored
    const name = rawName;
    const unchanged = await db
      .prepare(
        "SELECT id FROM context_doc WHERE owner_kind = 'project' AND owner_id = ? AND slug = ? AND content_md = ? AND deleted_at IS NULL",
      )
      .bind(project.id, spec.slug, file.content)
      .first<{ id: string }>();
    let outcome: string;
    if (unchanged) {
      outcome = "unchanged";
      if (spec.slug === "session-md") result.context_doc_id = unchanged.id;
    } else if (utf8Bytes(file.content) > CONTEXT_DOC_MAX_BYTES) {
      outcome = "skipped: larger than 256 KB";
    } else {
      // Pin only on creation, so a user who unpinned HANDOFF keeps it unpinned.
      const exists = spec.pinned
        ? await db
            .prepare("SELECT id FROM context_doc WHERE owner_kind = 'project' AND owner_id = ? AND slug = ? AND deleted_at IS NULL")
            .bind(project.id, spec.slug)
            .first()
        : null;
      const doc = await writeContext(
        db,
        {
          owner_kind: "project",
          owner_id: project.id,
          slug: spec.slug,
          title: spec.slug === "session-md" ? name : spec.title,
          content_md: file.content,
          source: "sync",
          filename: name,
          ...(spec.pinned && !exists ? { pinned: true } : {}),
        },
        by,
      );
      outcome = "written";
      if (spec.slug === "session-md") result.context_doc_id = doc.id;
      else result.handoff_doc_id = doc.id;
    }
    results[spec.slug] = outcome;
    if (spec.slug === "session-md" && outcome !== "written") result.context_file = outcome;
  }
  if (Object.keys(results).length) result.context_files = results;
  return result;
}
