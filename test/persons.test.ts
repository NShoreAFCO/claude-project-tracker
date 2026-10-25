import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { call, installTestKeys, testCaller, userJwt } from "./helpers";
import { ensureUserPerson, initials, listPersons, resolvePersonRef, upsertPerson } from "../src/data/persons";
import { mcpCaller, serviceCaller, userCaller, SYSTEM_CALLER, isAgent } from "../src/auth/caller";
import { mcpApiHandler, errorText } from "../src/mcp/server";
import { errorResponse } from "../src/api/rest";
import { ConflictError, ForbiddenError, ValidationError } from "../src/data/util";
import { POLICY } from "../src/policy";
import type { Env, EventRow, PersonRow } from "../src/types";

const db = env.DB;
const allow = (...emails: string[]) => ({ ALLOWED_EMAILS: ["user@example.com", ...emails].join(",") });

async function whoami(email: string, extraAllowed: string[] = [email.toLowerCase()]) {
  const res = await call("/api/whoami", { jwt: await userJwt(email), envOverride: allow(...extraAllowed) });
  return { status: res.status, body: (await res.json()) as { identity: { email: string }; person: PersonRow | null } };
}

const personsByEmail = async (email: string) =>
  (await db.prepare("SELECT * FROM person WHERE lower(email) = ?").bind(email.toLowerCase()).all<PersonRow>()).results;

/** Calls the MCP handler as the OAuth provider would, with grant props. */
async function mcp(props: { email?: string; clientName?: string }, name: string, args: Record<string, unknown>, envOverride = {}) {
  const ctx = createExecutionContext() as ExecutionContext & { props?: unknown };
  ctx.props = props;
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
    { ...env, ...envOverride } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

beforeAll(installTestKeys);

describe("persons and identity", () => {
  it("creates a person on first dashboard request", async () => {
    const { status, body } = await whoami("New@Example.com");
    expect(status).toBe(200);
    expect(body.identity.email).toBe("new@example.com");
    expect(body.person).toMatchObject({ email: "new@example.com", name: "new", access_role: "editor", internal: 1 });
    // a second request reuses the person
    const again = await whoami("new@example.com");
    expect(again.body.person!.id).toBe(body.person!.id);
    expect(await personsByEmail("new@example.com")).toHaveLength(1);
  });

  it("admin from policy.admins gets role admin", async () => {
    POLICY.admins.push("boss@example.com");
    try {
      const { body } = await whoami("Boss@example.com");
      expect(body.person).toMatchObject({ email: "boss@example.com", access_role: "admin" });
    } finally {
      POLICY.admins.splice(POLICY.admins.indexOf("boss@example.com"), 1);
    }
  });

  it("first login links to existing person with same email (case-insensitive)", async () => {
    const jane = await upsertPerson(db, { name: "Jane Doe", email: "jane@example.com", company: "Example Org" }, testCaller());
    expect(jane.access_role).toBeNull();
    const { body } = await whoami("JANE@example.com");
    const rows = await personsByEmail("jane@example.com");
    expect(rows).toHaveLength(1);
    const p = body.person!;
    expect(p.id).toBe(jane.id);
    expect(p.name).toBe("Jane Doe");
    expect(p.access_role).toBe("editor");
    expect(p.version).toBe(jane.version + 1);
  });

  it("removed email gets 403 but person row stays", async () => {
    const { body } = await whoami("gone@example.com");
    const id = body.person!.id;
    // still allowed: MCP works
    expect((await mcp({ email: "gone@example.com", clientName: "Claude" }, "list_projects", {}, allow("gone@example.com"))).status).toBe(
      200,
    );
    // removed from the allow-list: the MCP grant no longer works, the dashboard refuses as before
    expect((await mcp({ email: "gone@example.com", clientName: "Claude" }, "list_projects", {}, allow())).status).toBe(403);
    expect((await call("/api/whoami", { jwt: await userJwt("gone@example.com"), envOverride: allow() })).status).toBe(401);
    const rows = await personsByEmail("gone@example.com");
    expect(rows.map((r) => r.id)).toEqual([id]);
    expect(rows[0].deleted_at).toBeNull();
  });

  it("events record person_id for dashboard writes", async () => {
    const { body } = await whoami("user@example.com", []);
    const personId = body.person!.id;
    const res = await call("/api/projects", {
      method: "POST",
      jwt: await userJwt(),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Person attribution" }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const ev = await db
      .prepare("SELECT * FROM event WHERE entity = 'project' AND entity_id = ? AND action = 'create'")
      .bind(id)
      .first<EventRow>();
    expect(ev!.actor).toBe("user:user@example.com");
    expect(ev!.person_id).toBe(personId);
  });

  it("mcp calls resolve the OAuth email to a person", async () => {
    const res = await mcp({ email: "User@Example.com", clientName: "Claude Test" }, "create_project", { title: "MCP person attribution" });
    expect(res.status).toBe(200);
    const [person] = await personsByEmail("user@example.com");
    const ev = await db
      .prepare("SELECT * FROM event WHERE entity = 'project' AND summary = 'MCP person attribution' AND action = 'create'")
      .first<EventRow>();
    expect(ev!.actor).toBe("mcp:Claude Test");
    expect(ev!.person_id).toBe(person.id);
    // the raw-SQL event paths (milestone reach, context append) carry the person too
    const by = await mcpCaller(db, { email: "user@example.com", clientName: "Claude Test" });
    expect(by).toEqual({ actor: "mcp:Claude Test", personId: person.id, role: person.access_role, channel: "mcp" });
    expect(isAgent(by)).toBe(true);
  });

  it("context appends and milestone reach events carry person_id", async () => {
    const by = await userCaller(db, "user@example.com");
    const p = await call("/api/projects", {
      method: "POST",
      jwt: await userJwt(),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Raw events" }),
    });
    const { id } = (await p.json()) as { id: string };
    const { appendContext } = await import("../src/data/context-write");
    const { upsertWorkpackage } = await import("../src/data/workpackages");
    const { upsertMilestone } = await import("../src/data/milestones");
    await appendContext(db, { owner_kind: "project", owner_id: id, slug: "handover", text: "done" }, by);
    const wp = await upsertWorkpackage(db, id, { title: "Only WP" }, by);
    await upsertMilestone(db, id, { title: "M1", requires: [wp.id] }, by);
    await upsertWorkpackage(db, id, { id: wp.id, status: "done" }, by);
    const { results } = await db
      .prepare("SELECT action, person_id FROM event WHERE project_id = ? AND action IN ('append', 'reached')")
      .bind(id)
      .all<{ action: string; person_id: string | null }>();
    expect(results.map((r) => r.action).sort()).toEqual(["append", "reached"]);
    expect(results.every((r) => r.person_id === by.personId)).toBe(true);
  });

  it("resolvePersonRef: id, email, exact name, else text", async () => {
    const max = await upsertPerson(db, { name: "Max Mustermann", email: "max@example.org" }, testCaller());
    expect(await resolvePersonRef(db, max.id)).toEqual({ person_id: max.id, text: null });
    expect(await resolvePersonRef(db, " MAX@example.org ")).toEqual({ person_id: max.id, text: null });
    expect(await resolvePersonRef(db, "max mustermann")).toEqual({ person_id: max.id, text: null });
    expect(await resolvePersonRef(db, "Supplier QA lead")).toEqual({ person_id: null, text: "Supplier QA lead" });
    expect(await resolvePersonRef(db, "  ")).toEqual({ person_id: null, text: null });
    expect(await resolvePersonRef(db, null)).toEqual({ person_id: null, text: null });
    // an ambiguous name stays text rather than guessing
    await upsertPerson(db, { name: "Alex Smith" }, testCaller());
    await upsertPerson(db, { name: "alex smith", company: "Other" }, testCaller());
    expect(await resolvePersonRef(db, "Alex Smith")).toEqual({ person_id: null, text: "Alex Smith" });
  });

  it("upsertPerson validates, versions, logs events without contact data and keeps roles away from agents", async () => {
    const p = await upsertPerson(
      db,
      { name: " Erika Muster ", email: "Erika@Example.com", phone: "+00 1234", internal: true },
      testCaller(),
    );
    expect(p).toMatchObject({ name: "Erika Muster", email: "erika@example.com", internal: 1, version: 1, access_role: null });
    await expect(upsertPerson(db, { name: "Copy", email: "ERIKA@example.com" }, testCaller())).rejects.toBeInstanceOf(ConflictError);
    await expect(upsertPerson(db, { name: "" }, testCaller())).rejects.toBeInstanceOf(ValidationError);
    await expect(upsertPerson(db, { name: "X", email: "no-email" }, testCaller())).rejects.toBeInstanceOf(ValidationError);
    await expect(upsertPerson(db, { id: p.id, access_role: "owner" }, testCaller())).rejects.toBeInstanceOf(ValidationError);
    await expect(upsertPerson(db, { id: p.id, function: "QA" }, testCaller(), 99)).rejects.toBeInstanceOf(ConflictError);

    const agent = testCaller({ actor: "mcp:Claude", channel: "mcp", role: "admin" });
    await expect(upsertPerson(db, { id: p.id, access_role: "admin" }, agent)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(upsertPerson(db, { name: "New user", access_role: "editor" }, agent)).rejects.toBeInstanceOf(ForbiddenError);
    const edited = await upsertPerson(db, { id: p.id, function: "Customer QA lead", display_name: "EM" }, agent, 1);
    expect(edited).toMatchObject({ function: "Customer QA lead", display_name: "EM", version: 2, access_role: null });

    const { results } = await db
      .prepare("SELECT * FROM event WHERE entity = 'person' AND entity_id = ? ORDER BY id")
      .bind(p.id)
      .all<EventRow>();
    expect(results.map((e) => e.action)).toEqual(["create", "update"]);
    for (const e of results) {
      expect(e.project_id).toBeNull();
      expect(e.diff_json ?? "").not.toMatch(/erika@example\.com|1234/);
    }
  });

  it("listPersons filters users and deleted rows", async () => {
    const stake = await upsertPerson(db, { name: "Stakeholder Only" }, testCaller());
    await db.prepare("UPDATE person SET deleted_at = '2026-01-01T00:00:00Z' WHERE id = ?").bind(stake.id).run();
    const all = await listPersons(db);
    expect(all.some((p) => p.id === stake.id)).toBe(false);
    expect((await listPersons(db, { include_deleted: true })).some((p) => p.id === stake.id)).toBe(true);
    const users = await listPersons(db, { users_only: true });
    expect(users.length).toBeGreaterThan(0);
    expect(users.every((p) => p.access_role !== null)).toBe(true);
  });

  it("initials come from display_name or name", () => {
    expect(initials({ name: "Jane Doe", display_name: null })).toBe("JD");
    expect(initials({ name: "Anna Maria Beispiel", display_name: null })).toBe("AB");
    expect(initials({ name: "new", display_name: null })).toBe("N");
    expect(initials({ name: "Jane Doe", display_name: "jd" })).toBe("JD");
    expect(initials({ name: "Jane Doe", display_name: "Janie" })).toBe("J");
    expect(initials({ name: "élodie durand", display_name: null })).toBe("ÉD");
  });

  it("service callers act as editor, for a person only via on_behalf_of", async () => {
    expect(await serviceCaller(db, "hook:claude-code")).toEqual({
      actor: "hook:claude-code",
      personId: null,
      role: "editor",
      channel: "service",
    });
    const [person] = await personsByEmail("user@example.com");
    expect((await serviceCaller(db, "hook:claude-code", "USER@example.com")).personId).toBe(person.id);
    expect((await serviceCaller(db, "hook:claude-code", person.id)).personId).toBe(person.id);
    await expect(serviceCaller(db, "hook:claude-code", "nobody@example.com")).rejects.toBeInstanceOf(ValidationError);
    expect(SYSTEM_CALLER).toEqual({ actor: "system", personId: null, role: "admin", channel: "system" });
    expect(isAgent(SYSTEM_CALLER)).toBe(false);
  });

  it("hook calls record no person", async () => {
    const { handleClaudeCodeHook } = await import("../src/api/hooks");
    await handleClaudeCodeHook({ session_id: "s-persons", cwd: "/nowhere/persons-test", reason: "exit" }, env as Env);
    const ev = await db.prepare("SELECT actor, person_id FROM event WHERE entity = 'hook' AND entity_id = 's-persons'").first<EventRow>();
    expect(ev).toEqual({ actor: "hook:claude-code", person_id: null });
  });

  it("ForbiddenError maps to 403 in REST and 'forbidden' in MCP", async () => {
    const e = new ForbiddenError("agents cannot change roles");
    const res = errorResponse(e);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden", message: "agents cannot change roles" });
    expect(JSON.parse(errorText(e))).toEqual({ error: "forbidden", message: "agents cannot change roles" });
  });

  it("ensureUserPerson is idempotent under concurrent first logins", async () => {
    const rows = await Promise.all(Array.from({ length: 5 }, () => ensureUserPerson(db, "race@example.com")));
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
    expect(await personsByEmail("race@example.com")).toHaveLength(1);
  });
});
