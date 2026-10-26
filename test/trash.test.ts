// F10 (release R1): soft delete, trash, restore, purge, context document status.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { call, installTestKeys, testCaller, userJwt } from "./helpers";
import { createProject, getProjectDetail, listProjects } from "../src/data/projects";
import { upsertWorkpackage, listWorkpackagesOut } from "../src/data/workpackages";
import { upsertMilestone, listMilestones } from "../src/data/milestones";
import { linkBranch } from "../src/data/branches";
import { listEvents } from "../src/data/logs";
import { getContextBundle, listContext, readContext } from "../src/data/context-read";
import { deleteContext, setContextMeta, writeContext } from "../src/data/context-write";
import { search } from "../src/data/search";
import { countChildren, deleteEntity, deletePreview, listTrash, purgeEntity, restoreEntity } from "../src/data/entities";
import { listPersons, personOuts, resolvePersonRef, upsertPerson } from "../src/data/persons";
import { buildSnapshot } from "../src/audit/export";
import { TransitionError } from "../src/data/rules";
import { ForbiddenError, NotFoundError } from "../src/data/util";
import { mcpApiHandler } from "../src/mcp/server";
import { POLICY } from "../src/policy";
import type { Env, EventRow } from "../src/types";

const db = env.DB;
const A = testCaller({ actor: "test" });
const EDITOR = testCaller({ actor: "user:editor@example.com", role: "editor", channel: "dashboard" });
const AGENT = testCaller({ actor: "mcp:Claude", role: "admin", channel: "mcp" });
let n = 0;
const uniq = (s: string) => `${s} ${++n}`;
const owned = (title: string) => createProject(db, { title: uniq(title), owner: "Owner" }, A);
const DAY = 86_400_000;

async function api(path: string, init: { method?: string; body?: unknown; email?: string } = {}) {
  const email = init.email ?? "user@example.com";
  const res = await call(path, {
    method: init.method ?? "GET",
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    jwt: await userJwt(email),
    envOverride: { ALLOWED_EMAILS: ["user@example.com", email].join(",") },
  });
  const ct = res.headers.get("Content-Type") ?? "";
  return { status: res.status, body: ct.includes("json") ? ((await res.json()) as any) : await res.text() };
}

async function mcp(name: string, args: Record<string, unknown>, email = "user@example.com") {
  const ctx = createExecutionContext() as ExecutionContext & { props?: unknown };
  ctx.props = { email, clientName: "Claude" };
  const res = await mcpApiHandler.fetch(
    new Request("https://tracker.test/mcp", {
      method: "POST",
      headers: {
        Host: "tracker.test",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    { ...env, ALLOWED_EMAILS: ["user@example.com", email].join(",") } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  if (res.status !== 200) return { status: res.status, text, isError: true };
  const json = text.startsWith("{")
    ? JSON.parse(text)
    : JSON.parse(
        text
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice(6),
      );
  return { status: res.status, text: json.result.content[0].text as string, isError: !!json.result.isError };
}

/** A project with WP tree p > a > a1, plus b; milestone on a; docs on project, a and a1. */
async function tree() {
  const p = await owned("Trash");
  const a = await upsertWorkpackage(db, p.id, { title: "Alpha needle" }, A);
  const a1 = await upsertWorkpackage(db, p.id, { title: "Alpha one", parent_id: a.id }, A);
  const b = await upsertWorkpackage(db, p.id, { title: "Beta", status: "done" }, A);
  const m = await upsertMilestone(db, p.id, { title: "M on a", workpackage_id: a.id, requires: [a.id, b.id] }, A);
  const dp = await writeContext(db, { owner_kind: "project", owner_id: p.id, title: "proj doc", content_md: "project text" }, A);
  const da = await writeContext(db, { owner_kind: "workpackage", owner_id: a.id, title: "a doc", content_md: "alpha needle text" }, A);
  const da1 = await writeContext(db, { owner_kind: "workpackage", owner_id: a1.id, title: "a1 doc", content_md: "a1 text" }, A);
  return { p, a, a1, b, m, dp, da, da1 };
}

const deletedAt = async (table: string, id: string) =>
  (await db.prepare(`SELECT deleted_at FROM ${table} WHERE id = ?`).bind(id).first<{ deleted_at: string | null }>())?.deleted_at ?? null;

beforeAll(installTestKeys);

describe("soft delete", () => {
  it("deleted WP excluded from search, bundle, progress, counts", async () => {
    const { p, a, a1, b, m } = await tree();
    const before = await getProjectDetail(db, p.id);
    expect(before.progress).toBe(50); // a (via a1) 0, b 100
    const r = await deleteEntity(db, "workpackage", a.id, A);
    expect(r).toEqual({ deleted: a.id, children: 4 }); // a1, the milestone on a, the docs of a and a1
    // rows stay, stamped with one deleted_at
    const stamp = await deletedAt("workpackage", a.id);
    expect(stamp).not.toBeNull();
    expect(await deletedAt("workpackage", a1.id)).toBe(stamp);
    expect(await deletedAt("milestone", m.id)).toBe(stamp);
    // search
    expect((await search(db, "needle")).filter((h) => h.project_id === p.id)).toEqual([]);
    // bundle for the project: WP docs never in it; WP bundle → 404
    await expect(getContextBundle(db, { project_id: p.id, workpackage_id: a.id })).rejects.toBeInstanceOf(NotFoundError);
    // progress and counts: only b is left (done)
    const detail = await getProjectDetail(db, p.id);
    expect(detail.progress).toBe(100);
    expect(detail.workpackages.map((w) => w.id)).toEqual([b.id]);
    expect(detail.milestones).toEqual([]);
    expect(detail.context_index.map((d) => d.owner_id)).toEqual([p.id]);
    const card = (await listProjects(db)).find((c) => c.id === p.id)!;
    expect(card.wp_counts).toMatchObject({ open: 0, done: 1 });
    expect(card.context_docs).toBe(1);
    expect((await listWorkpackagesOut(db, p.id)).map((w) => w.id)).toEqual([b.id]);
    // reading the deleted WP's doc by id → 404
    const doc = await db.prepare("SELECT id FROM context_doc WHERE owner_id = ?").bind(a.id).first<{ id: string }>();
    await expect(readContext(db, { doc_id: doc!.id })).rejects.toBeInstanceOf(NotFoundError);
    // updating a deleted WP → 404
    await expect(upsertWorkpackage(db, p.id, { id: a.id, title: "x" }, A)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("milestones ignore deleted required WPs", async () => {
    const p = await owned("MS");
    const w1 = await upsertWorkpackage(db, p.id, { title: "w1", status: "done" }, A);
    const w2 = await upsertWorkpackage(db, p.id, { title: "w2" }, A);
    const m = await upsertMilestone(db, p.id, { title: "m", requires: [w1.id, w2.id], unlocks: [] }, A);
    await deleteEntity(db, "workpackage", w2.id, A);
    const [got] = await listMilestones(db, p.id);
    expect([got.id, got.requires, got.done]).toEqual([m.id, [w1.id], true]);
    expect(got.reached_at).not.toBeNull();
  });

  it("restore project restores its WPs", async () => {
    const { p, a, a1, b, m, dp, da } = await tree();
    // b deleted on its own first: it stays in the trash when the project comes back
    await deleteEntity(db, "workpackage", b.id, A);
    const del = await deleteEntity(db, "project", p.id, A);
    expect(del.children).toBe(6); // a, a1, m, 3 docs
    await expect(getProjectDetail(db, p.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listProjects(db)).some((c) => c.id === p.id)).toBe(false);
    await expect(restoreEntity(db, "workpackage", a.id, A)).rejects.toMatchObject({ status: 409, current: { code: "PARENT_DELETED" } });

    const r = await restoreEntity(db, "project", p.id, A);
    expect(r).toEqual({ restored: p.id, children: 6 });
    const detail = await getProjectDetail(db, p.id);
    expect(detail.workpackages.map((w) => w.id)).toEqual([a.id]);
    expect(detail.workpackages[0].children.map((w) => w.id)).toEqual([a1.id]);
    expect(detail.milestones.map((x) => x.id)).toEqual([m.id]);
    expect((await readContext(db, { doc_id: dp.id })).content_md).toBe("project text");
    expect((await readContext(db, { doc_id: da.id })).content_md).toBe("alpha needle text");
    expect(await deletedAt("workpackage", b.id)).not.toBeNull();
    // b can come back now that its project is live
    await restoreEntity(db, "workpackage", b.id, A);
    expect((await getProjectDetail(db, p.id)).workpackages.map((w) => w.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("delete event carries the deleted payload", async () => {
    const { p, a, a1, m, da, da1 } = await tree();
    await deleteEntity(db, "workpackage", a.id, A);
    const ev = (await listEvents(db, { project_id: p.id })).find((e) => e.action === "delete" && e.entity === "workpackage")!;
    const diff = JSON.parse(ev.diff_json!);
    expect(diff.title).toEqual(["Alpha needle", null]);
    expect(diff.id).toEqual([a.id, null]);
    expect(diff.deleted_children[0]).toEqual({
      workpackages: [a1.id],
      milestones: [m.id],
      context_docs: [da.id, da1.id].sort(),
      risks: [],
    });
    // a context doc delete keeps its content
    const d = await writeContext(db, { owner_kind: "project", owner_id: p.id, title: "keep", content_md: "keep me" }, A);
    await deleteContext(db, d.id, A);
    const dev = (await listEvents(db, { project_id: p.id })).find((e) => e.action === "delete" && e.entity === "context_doc")!;
    expect(JSON.parse(dev.diff_json!).content_md[0]).toBe("keep me");
  });

  it("branches stay hard-deleted; a branch linked to a deleted WP keeps working", async () => {
    const { p, a } = await tree();
    const br = await linkBranch(db, p.id, { repo: "example-org/x", name: uniq("feat").replace(/ /g, "-"), workpackage_id: a.id }, A);
    await writeContext(db, { owner_kind: "branch", owner_id: br.id, title: "branch doc", content_md: "branch text" }, A);
    await deleteEntity(db, "workpackage", a.id, A);
    const detail = await getProjectDetail(db, p.id);
    expect(detail.branches.map((x) => x.id)).toContain(br.id);
    const bundle = await getContextBundle(db, { project_id: p.id, branch_id: br.id });
    expect(bundle.markdown).toContain("branch text");
    expect(bundle.markdown).toContain("project text");
    expect(bundle.markdown).not.toContain("alpha needle text");
    const r = await deleteEntity(db, "branch", br.id, A);
    expect(r.deleted).toBe(br.id);
    expect(await db.prepare("SELECT 1 FROM branch WHERE id = ?").bind(br.id).first()).toBeNull();
    await expect(restoreEntity(db, "branch", br.id, A)).rejects.toMatchObject({ status: 400 });
  });

  it("a deleted doc frees its slug; restore puts it back or reports SLUG_TAKEN", async () => {
    const p = await owned("Slug");
    const d1 = await writeContext(db, { owner_kind: "project", owner_id: p.id, title: "Plan", content_md: "v1" }, A);
    await deleteContext(db, d1.id, A);
    const row = await db.prepare("SELECT slug FROM context_doc WHERE id = ?").bind(d1.id).first<{ slug: string }>();
    expect(row!.slug).toMatch(/^plan~deleted-\d+$/);
    expect(await listContext(db, { owner_kind: "project", owner_id: p.id })).toEqual([]);
    const d2 = await writeContext(db, { owner_kind: "project", owner_id: p.id, title: "Plan", content_md: "v2" }, A);
    expect([d2.slug, d2.version]).toEqual(["plan", 1]);
    await expect(restoreEntity(db, "context_doc", d1.id, A)).rejects.toMatchObject({ status: 409, current: { code: "SLUG_TAKEN" } });
    await deleteContext(db, d2.id, A);
    await restoreEntity(db, "context_doc", d1.id, A);
    expect((await readContext(db, { owner_kind: "project", owner_id: p.id, slug: "plan" })).content_md).toBe("v1");
  });

  it("trash lists deleted roots with their children; preview counts what a delete takes along", async () => {
    const { p, a, m } = await tree();
    expect(await countChildren(db, "workpackage", a.id)).toBe(4);
    expect(await deletePreview(db, "workpackage", a.id)).toEqual({
      kind: "workpackage",
      id: a.id,
      title: "Alpha needle",
      children: { workpackages: 1, milestones: 1, context_docs: 2 },
    });
    await deleteEntity(db, "workpackage", a.id, A);
    const trash = (await listTrash(db)).filter((t) => t.project_id === p.id);
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({ kind: "workpackage", id: a.id, title: "Alpha needle", deleted_by: "test", children: 4 });
    expect(trash.some((t) => t.id === m.id)).toBe(false);
  });
});

describe("purge", () => {
  it("purge refused at retention_days - 1, allowed at retention_days", async () => {
    const { p, a, a1, da1 } = await tree();
    await deleteEntity(db, "workpackage", a.id, A);
    const stamp = Date.parse((await deletedAt("workpackage", a.id))!);
    const days = POLICY.retention_days;
    await expect(purgeEntity(db, "workpackage", a.id, A, new Date(stamp + (days - 1) * DAY))).rejects.toMatchObject({
      status: 409,
      current: { code: "RETENTION" },
    });
    expect(await purgeEntity(db, "workpackage", a.id, A, new Date(stamp + days * DAY))).toEqual({ purged: a.id });
    expect(await db.prepare("SELECT 1 FROM workpackage WHERE id IN (?, ?)").bind(a.id, a1.id).first()).toBeNull();
    expect(await db.prepare("SELECT 1 FROM context_doc WHERE id = ?").bind(da1.id).first()).toBeNull();
    expect(await db.prepare("SELECT 1 FROM milestone WHERE project_id = ?").bind(p.id).first()).toBeNull();
    const evs = await listEvents(db, { project_id: p.id });
    const purge = evs.find((e) => e.action === "purge" && e.entity === "workpackage")!;
    expect(JSON.parse(purge.diff_json!).title).toEqual(["Alpha needle", null]);
    const docPurge = evs.find((e) => e.action === "purge" && e.entity === "context_doc" && e.entity_id === da1.id)!;
    expect(JSON.parse(docPurge.diff_json!).content_md).toEqual(["a1 text", null]);
    // a live item cannot be purged
    await expect(purgeEntity(db, "project", p.id, A, new Date(Date.now() + 999 * DAY))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("purge refused for non-admin callers", async () => {
    const p = await owned("Purge");
    await deleteEntity(db, "project", p.id, A);
    const later = new Date(Date.now() + 365 * DAY);
    await expect(purgeEntity(db, "project", p.id, EDITOR, later)).rejects.toBeInstanceOf(ForbiddenError);
    const r = await api(`/api/trash/project/${p.id}`, { method: "DELETE" });
    expect(r.status).toBe(403);
    expect(await purgeEntity(db, "project", p.id, A, later)).toEqual({ purged: p.id });
    expect(await db.prepare("SELECT 1 FROM project WHERE id = ?").bind(p.id).first()).toBeNull();
  });
});

describe("document status", () => {
  it("bundle excludes obsolete docs unless include_obsolete=true", async () => {
    const p = await owned("Docs");
    const d1 = await writeContext(db, { owner_kind: "project", owner_id: p.id, title: "old plan", content_md: "obsolete text" }, A);
    await writeContext(db, { owner_kind: "project", owner_id: p.id, title: "draft", content_md: "draft text" }, A);
    const d3 = await writeContext(db, { owner_kind: "project", owner_id: p.id, title: "draft2", content_md: "draft2 text" }, A);
    await setContextMeta(db, d1.id, { status: "obsolete" }, A);
    const dr = await setContextMeta(db, d3.id, { status: "draft" }, A);
    expect([dr.status, dr.released_at]).toEqual(["draft", null]);
    const def = await getContextBundle(db, { project_id: p.id });
    expect(def.markdown).not.toContain("obsolete text");
    expect(def.markdown).toContain("draft text");
    expect(def.markdown).toContain("draft2 text");
    const all = await getContextBundle(db, { project_id: p.id, include_obsolete: true });
    expect(all.markdown).toContain("obsolete text");
    const rest = await api(`/api/context/bundle?project_id=${p.id}&format=md`);
    expect(rest.body).not.toContain("obsolete text");
    const restAll = await api(`/api/context/bundle?project_id=${p.id}&format=md&include_obsolete=true`);
    expect(restAll.body).toContain("obsolete text");
    const viaMcp = await mcp("get_context_bundle", { project_id: p.id });
    expect(viaMcp.text).not.toContain("obsolete text");
    expect((await mcp("get_context_bundle", { project_id: p.id, include_obsolete: true })).text).toContain("obsolete text");
    // list shows every live doc with its status
    const list = await listContext(db, { owner_kind: "project", owner_id: p.id });
    expect(list.map((d) => d.status).sort()).toEqual(["draft", "obsolete", "released"]);
  });

  it("release stamps released_by and released_at (MCP set_context_meta)", async () => {
    const p = await owned("Release");
    const d = await writeContext(db, { owner_kind: "project", owner_id: p.id, title: "plan", content_md: "x" }, A);
    await setContextMeta(db, d.id, { status: "draft" }, A);
    const r = await mcp("set_context_meta", { doc_id: d.id, status: "released" });
    expect(r.isError).toBe(false);
    const out = JSON.parse(r.text);
    expect([out.status, out.released_by]).toEqual(["released", "mcp:Claude"]);
    expect(out.released_at).not.toBeNull();
    expect(out.content_md).toBeUndefined();
    const bad = await mcp("set_context_meta", { doc_id: d.id, status: "final" });
    expect(bad.isError).toBe(true);
  });
});

describe("persons", () => {
  it("deleted persons drop out of lists, resolution and chips; history keeps the name", async () => {
    const s = await upsertPerson(db, { name: uniq("Stake Holder") }, A);
    const p = await createProject(db, { title: uniq("Owned"), owner: s.id }, { ...A, personId: s.id });
    await deleteEntity(db, "person", s.id, EDITOR);
    expect((await listPersons(db)).some((x) => x.id === s.id)).toBe(false);
    expect((await resolvePersonRef(db, s.id)).person_id).toBeNull();
    expect((await personOuts(db, [s.id])).has(s.id)).toBe(false);
    expect((await getProjectDetail(db, p.id)).project.owner).toBeNull();
    const ev = (await listEvents(db, { project_id: p.id })).find((e) => e.action === "create")!;
    expect(ev.person_name).toBe(s.name);
    await restoreEntity(db, "person", s.id, EDITOR);
    expect((await getProjectDetail(db, p.id)).project.owner).toMatchObject({ person_id: s.id });
  });

  it("only admins delete or restore users; agents delete stakeholders only", async () => {
    const user = await upsertPerson(db, { name: uniq("User"), email: `u${n}@example.com`, access_role: "editor" }, A);
    const stake = await upsertPerson(db, { name: uniq("Stake") }, A);
    await expect(deleteEntity(db, "person", user.id, EDITOR)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteEntity(db, "person", user.id, AGENT)).rejects.toBeInstanceOf(ForbiddenError);
    await deleteEntity(db, "person", stake.id, AGENT);
    await deleteEntity(db, "person", user.id, A);
    await expect(restoreEntity(db, "person", user.id, EDITOR)).rejects.toBeInstanceOf(ForbiddenError);
    await restoreEntity(db, "person", user.id, A);
  });

  it("a deactivated login is refused on the dashboard and MCP until restored", async () => {
    const email = `gone${++n}@example.com`;
    expect((await api("/api/whoami", { email })).status).toBe(200);
    const row = await db.prepare("SELECT id FROM person WHERE email = ?").bind(email).first<{ id: string }>();
    await deleteEntity(db, "person", row!.id, A);
    const dash = await api("/api/projects", { email });
    expect([dash.status, dash.body.message]).toEqual([403, "person deactivated"]);
    const viaMcp = await mcp("list_projects", {}, email);
    expect(viaMcp.status).toBe(403);
    expect(viaMcp.text).toContain("person deactivated");
    // no second person is created for the same email
    expect((await db.prepare("SELECT COUNT(*) AS n FROM person WHERE email = ?").bind(email).first("n")) as number).toBe(1);
    await restoreEntity(db, "person", row!.id, A);
    expect((await api("/api/projects", { email })).status).toBe(200);
  });
});

describe("REST and MCP", () => {
  it("trash endpoints list, restore and preview", async () => {
    const { p, a } = await tree();
    const pre = await api(`/api/delete-preview?kind=workpackage&id=${a.id}`);
    expect(pre.body).toMatchObject({ kind: "workpackage", id: a.id, children: { workpackages: 1, milestones: 1, context_docs: 2 } });
    expect((await api(`/api/workpackages/${a.id}`, { method: "DELETE" })).body).toEqual({ deleted: a.id, children: 4 });
    const trash = await api("/api/trash");
    expect(trash.status).toBe(200);
    expect(trash.body.find((t: any) => t.id === a.id)).toMatchObject({ kind: "workpackage", children: 4 });
    const r = await api(`/api/trash/workpackage/${a.id}/restore`, { method: "POST" });
    expect([r.status, r.body]).toEqual([200, { restored: a.id, children: 4 }]);
    expect((await api(`/api/projects/${p.id}`)).body.workpackages.map((w: any) => w.id)).toContain(a.id);
    expect((await api(`/api/trash/workpackage/${a.id}/restore`, { method: "POST" })).status).toBe(404);
  });

  it("persons can be deleted via REST", async () => {
    const s = await upsertPerson(db, { name: uniq("Rest Stake") }, A);
    expect((await api(`/api/persons/${s.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await api("/api/persons")).body.some((x: any) => x.id === s.id)).toBe(false);
  });

  it("delete_entity moves to the trash and restore_entity brings it back", async () => {
    const p = await owned("Mcp trash");
    const w = await upsertWorkpackage(db, p.id, { title: "w" }, A);
    const del = await mcp("delete_entity", { kind: "workpackage", id: w.id, confirm: true });
    expect(JSON.parse(del.text)).toEqual({ deleted: w.id, children: 0 });
    expect(await deletedAt("workpackage", w.id)).not.toBeNull();
    const res = await mcp("restore_entity", { kind: "workpackage", id: w.id });
    expect(JSON.parse(res.text)).toEqual({ restored: w.id, children: 0 });
    expect(await deletedAt("workpackage", w.id)).toBeNull();
    const ev = (await listEvents(db, { project_id: p.id })).find((e: EventRow) => e.action === "restore")!;
    expect(ev.entity_id).toBe(w.id);
  });
});

describe("audit", () => {
  it("audit export skips deleted rows", async () => {
    const { p, a, a1, b, m, da } = await tree();
    const gone = await owned("Gone");
    await deleteEntity(db, "workpackage", a.id, A);
    await deleteEntity(db, "project", gone.id, A);
    const snap = JSON.parse(await buildSnapshot(db));
    expect(snap.projects.some((x: { id: string }) => x.id === gone.id)).toBe(false);
    const sp = snap.projects.find((x: { id: string }) => x.id === p.id);
    expect(sp.workpackages.map((w: { id: string }) => w.id)).toEqual([b.id]);
    expect(sp.milestones).toEqual([]);
    expect(sp.context_docs.map((d: { id: string }) => d.id)).not.toContain(da.id);
    expect(JSON.stringify(sp)).not.toContain(a1.id);
    expect(m.id).toBeTruthy();
  });
});
