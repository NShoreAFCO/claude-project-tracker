import type { Caller, Env, Identity, OwnerKind } from "../types";
import { createProject, getProjectDetail, listProjects, updateProject } from "../data/projects";
import { listWorkpackagesOut, upsertWorkpackage } from "../data/workpackages";
import { listMilestones, upsertMilestone } from "../data/milestones";
import { linkBranch } from "../data/branches";
import { assignInboxEvent, listEvents, listInbox, logProgress, logTokenCost, setScores } from "../data/logs";
import { deleteEntity } from "../data/entities";
import { getContextBundle, listContext, readContext } from "../data/context-read";
import {
  appendContext,
  deleteContext,
  getRevision,
  listRevisions,
  restoreRevision,
  setContextMeta,
  writeContext,
} from "../data/context-write";
import { search } from "../data/search";
import { ConflictError, ValidationError } from "../data/util";
import { handleUpload } from "./upload";
import { userCaller } from "../auth/caller";
import { ensureUserPerson, getPerson, listPersons, upsertPerson } from "../data/persons";
import { handleClaudeCodeHook, type HookBody } from "./hooks";
import { isAuditConfigured, runAuditExport } from "../audit/export";

const MAX_JSON = 1024 * 1024;

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json; charset=utf-8");
  h.set("Cache-Control", "no-store");
  h.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(body), { status, headers: h });
}

/** Typed data-layer errors → HTTP; anything else → 500 without details. */
export function errorResponse(e: unknown): Response {
  const err = e as { status?: number; message?: string; current?: unknown };
  if (err?.status === 409) return json({ error: "conflict", message: err.message, current: err.current }, 409);
  if (err?.status === 403) return json({ error: "forbidden", message: err.message }, 403);
  if (err?.status === 404) return json({ error: "not_found", message: err.message }, 404);
  if (err?.status === 413) return json({ error: "too_large", message: err.message }, 413);
  if (err?.status === 400) return json({ error: "invalid", message: err.message }, 400);
  console.error("api error", e);
  return json({ error: "internal" }, 500);
}

async function readJson(request: Request, keepOnBehalfOf = false): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("Content-Length") ?? "0") > MAX_JSON) throw new ValidationError("request body too large");
  const text = await request.text();
  if (text.length > MAX_JSON) throw new ValidationError("request body too large");
  if (!text) return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
  } catch {
    throw new ValidationError("body must be a JSON object");
  }
  // Dashboard writes are always attributed to the logged-in person; on_behalf_of only matters for
  // service tokens (hook endpoint), so it is dropped here rather than reaching the data layer.
  if (keepOnBehalfOf) return v as Record<string, unknown>;
  const { on_behalf_of: _ignored, ...body } = v as Record<string, unknown>;
  return body;
}

const optNum = (v: unknown): number | undefined =>
  typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : undefined;
const reqStr = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new ValidationError(`${name} is required`);
  return v;
};

type Ctx = { req: Request; url: URL; env: Env; db: D1Database; by: Caller; params: string[] };
type Handler = (c: Ctx) => Promise<unknown>;
const routes: Array<[string, RegExp, Handler]> = [];
const route = (method: string, pattern: string, h: Handler) =>
  routes.push([method, new RegExp(`^${pattern.replace(/:[a-z]+/g, "([^/]+)")}$`), h]);

// ---- projects
route("GET", "/api/projects", async ({ db, url }) =>
  listProjects(db, {
    status: url.searchParams.get("status") ?? undefined,
    tag: url.searchParams.get("tag") ?? undefined,
    owner: url.searchParams.get("owner") ?? undefined,
  }),
);
route("POST", "/api/projects", async ({ db, req, by }) => createProject(db, await readJson(req), by));
route("GET", "/api/projects/:id", async ({ db, params }) => getProjectDetail(db, params[0]));
route("PATCH", "/api/projects/:id", async ({ db, req, by, params }) => {
  const { expected_version, ...patch } = await readJson(req);
  return updateProject(db, params[0], patch, by, optNum(expected_version));
});
route("DELETE", "/api/projects/:id", async ({ db, by, params }) => deleteEntity(db, "project", params[0], by));

// ---- work packages
route("GET", "/api/workpackages", async ({ db, url }) => listWorkpackagesOut(db, reqStr(url.searchParams.get("project_id"), "project_id")));
route("POST", "/api/workpackages", async ({ db, req, by }) => {
  const { project_id, expected_version, ...input } = await readJson(req);
  return upsertWorkpackage(db, reqStr(project_id, "project_id"), input, by, optNum(expected_version));
});
route("PATCH", "/api/workpackages/:id", async ({ db, req, by, params }) => {
  const { project_id, expected_version, ...input } = await readJson(req);
  return upsertWorkpackage(db, reqStr(project_id, "project_id"), { ...input, id: params[0] }, by, optNum(expected_version));
});
route("DELETE", "/api/workpackages/:id", async ({ db, by, params }) => deleteEntity(db, "workpackage", params[0], by));

route("GET", "/api/milestones", async ({ db, url }) => listMilestones(db, reqStr(url.searchParams.get("project_id"), "project_id")));
route("POST", "/api/milestones", async ({ db, req, by }) => {
  const { project_id, expected_version, ...input } = await readJson(req);
  return upsertMilestone(db, reqStr(project_id, "project_id"), input, by, optNum(expected_version));
});
route("PATCH", "/api/milestones/:id", async ({ db, req, by, params }) => {
  const { project_id, expected_version, ...input } = await readJson(req);
  return upsertMilestone(db, reqStr(project_id, "project_id"), { ...input, id: params[0] }, by, optNum(expected_version));
});
route("DELETE", "/api/milestones/:id", async ({ db, by, params }) => deleteEntity(db, "milestone", params[0], by));

// ---- persons (spec §4.1): editors add and edit stakeholders; only admins change access roles or a user's email
route("GET", "/api/persons", async ({ db, url }) =>
  listPersons(db, {
    users_only: url.searchParams.get("users_only") === "true",
    include_deleted: url.searchParams.get("include_deleted") === "true",
  }),
);
route("POST", "/api/persons", async ({ db, req, by }) => {
  const { id: _id, expected_version: _v, ...input } = await readJson(req);
  return upsertPerson(db, input, by);
});
/** Own profile: only locale, display_name and phone. Registered before /:id so "me" is not taken as an id. */
const OWN_PROFILE_FIELDS = ["locale", "display_name", "phone"];
route("PATCH", "/api/persons/me", async ({ db, req, by }) => {
  const { expected_version, ...input } = await readJson(req);
  const other = Object.keys(input).filter((k) => !OWN_PROFILE_FIELDS.includes(k));
  if (other.length) throw new ValidationError(`only ${OWN_PROFILE_FIELDS.join(", ")} can be changed here (got ${other.join(", ")})`);
  if (!by.personId) throw new ValidationError("no person for this login");
  return upsertPerson(db, { ...input, id: by.personId }, by, optNum(expected_version));
});
route("PATCH", "/api/persons/:id", async ({ db, req, by, params }) => {
  const { expected_version, ...input } = await readJson(req);
  return upsertPerson(db, { ...input, id: params[0] }, by, optNum(expected_version));
});

// ---- audit (manual trigger of the hourly export; user identities only, like every /api route)
route("POST", "/api/audit/run", async ({ env }) => {
  if (!isAuditConfigured(env)) throw new ConflictError("audit not configured", null);
  return runAuditExport(env);
});

// ---- branches, scores, token cost, progress
route("POST", "/api/branches", async ({ db, req, by }) => {
  const { project_id, ...input } = await readJson(req);
  return linkBranch(db, reqStr(project_id, "project_id"), input as never, by);
});
route("DELETE", "/api/branches/:id", async ({ db, by, params }) => deleteEntity(db, "branch", params[0], by));
route("POST", "/api/scores", async ({ db, req, by }) => {
  const { project_id, scores } = await readJson(req);
  return setScores(db, reqStr(project_id, "project_id"), scores as never, by);
});
route("POST", "/api/token-cost", async ({ db, req, by }) => {
  const { project_id, ...input } = await readJson(req);
  return logTokenCost(db, reqStr(project_id, "project_id"), input as never, by);
});
route("POST", "/api/progress", async ({ db, req, by }) => logProgress(db, (await readJson(req)) as never, by));

// ---- events, inbox, search
route("GET", "/api/events", async ({ db, url }) =>
  listEvents(db, {
    project_id: url.searchParams.get("project_id") ?? undefined,
    limit: optNum(url.searchParams.get("limit")),
    before_id: optNum(url.searchParams.get("before_id")),
  }),
);
route("GET", "/api/inbox", async ({ db }) => listInbox(db));
route("POST", "/api/inbox/:id/assign", async ({ db, req, by, params }) => {
  const { project_id } = await readJson(req);
  await assignInboxEvent(db, Number(params[0]), reqStr(project_id, "project_id"), by);
  return { ok: true };
});
route("GET", "/api/search", async ({ db, url }) => search(db, url.searchParams.get("q") ?? ""));

// ---- context
route("GET", "/api/context", async ({ db, url }) =>
  listContext(
    db,
    {
      owner_kind: reqStr(url.searchParams.get("owner_kind"), "owner_kind") as OwnerKind,
      owner_id: reqStr(url.searchParams.get("owner_id"), "owner_id"),
    },
    url.searchParams.get("inherited") === "true",
  ),
);
route("POST", "/api/context/upload", async ({ req, db, by }) => handleUpload(req, db, by));
route("POST", "/api/context", async ({ db, req, by }) => {
  const b = await readJson(req);
  const source = b.source === "paste" || b.source === "upload" ? b.source : "paste";
  const args = { ...b, source, replace: typeof b.replace === "boolean" ? b.replace : undefined } as Parameters<typeof writeContext>[1];
  return writeContext(db, args, by);
});
route("GET", "/api/context/revisions/:rev", async ({ db, params }) => getRevision(db, Number(params[0])));
route("GET", "/api/context/:id", async ({ db, params }) => readContext(db, { doc_id: params[0] }));
route("PUT", "/api/context/:id", async ({ db, req, by, params }) => {
  // Replace content of an existing doc, addressed by id (owner and slug stay the same).
  const b = await readJson(req);
  const doc = await readContext(db, { doc_id: params[0] });
  return writeContext(
    db,
    {
      owner_kind: doc.owner_kind,
      owner_id: doc.owner_id,
      slug: doc.slug,
      title: typeof b.title === "string" && b.title.trim() ? b.title : doc.title,
      content_md:
        typeof b.content_md === "string"
          ? b.content_md
          : (() => {
              throw new ValidationError("content_md is required");
            })(),
      source: doc.source,
      expected_version: optNum(b.expected_version),
    },
    by,
  );
});
route("PATCH", "/api/context/:id", async ({ db, req, by, params }) => {
  const b = await readJson(req);
  return setContextMeta(
    db,
    params[0],
    {
      title: typeof b.title === "string" ? b.title : undefined,
      pinned: typeof b.pinned === "boolean" ? b.pinned : undefined,
      sort: optNum(b.sort),
    },
    by,
  );
});
route("POST", "/api/context/:id/append", async ({ db, req, by, params }) => {
  const b = await readJson(req);
  return appendContext(
    db,
    { doc_id: params[0], text: reqStr(b.text, "text"), heading: typeof b.heading === "string" ? b.heading : undefined },
    by,
  );
});
route("DELETE", "/api/context/:id", async ({ db, by, params }) => deleteContext(db, params[0], by));
route("GET", "/api/context/:id/revisions", async ({ db, params }) => listRevisions(db, params[0]));
route("POST", "/api/context/:id/restore", async ({ db, req, by, params }) => {
  const b = await readJson(req);
  const rev = optNum(b.revision_id);
  if (rev === undefined) throw new ValidationError("revision_id is required");
  return restoreRevision(db, params[0], rev, by, optNum(b.expected_version));
});

async function bundle(url: URL, db: D1Database): Promise<Response> {
  const b = await getContextBundle(db, {
    project_id: reqStr(url.searchParams.get("project_id"), "project_id"),
    workpackage_id: url.searchParams.get("workpackage_id") || null,
    branch_id: url.searchParams.get("branch_id") || null,
    max_bytes: optNum(url.searchParams.get("max_bytes")),
  });
  if (url.searchParams.get("format") !== "md") return json(b);
  const name = `context-${url.searchParams.get("branch_id") || url.searchParams.get("workpackage_id") || url.searchParams.get("project_id")}.md`;
  return new Response(b.markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** /api/* for a user identity (Access-authenticated). */
export async function handleApi(request: Request, env: Env, identity: Identity & { kind: "user" }): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const db = env.DB;
  try {
    // Person resolution happens once per request (creates the person on first login).
    const by = await userCaller(db, identity.email);
    if (path === "/api/whoami") return json({ identity, person: by.personId ? await getPerson(db, by.personId) : null });
    if (path === "/api/context/bundle" && request.method === "GET") return await bundle(url, db);
    for (const [method, re, h] of routes) {
      const m = re.exec(path);
      if (m && method === request.method) {
        const params = m.slice(1).map(decodeURIComponent);
        const out = await h({ req: request, url, env, db, by, params });
        return json(out, request.method === "POST" && path !== "/api/context/upload" && !path.endsWith("/assign") ? 201 : 200);
      }
    }
    return routes.some(([, re]) => re.test(path)) ? json({ error: "method_not_allowed" }, 405) : json({ error: "not_found" }, 404);
  } catch (e) {
    return errorResponse(e);
  }
}

/** /api/hooks/* — user or allow-listed service token. */
export async function handleHooks(request: Request, env: Env, identity?: Identity): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    if (path === "/api/hooks/claude-code" && request.method === "POST") {
      const body = (await readJson(request, true)) as HookBody;
      // on_behalf_of is for service tokens; a logged-in user posting here acts for themselves only.
      if (identity?.kind === "user") body.on_behalf_of = (await ensureUserPerson(env.DB, identity.email)).id;
      return json(await handleClaudeCodeHook(body, env));
    }
    return json({ error: "not_found" }, 404);
  } catch (e) {
    return errorResponse(e);
  }
}
