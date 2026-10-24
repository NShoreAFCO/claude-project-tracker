import type { Env } from "../types";
import { findBranch, linkBranch } from "../data/branches";
import { eventStmt } from "../data/util";
import { findProjectByRepo, repoFullName } from "../api/match";

const ACTOR = "webhook:github";
const MAX_BODY = 5 * 1024 * 1024;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** HMAC-SHA256 over the raw body; crypto.subtle.verify compares in constant time. */
export async function verifyGithubSignature(secret: string, body: ArrayBuffer, header: string | null): Promise<boolean> {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const sig = hexToBytes(header.slice(7));
  if (!sig) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, sig, body);
}

/** /webhooks/github — signature is checked before anything is parsed (SPEC §7). */
export async function handleGithubWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const len = Number(request.headers.get("Content-Length") ?? "0");
  if (len > MAX_BODY) return json({ error: "too_large" }, 413);
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY) return json({ error: "too_large" }, 413);
  if (!(await verifyGithubSignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get("X-Hub-Signature-256")))) {
    return json({ error: "unauthorized" }, 401);
  }

  const event = request.headers.get("X-GitHub-Event") ?? "";
  let payload: GhPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (event === "ping") return json({ ok: true, pong: true });
  return json(await processGithubEvent(env.DB, event, payload));
}

interface GhPayload {
  action?: string;
  ref?: string;
  ref_type?: string;
  deleted?: boolean;
  master_branch?: string;
  repository?: { full_name?: string; html_url?: string; default_branch?: string };
  head_commit?: { id?: string; message?: string; timestamp?: string } | null;
  pull_request?: { number?: number; html_url?: string; merged?: boolean; head?: { ref?: string }; base?: { ref?: string } };
  forkee?: { full_name?: string; html_url?: string; default_branch?: string };
}

const commitLabel = (c: GhPayload["head_commit"]) =>
  c?.id ? `${c.id.slice(0, 7)} ${(c.message ?? "").split("\n")[0]}`.trim().slice(0, 200) : null;

/** GitHub sends commit timestamps with the committer's offset; store UTC like everything else (string order = time order). */
function utcIso(ts: string | undefined): string {
  const t = ts ? Date.parse(ts) : NaN;
  return new Date(Number.isNaN(t) ? Date.now() : t).toISOString();
}

export async function processGithubEvent(db: D1Database, event: string, p: GhPayload): Promise<Record<string, unknown>> {
  const htmlUrl = p.repository?.html_url ?? "";
  const repo = p.repository?.full_name ?? repoFullName(htmlUrl) ?? "";
  const project = htmlUrl ? await findProjectByRepo(db, htmlUrl) : null;

  if (!project) {
    await db.batch([
      eventStmt(db, {
        actor: ACTOR,
        project_id: null,
        entity: "webhook",
        entity_id: repo || null,
        action: "unmatched",
        summary: `${event}${p.action ? `/${p.action}` : ""} ${repo} ${p.ref ?? p.pull_request?.head?.ref ?? ""}`.trim(),
        diff: { github: [null, { event, action: p.action ?? null, repo, html_url: htmlUrl, ref: p.ref ?? null }] },
      }),
    ]);
    return { ok: true, matched: null };
  }

  const pid = project.id;
  const defaultBranch = p.repository?.default_branch;
  switch (event) {
    case "create":
      if (p.ref_type === "branch" && p.ref) {
        await linkBranch(db, pid, { repo, name: p.ref, base: p.master_branch ?? defaultBranch ?? null, status: "open" }, ACTOR);
      }
      break;
    case "delete":
      if (p.ref_type === "branch" && p.ref) await closeBranch(db, pid, repo, p.ref);
      break;
    case "push": {
      const name = p.ref?.startsWith("refs/heads/") ? p.ref.slice(11) : null;
      if (!name) break;
      if (p.deleted) await closeBranch(db, pid, repo, name);
      else if (name !== defaultBranch) {
        await linkBranch(
          db,
          pid,
          { repo, name, last_commit: commitLabel(p.head_commit), last_activity: utcIso(p.head_commit?.timestamp) },
          ACTOR,
        );
      } else {
        await db.batch([
          eventStmt(db, {
            actor: ACTOR,
            project_id: pid,
            entity: "repo",
            entity_id: repo,
            action: "push",
            summary: `${name}: ${commitLabel(p.head_commit) ?? ""}`,
          }),
        ]);
      }
      break;
    }
    case "pull_request": {
      const pr = p.pull_request;
      const name = pr?.head?.ref;
      if (!pr || !name) break;
      const status =
        p.action === "closed" ? (pr.merged ? "merged" : "closed") : p.action === "opened" || p.action === "reopened" ? "open" : undefined;
      await linkBranch(
        db,
        pid,
        {
          repo,
          name,
          pr_number: pr.number ?? null,
          pr_url: pr.html_url ?? null,
          base: pr.base?.ref ?? null,
          status,
          last_activity: new Date().toISOString(),
        },
        ACTOR,
      );
      break;
    }
    case "fork": {
      const f = p.forkee;
      if (f?.full_name)
        await linkBranch(db, pid, { repo: f.full_name, name: f.default_branch ?? "main", kind: "fork", note: f.html_url ?? null }, ACTOR);
      break;
    }
    default:
      return { ok: true, matched: pid, ignored: event };
  }
  return { ok: true, matched: pid };
}

/** Branch deleted on GitHub: closed, unless it was already merged. */
async function closeBranch(db: D1Database, pid: string, repo: string, name: string): Promise<void> {
  const b = await findBranch(db, repo, name);
  if (b && b.status !== "merged") await linkBranch(db, pid, { repo, name, status: "closed" }, ACTOR);
  if (!b) {
    await db.batch([
      eventStmt(db, {
        actor: ACTOR,
        project_id: pid,
        entity: "branch",
        entity_id: null,
        action: "delete",
        summary: `${repo}@${name} deleted (unknown branch)`,
      }),
    ]);
  }
}
