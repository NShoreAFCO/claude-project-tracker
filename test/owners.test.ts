// F1 (release R1): owners, sponsor, decision maker, priority stakeholders, on_behalf_of, person endpoints and tools.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { call, installTestKeys, serviceJwt, testCaller, userJwt } from "./helpers";
import { createProject, getProjectDetail, listProjects, updateProject } from "../src/data/projects";
import { upsertWorkpackage } from "../src/data/workpackages";
import { listEvents } from "../src/data/logs";
import { ensureUserPerson, upsertPerson } from "../src/data/persons";
import { serviceCaller } from "../src/auth/caller";
import { mcpApiHandler } from "../src/mcp/server";
import { ForbiddenError, ValidationError } from "../src/data/util";
import type { Env, PersonRow } from "../src/types";

const db = env.DB;
let n = 0;
const uniq = (s: string) => `${s} ${++n}`;

async function api(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await call(path, {
    method: init.method ?? "GET",
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    jwt: await userJwt(),
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** Calls the MCP handler as the OAuth provider would (login user@example.com). */
async function mcp(name: string, args: Record<string, unknown>) {
  const ctx = createExecutionContext() as ExecutionContext & { props?: unknown };
  ctx.props = { email: "user@example.com", clientName: "Claude" };
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
    env as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  const json = text.startsWith("{")
    ? JSON.parse(text)
    : JSON.parse(
        text
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice(6),
      );
  return json.result as { isError?: boolean; content: Array<{ text: string }> };
}

let me: PersonRow;
beforeAll(async () => {
  await installTestKeys();
  me = await ensureUserPerson(db, "user@example.com");
});

describe("project owner and activation", () => {
  it("explicit status=active without owner fails with a field-named error", async () => {
    const r = await api("/api/projects", { method: "POST", body: { title: uniq("No owner"), status: "active", owner: null } });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("owner");
    // the same at the data layer for a service caller, and when activating later
    const svc = await serviceCaller(db, "hook:claude-code");
    const err = await createProject(db, { title: uniq("Svc"), status: "active" }, svc).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("owner");
    const idea = await createProject(db, { title: uniq("Idea"), status: "idea" }, svc);
    const patch = await api(`/api/projects/${idea.id}`, { method: "PATCH", body: { status: "active" } });
    expect(patch.status).toBe(400);
    expect(patch.body.message).toContain("owner");
  });

  it("create without status and without known person → idea + warning", async () => {
    const svc = await serviceCaller(db, "hook:claude-code");
    const p = await createProject(db, { title: uniq("Unowned") }, svc);
    expect(p.status).toBe("idea");
    expect(p.owner).toBeNull();
    expect(p.warnings[0].code).toBe("ACTIVE_PRECONDITIONS_MISSING");
    expect(p.warnings[0].message).toContain("owner");
  });

  it("create without status from a dashboard user defaults owner to that person and stays active", async () => {
    const r = await api("/api/projects", { method: "POST", body: { title: uniq("Mine") } });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("active");
    expect(r.body.owner_person_id).toBe(me.id);
    expect(r.body.owner).toEqual({ person_id: me.id, name: me.name, initials: expect.any(String) });
    expect(r.body.warnings).toEqual([]);
    const card = (await api(`/api/projects?owner=${me.id}`)).body.find((c: any) => c.id === r.body.id);
    expect(card.owner_initials).toBe(r.body.owner.initials);
  });

  it("edit title of ownerless active project succeeds", async () => {
    const ts = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO project (id, title, status, origin, progress_mode, version, created_at, updated_at) VALUES (?, ?, 'active', 'manual', 'derived', 1, ?, ?)",
      )
      .bind("legacy-ownerless", "Legacy", ts, ts)
      .run();
    const p = await updateProject(db, "legacy-ownerless", { title: "Legacy renamed" }, testCaller());
    expect(p).toMatchObject({ title: "Legacy renamed", status: "active", owner: null });
    // removing the owner of an active project is not allowed, though
    const owned = await createProject(db, { title: uniq("Owned"), owner: me.id }, testCaller());
    await expect(updateProject(db, owned.id, { owner: null }, testCaller())).rejects.toBeInstanceOf(ValidationError);
  });

  it("owner given as free text that matches no person is stored as text", async () => {
    const p = await createProject(
      db,
      { title: uniq("Text owner"), owner: "Outside Partner Lead", sponsor: "user@example.com", decision_maker: me.name },
      testCaller(),
    );
    expect(p.status).toBe("active");
    expect(p.owner).toEqual({ text: "Outside Partner Lead" });
    expect(p.owner_person_id).toBeNull();
    expect(p.owner_text).toBe("Outside Partner Lead");
    expect(p.sponsor).toMatchObject({ person_id: me.id });
    const card = (await listProjects(db)).find((c) => c.id === p.id)!;
    expect(card.owner_initials).toBe("OL");
    // switching to a person clears the text
    const q = await updateProject(db, p.id, { owner: "USER@example.com" }, testCaller());
    expect(q.owner).toMatchObject({ person_id: me.id });
    expect(q.owner_text).toBeNull();
  });
});

describe("work package owner and stakeholders", () => {
  it("WP effective_owner falls back to project owner", async () => {
    const p = await createProject(db, { title: uniq("WP owners"), owner: me.id }, testCaller());
    const stake = await upsertPerson(db, { name: uniq("Customer QA") }, testCaller());
    const w = await upsertWorkpackage(db, p.id, { title: "Inherits", priority_stakeholders: [stake.id] }, testCaller());
    expect(w.owner).toBeNull();
    expect(w.effective_owner).toMatchObject({ person_id: me.id });
    expect(w.priority_stakeholders).toEqual([{ person_id: stake.id, name: stake.name, initials: expect.any(String) }]);
    const own = await upsertWorkpackage(db, p.id, { title: "Own owner", owner: "Lab Technician" }, testCaller());
    expect(own.effective_owner).toEqual({ text: "Lab Technician" });
    await expect(
      upsertWorkpackage(db, p.id, { id: w.id, priority_stakeholders: ["Nobody Known Here"] }, testCaller()),
    ).rejects.toBeInstanceOf(ValidationError);
    const cleared = await upsertWorkpackage(db, p.id, { id: w.id, priority_stakeholders: [] }, testCaller());
    expect(cleared.priority_stakeholders).toEqual([]);
    expect(cleared.version).toBe(2);
    const tree = (await getProjectDetail(db, p.id)).workpackages;
    expect(tree.find((t) => t.id === own.id)!.effective_owner).toEqual({ text: "Lab Technician" });
    expect(tree.find((t) => t.id === w.id)!.effective_owner).toMatchObject({ person_id: me.id });
  });
});

describe("history and on_behalf_of", () => {
  it("history shows on_behalf_of person for hook calls", async () => {
    await createProject(db, { id: "obo-local", title: "OBO", local_path: "/work/obo-local", owner: me.id }, testCaller());
    const res = await call("/api/hooks/claude-code", {
      method: "POST",
      body: JSON.stringify({ session_id: "s-obo", cwd: "/work/obo-local", reason: "exit", on_behalf_of: "user@example.com" }),
      jwt: await serviceJwt(),
    });
    expect(res.status).toBe(200);
    const ev = (await listEvents(db, { project_id: "obo-local" })).find((e) => e.action === "progress")!;
    expect(ev.actor).toBe("hook:claude-code");
    expect(ev.person_id).toBe(me.id);
    expect(ev.person_name).toBe(me.name);
    expect((await getProjectDetail(db, "obo-local")).events[0].person_name).toBe(me.name);
  });

  it("a logged-in user posting to the hook acts for themselves; an unknown on_behalf_of is a 400", async () => {
    const other = await upsertPerson(db, { name: uniq("Hook Other"), email: `hookother${n}@example.org` }, testCaller());
    const post = async (body: unknown, jwt: string) => call("/api/hooks/claude-code", { method: "POST", body: JSON.stringify(body), jwt });
    const res = await post({ session_id: "s-obo-user", cwd: "/work/obo-local", reason: "exit", on_behalf_of: other.id }, await userJwt());
    expect(res.status).toBe(200);
    const ev = await db
      .prepare("SELECT actor, person_id FROM event WHERE action = 'progress' AND project_id = 'obo-local' ORDER BY id DESC LIMIT 1")
      .first();
    expect(ev).toEqual({ actor: "hook:claude-code", person_id: me.id });
    const bad = await post({ session_id: "s-obo-bad", cwd: "/work/obo-local", on_behalf_of: "nobody@example.org" }, await serviceJwt());
    expect(bad.status).toBe(400);
  });

  it("MCP callers cannot act on behalf of someone else", async () => {
    const other = await upsertPerson(db, { name: uniq("Other"), email: `other${n}@example.org` }, testCaller());
    const r = await mcp("create_project", { title: uniq("MCP OBO"), on_behalf_of: other.id });
    expect(r.isError).toBeFalsy();
    const p = JSON.parse(r.content[0].text);
    const ev = (await listEvents(db, { project_id: p.id }))[0];
    expect(ev.actor).toBe("mcp:Claude");
    expect(ev.person_id).toBe(me.id);
    expect(p.owner).toMatchObject({ person_id: me.id });
  });

  it("existing create_project MCP call shape still succeeds", async () => {
    const r = await mcp("create_project", { title: "Acceptance via MCP owners" });
    expect(r.isError).toBeFalsy();
    const p = JSON.parse(r.content[0].text);
    expect(p).toMatchObject({ title: "Acceptance via MCP owners", status: "active", owner: { person_id: me.id } });
  });
});

describe("persons API and tools", () => {
  it("editor cannot change access_role; admin can", async () => {
    const stake = await upsertPerson(db, { name: uniq("Future user") }, testCaller());
    const editor = testCaller({ actor: "user:editor@example.com", channel: "dashboard", role: "editor" });
    const admin = testCaller({ actor: "user:admin@example.com", channel: "dashboard", role: "admin" });
    await expect(upsertPerson(db, { id: stake.id, access_role: "viewer" }, editor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(upsertPerson(db, { name: uniq("New"), access_role: "editor" }, editor)).rejects.toBeInstanceOf(ForbiddenError);
    // editors still add and edit stakeholders
    expect((await upsertPerson(db, { id: stake.id, function: "Buyer" }, editor)).function).toBe("Buyer");
    expect((await upsertPerson(db, { id: stake.id, access_role: "viewer" }, admin)).access_role).toBe("viewer");
  });

  it("GET/POST/PATCH /api/persons and PATCH /api/persons/me", async () => {
    const created = await api("/api/persons", { method: "POST", body: { name: uniq("Supplier Contact"), company: "Example Ltd" } });
    expect(created.status).toBe(201);
    const list = await api("/api/persons");
    expect(list.body.some((p: any) => p.id === created.body.id)).toBe(true);
    const patched = await api(`/api/persons/${created.body.id}`, {
      method: "PATCH",
      body: { function: "Sales", expected_version: 1 },
    });
    expect(patched.body).toMatchObject({ function: "Sales", version: 2 });
    const mine = await api("/api/persons/me", { method: "PATCH", body: { locale: "de", display_name: "U" } });
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ id: me.id, locale: "de", display_name: "U" });
    const bad = await api("/api/persons/me", { method: "PATCH", body: { access_role: "admin" } });
    expect(bad.status).toBe(400);
    await api("/api/persons/me", { method: "PATCH", body: { locale: null, display_name: null } });
  });

  it("MCP upsert_person and list_persons", async () => {
    const r = await mcp("upsert_person", { name: uniq("Agent Added"), function: "Reviewer", phone: "+00 99" });
    expect(r.isError).toBeFalsy();
    const p = JSON.parse(r.content[0].text);
    expect(p).toMatchObject({ function: "Reviewer", access_role: null });
    expect(p.phone).toBeUndefined();
    const list = JSON.parse((await mcp("list_persons", {})).content[0].text);
    expect(list.some((x: any) => x.id === p.id)).toBe(true);
    const ev = await db.prepare("SELECT actor, person_id FROM event WHERE entity = 'person' AND entity_id = ?").bind(p.id).first();
    expect(ev).toEqual({ actor: "mcp:Claude", person_id: me.id });
  });

  it("person event diff redacts email, phone and contact_note", async () => {
    const p = await upsertPerson(
      db,
      { name: uniq("Redact Me"), email: `redact${n}@example.org`, phone: "+00 5551", contact_note: "call after 5551" },
      testCaller(),
    );
    await upsertPerson(db, { id: p.id, email: `redact${n}b@example.org`, phone: "+00 5552", contact_note: null }, testCaller());
    const { results } = await db
      .prepare("SELECT action, diff_json FROM event WHERE entity = 'person' AND entity_id = ? ORDER BY id")
      .bind(p.id)
      .all<{ action: string; diff_json: string }>();
    expect(results.map((e) => e.action)).toEqual(["create", "update"]);
    for (const e of results) {
      expect(e.diff_json).toContain("[changed]");
      expect(e.diff_json).not.toMatch(/redact\d+b?@example\.org|5551|5552/);
    }
    expect(JSON.parse(results[0].diff_json)).toMatchObject({
      email: [null, "[changed]"],
      phone: [null, "[changed]"],
      contact_note: [null, "[changed]"],
    });
    expect(JSON.parse(results[1].diff_json)).toEqual({
      email: ["[changed]", "[changed]"],
      phone: ["[changed]", "[changed]"],
      contact_note: ["[changed]", null],
    });
  });

  it("upsert_person version conflict does not reveal phone or contact_note", async () => {
    const p = await upsertPerson(db, { name: uniq("Conflict Contact"), phone: "+00 7771", contact_note: "secret note 7771" }, testCaller());
    const r = await mcp("upsert_person", { id: p.id, function: "Buyer", expected_version: 99 });
    expect(r.isError).toBe(true);
    const err = JSON.parse(r.content[0].text);
    expect(err).toMatchObject({ error: "conflict", current: { id: p.id, version: 1 } });
    expect(err.current.phone).toBeUndefined();
    expect(err.current.contact_note).toBeUndefined();
    expect(r.content[0].text).not.toContain("7771");
  });
});
