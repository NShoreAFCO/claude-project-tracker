// F11 (release R5): central role enforcement on REST and MCP (spec §4.2).
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { call, installTestKeys, serviceJwt, testCaller, userJwt } from "./helpers";
import { ACTIONS, REST_ACTIONS, TOOL_ACTIONS, requireAction, type Action } from "../src/auth/permissions";
import { restRouteKeys } from "../src/api/rest";
import { mcpCaller, serviceCaller, userCaller, SYSTEM_CALLER } from "../src/auth/caller";
import { createProject, updateProject } from "../src/data/projects";
import { upsertWorkpackage } from "../src/data/workpackages";
import { upsertMilestone } from "../src/data/milestones";
import { recordGateDecision } from "../src/data/gates";
import { logProgress } from "../src/data/logs";
import { deleteEntity, purgeEntity } from "../src/data/entities";
import { ensureUserPerson, upsertPerson } from "../src/data/persons";
import { mcpApiHandler } from "../src/mcp/server";
import { ForbiddenError } from "../src/data/util";
import type { Caller, Env, Role, WorkpackageRow } from "../src/types";

const db = env.DB;
const SYS = testCaller();
const ROLES: Role[] = ["viewer", "editor", "decider", "admin"];
const email = (role: Role) => `r51-${role}@example.com`;
const ALLOWED = ["user@example.com", ...ROLES.map(email), "r51-switch@example.com"].join(",");
const envOverride = { ALLOWED_EMAILS: ALLOWED };
let n = 0;

async function setRole(addr: string, role: Role | null): Promise<string> {
  const p = await ensureUserPerson(db, addr);
  await db.prepare("UPDATE person SET access_role = ? WHERE id = ?").bind(role, p.id).run();
  return p.id;
}

async function rest(addr: string, method: string, path: string, body?: unknown): Promise<Response> {
  return call(path, {
    method,
    jwt: await userJwt(addr),
    envOverride,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function mcpRpc(addr: string, method: string, params: Record<string, unknown>): Promise<any> {
  const ctx = createExecutionContext() as ExecutionContext & { props?: unknown };
  ctx.props = { email: addr, clientName: "Claude" };
  const res = await mcpApiHandler.fetch(
    new Request("https://tracker.test/mcp", {
      method: "POST",
      headers: {
        Host: "tracker.test",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }),
    }),
    { ...env, ...envOverride } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  const line = text.startsWith("{")
    ? text
    : text
        .split("\n")
        .find((l) => l.startsWith("data: "))!
        .slice(6);
  return JSON.parse(line);
}
const tool = async (addr: string, name: string, args: Record<string, unknown>) =>
  (await mcpRpc(addr, "tools/call", { name, arguments: args })).result as { isError?: boolean; content: Array<{ text: string }> };
const toolError = (r: { isError?: boolean; content: Array<{ text: string }> }): string | null =>
  r.isError ? (r.content[0].text.startsWith("{") ? JSON.parse(r.content[0].text).error : `unparsed: ${r.content[0].text}`) : null;

/** Fixtures for one role's run: a closable project, a gate to decide, a sign_off WP, a stakeholder, a purgeable project. */
async function fixtures() {
  const k = ++n;
  const open = await createProject(db, { title: `R51 close ${k}`, owner: "Owner" }, SYS);
  const gated = await createProject(db, { title: `R51 gate ${k}`, owner: "Owner", decision_maker: "Steering board" }, SYS);
  const gate = await upsertMilestone(db, gated.id, { title: "Go/no-go", gate: true }, SYS);
  const wp = await upsertWorkpackage(db, open.id, { title: "Sign-off deliverable", verification: "sign_off" }, SYS);
  const stakeholder = await upsertPerson(db, { name: `Stakeholder ${k}`, email: `r51-stake-${k}@example.org` }, SYS);
  const trashed = await createProject(db, { title: `R51 trash ${k}`, owner: "Owner" }, SYS);
  await deleteEntity(db, "project", trashed.id, SYS);
  await db.prepare("UPDATE project SET deleted_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(trashed.id).run();
  return { open, gated, gate, wp, stakeholder, trashed };
}

beforeAll(async () => {
  await installTestKeys();
  for (const r of ROLES) await setRole(email(r), r);
});

describe("requireAction: role × action matrix", () => {
  // Expected outcome per caller (true = allowed), in ACTIONS order:
  //                 read   write  decide close  verify_sign_off manage_roles purge
  const EXPECTED: Array<[string, Caller, boolean[]]> = [
    [
      "dashboard viewer",
      { actor: "u", personId: "p", role: "viewer", channel: "dashboard" },
      [true, false, false, false, false, false, false],
    ],
    [
      "dashboard editor",
      { actor: "u", personId: "p", role: "editor", channel: "dashboard" },
      [true, true, false, false, false, false, false],
    ],
    [
      "dashboard decider",
      { actor: "u", personId: "p", role: "decider", channel: "dashboard" },
      [true, true, true, true, true, false, false],
    ],
    ["dashboard admin", { actor: "u", personId: "p", role: "admin", channel: "dashboard" }, [true, true, true, true, true, true, true]],
    ["mcp viewer", { actor: "mcp:c", personId: "p", role: "viewer", channel: "mcp" }, [true, false, false, false, false, false, false]],
    ["mcp editor", { actor: "mcp:c", personId: "p", role: "editor", channel: "mcp" }, [true, true, false, false, false, false, false]],
    ["mcp decider", { actor: "mcp:c", personId: "p", role: "decider", channel: "mcp" }, [true, true, true, true, true, false, false]],
    ["mcp admin", { actor: "mcp:c", personId: "p", role: "admin", channel: "mcp" }, [true, true, true, true, true, false, false]],
    ["service", { actor: "hook:x", personId: null, role: "editor", channel: "service" }, [true, true, false, false, false, false, false]],
    [
      "service on_behalf_of",
      { actor: "hook:x", personId: "p", role: "editor", channel: "service" },
      [true, true, false, false, false, false, false],
    ],
    // defence in depth: a service caller never gains decider rights, even with a higher role on the caller
    [
      "service (role admin)",
      { actor: "hook:x", personId: "p", role: "admin", channel: "service" },
      [true, true, false, false, false, false, false],
    ],
    ["system", SYSTEM_CALLER, [true, true, true, true, true, true, true]],
    [
      "no role (dashboard)",
      { actor: "u", personId: "p", role: null, channel: "dashboard" },
      [false, false, false, false, false, false, false],
    ],
    ["no role (mcp)", { actor: "mcp:c", personId: null, role: null, channel: "mcp" }, [false, false, false, false, false, false, false]],
  ];

  it.each(EXPECTED)("%s", (_label, caller, expected) => {
    const got = ACTIONS.map((a) => {
      try {
        requireAction(caller, a);
        return true;
      } catch (e) {
        expect(e).toBeInstanceOf(ForbiddenError);
        expect((e as ForbiddenError).status).toBe(403);
        return false;
      }
    });
    expect(got).toEqual(expected);
  });

  it("an unknown action is refused (fail closed)", () => {
    expect(() => requireAction(SYSTEM_CALLER, "teleport" as Action)).toThrow(ForbiddenError);
    expect(() => requireAction(SYSTEM_CALLER, undefined as unknown as Action)).toThrow(ForbiddenError);
    // inherited object keys are neither actions nor roles
    expect(() => requireAction(SYSTEM_CALLER, "constructor" as Action)).toThrow(ForbiddenError);
    expect(() => requireAction({ ...SYSTEM_CALLER, role: "toString" as Role }, "read")).toThrow(ForbiddenError);
  });
});

describe("every route and tool has exactly one Action", () => {
  it("REST routes and REST_ACTIONS match one to one", () => {
    const keys = restRouteKeys();
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => !(k in REST_ACTIONS))).toEqual([]);
    expect(Object.keys(REST_ACTIONS).filter((k) => !keys.includes(k))).toEqual([]);
    for (const a of Object.values(REST_ACTIONS)) expect(ACTIONS).toContain(a);
  });

  it("MCP tools and TOOL_ACTIONS match one to one; read tools are exactly the read-only ones", async () => {
    const tools = (await mcpRpc("user@example.com", "tools/list", {})).result.tools as Array<{
      name: string;
      annotations?: { readOnlyHint?: boolean };
    }>;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(Object.keys(TOOL_ACTIONS).sort());
    for (const t of tools) expect([t.name, TOOL_ACTIONS[t.name] === "read"]).toEqual([t.name, !!t.annotations?.readOnlyHint]);
    // agents never get a purge or role-management tool
    expect(Object.values(TOOL_ACTIONS).filter((a) => a === "purge" || a === "manage_roles")).toEqual([]);
  });
});

describe("REST enforcement per role", () => {
  it.each(ROLES)("%s", async (role) => {
    const f = await fixtures();
    const me = email(role);
    const at = (r: Role) => ROLES.indexOf(role) >= ROLES.indexOf(r);
    // read
    expect((await rest(me, "GET", "/api/projects")).status).toBe(200);
    expect((await rest(me, "GET", `/api/projects/${f.open.id}`)).status).toBe(200);
    // write
    const created = await rest(me, "POST", "/api/projects", { title: `R51 new ${role} ${n}` });
    expect(created.status).toBe(at("editor") ? 201 : 403);
    // verify_sign_off: completing a sign_off WP
    const done = await rest(me, "PATCH", `/api/workpackages/${f.wp.id}`, { project_id: f.open.id, status: "done" });
    expect(done.status).toBe(at("decider") ? 200 : 403);
    // close
    const closed = await rest(me, "PATCH", `/api/projects/${f.open.id}`, { status: "abandoned", closure_note_md: "stopped" });
    expect(closed.status).toBe(at("decider") ? 200 : 403);
    // decide
    const decided = await rest(me, "POST", `/api/milestones/${f.gate.id}/decisions`, { decision: "hold", note_md: "Steering board: hold" });
    expect(decided.status).toBe(at("decider") ? 201 : 403);
    // manage_roles
    const granted = await rest(me, "PATCH", `/api/persons/${f.stakeholder.id}`, { access_role: "viewer" });
    expect(granted.status).toBe(at("admin") ? 200 : 403);
    // purge
    const purged = await rest(me, "DELETE", `/api/trash/project/${f.trashed.id}`);
    expect(purged.status).toBe(at("admin") ? 200 : 403);
    // own UI preferences stay possible for every role
    expect((await rest(me, "PATCH", "/api/persons/me", { locale: "en" })).status).toBe(200);
  });

  it("a viewer's refused write leaves no trace", async () => {
    const f = await fixtures();
    const res = await rest(email("viewer"), "PATCH", `/api/projects/${f.open.id}`, { title: "hijacked" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
    const row = await db
      .prepare("SELECT title, version FROM project WHERE id = ?")
      .bind(f.open.id)
      .first<{ title: string; version: number }>();
    expect(row).toEqual({ title: f.open.title, version: f.open.version });
  });

  it("the hook endpoint needs the editor role for a logged-in user; service tokens act as editor", async () => {
    const hook = { session_id: "s-r51", cwd: "/nowhere/r51", reason: "exit" };
    const asViewer = await call("/api/hooks/claude-code", {
      method: "POST",
      jwt: await userJwt(email("viewer")),
      envOverride,
      body: JSON.stringify(hook),
    });
    expect(asViewer.status).toBe(403);
    const asEditor = await call("/api/hooks/claude-code", {
      method: "POST",
      jwt: await userJwt(email("editor")),
      envOverride,
      body: JSON.stringify(hook),
    });
    expect(asEditor.status).toBe(200);
    const asService = await call("/api/hooks/claude-code", { method: "POST", jwt: await serviceJwt(), body: JSON.stringify(hook) });
    expect(asService.status).toBe(200);
  });
});

describe("MCP enforcement per role", () => {
  it.each(ROLES)("%s", async (role) => {
    const f = await fixtures();
    const me = email(role);
    const at = (r: Role) => ROLES.indexOf(role) >= ROLES.indexOf(r);
    const expectAllowed = (r: { isError?: boolean; content: Array<{ text: string }> }, allowed: boolean) =>
      expect([toolError(r), allowed]).toEqual([allowed ? null : "forbidden", allowed]);
    // read
    expectAllowed(await tool(me, "list_projects", {}), true);
    expectAllowed(await tool(me, "get_project", { id: f.open.id }), true);
    // write
    expectAllowed(await tool(me, "create_project", { title: `R51 mcp ${role} ${n}` }), at("editor"));
    // verify_sign_off (the OAuth login's person verifies)
    expectAllowed(await tool(me, "upsert_workpackage", { project_id: f.open.id, id: f.wp.id, status: "done" }), at("decider"));
    // close
    expectAllowed(
      await tool(me, "update_project", { id: f.open.id, patch: { status: "abandoned", closure_note_md: "stopped" } }),
      at("decider"),
    );
    // decide (as the OAuth login's person)
    expectAllowed(
      await tool(me, "record_gate_decision", { milestone_id: f.gate.id, decision: "hold", note_md: "Steering board: hold" }),
      at("decider"),
    );
    // manage_roles: agents never delete (deactivate) a user, not even with an admin login
    const user = await ensureUserPerson(db, "user@example.com");
    expectAllowed(await tool(me, "delete_entity", { kind: "person", id: user.id, confirm: true }), false);
    expect(toolError(await tool(me, "upsert_person", { id: f.stakeholder.id, comment: "seen" }))).toBe(at("editor") ? null : "forbidden");
  });

  it("viewer cannot write via MCP", async () => {
    const f = await fixtures();
    const viewer = email("viewer");
    const writes: Array<[string, Record<string, unknown>]> = [
      ["create_project", { title: "Viewer project" }],
      ["update_project", { id: f.open.id, patch: { title: "renamed by viewer" } }],
      ["upsert_workpackage", { project_id: f.open.id, title: "Viewer WP" }],
      ["upsert_milestone", { project_id: f.open.id, title: "Viewer milestone" }],
      ["upsert_risk", { project_id: f.open.id, title: "Viewer risk" }],
      ["log_progress", { project_id: f.open.id, summary: "viewer progress" }],
      ["write_context", { owner_kind: "project", owner_id: f.open.id, title: "Viewer doc", content_md: "x" }],
      ["upsert_person", { name: "Viewer stakeholder" }],
      ["delete_entity", { kind: "workpackage", id: f.wp.id, confirm: true }],
      ["set_scores", { project_id: f.open.id, scores: [{ criterion: "value", value: 5 }] }],
    ];
    for (const [name, args] of writes) expect([name, toolError(await tool(viewer, name, args))]).toEqual([name, "forbidden"]);
    const row = await db
      .prepare("SELECT title, version FROM project WHERE id = ?")
      .bind(f.open.id)
      .first<{ title: string; version: number }>();
    expect(row).toEqual({ title: f.open.title, version: f.open.version });
    expect(
      (await db.prepare("SELECT deleted_at FROM workpackage WHERE id = ?").bind(f.wp.id).first<WorkpackageRow>())!.deleted_at,
    ).toBeNull();
  });
});

describe("service callers", () => {
  it("service caller acts as editor and can never decide/close/verify sign_off", async () => {
    const f = await fixtures();
    const decider = await ensureUserPerson(db, email("decider"));
    for (const svc of [await serviceCaller(db, "hook:claude-code"), await serviceCaller(db, "hook:claude-code", decider.id)]) {
      expect(svc.role).toBe("editor");
      // ordinary writes work
      const wp = await upsertWorkpackage(db, f.open.id, { title: `svc ${svc.personId ?? "none"}` }, svc);
      expect(wp.status).toBe("todo");
      // decide
      await expect(recordGateDecision(db, f.gate.id, { decision: "hold", note_md: "Steering board" }, svc)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      // close
      await expect(updateProject(db, f.open.id, { status: "abandoned", closure_note_md: "stopped" }, svc)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(
        createProject(db, { title: `svc closed ${++n}`, status: "abandoned", closure_note_md: "never started" }, svc),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    // verify sign_off: refused with on_behalf_of a decider, via upsert and via log_progress (Ruling 42 covers review/test/demo only)
    const asDecider = await serviceCaller(db, "hook:claude-code", decider.id);
    await expect(upsertWorkpackage(db, f.open.id, { id: f.wp.id, status: "done" }, asDecider)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      logProgress(db, { project_id: f.open.id, workpackage_id: f.wp.id, summary: "finished", progress: 100 }, asDecider),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const row = (await db.prepare("SELECT * FROM workpackage WHERE id = ?").bind(f.wp.id).first<WorkpackageRow>())!;
    expect([row.status, row.verified_by]).toEqual(["todo", null]);
    const p = (await db.prepare("SELECT status FROM project WHERE id = ?").bind(f.open.id).first<{ status: string }>())!;
    expect(p.status).not.toBe("abandoned");
    // still allowed: completing a review WP for the on_behalf_of person (Ruling 42)
    const review = await upsertWorkpackage(db, f.open.id, { title: "Reviewed", verification: "review" }, SYS);
    const out = await logProgress(db, { project_id: f.open.id, workpackage_id: review.id, summary: "ok", progress: 100 }, asDecider);
    expect([out.workpackage!.status, out.workpackage!.verified_by]).toEqual(["done", decider.id]);
    // purge and role changes stay refused
    await expect(purgeEntity(db, "project", f.trashed.id, asDecider)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(upsertPerson(db, { id: f.stakeholder.id, access_role: "viewer" }, asDecider)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("data-layer checks for content-dependent actions", () => {
  it("an editor cannot close a project, verify or waive a sign_off; a decider can", async () => {
    const f = await fixtures();
    const editor = await userCaller(db, email("editor"));
    const decider = await userCaller(db, email("decider"));
    await expect(updateProject(db, f.open.id, { status: "abandoned", closure_note_md: "x" }, editor)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      createProject(db, { title: `editor closed ${++n}`, status: "abandoned", closure_note_md: "never started" }, editor),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // completing, naming a verifier, re-dating and lowering (waiving) a sign_off all need verify_sign_off
    await expect(upsertWorkpackage(db, f.open.id, { id: f.wp.id, status: "done" }, editor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      upsertWorkpackage(db, f.open.id, { id: f.wp.id, status: "done", verified_by: decider.personId }, editor),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(upsertWorkpackage(db, f.open.id, { id: f.wp.id, verification: "review" }, editor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      logProgress(db, { project_id: f.open.id, workpackage_id: f.wp.id, summary: "done", progress: 100 }, editor),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      upsertWorkpackage(db, f.open.id, { title: "Born signed", verification: "sign_off", status: "done" }, editor),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // editors keep raising to sign_off and editing a signed-off WP without touching the verification
    const raised = await upsertWorkpackage(db, f.open.id, { title: "Raise me", verification: "review" }, editor);
    expect((await upsertWorkpackage(db, f.open.id, { id: raised.id, verification: "sign_off" }, editor)).verification).toBe("sign_off");
    const signed = await upsertWorkpackage(db, f.open.id, { id: f.wp.id, status: "done" }, decider);
    expect([signed.status, signed.verified_by]).toEqual(["done", decider.personId]);
    expect((await upsertWorkpackage(db, f.open.id, { id: f.wp.id, description_md: "notes" }, editor)).verified_by).toBe(decider.personId);
    await expect(upsertWorkpackage(db, f.open.id, { id: f.wp.id, verified_at: "2026-01-01" }, editor)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    // a decider closes
    expect((await updateProject(db, f.open.id, { status: "abandoned", closure_note_md: "stopped" }, decider)).status).toBe("abandoned");
  });

  it("a log_progress completion whose WP became sign_off after the read is refused for an editor", async () => {
    const f = await fixtures();
    const wp = await upsertWorkpackage(db, f.open.id, { title: "Turns sign_off", verification: "review" }, SYS);
    const editor = await userCaller(db, email("editor"));
    const { setBeforeProgressWriteForTesting } = await import("../src/data/logs");
    setBeforeProgressWriteForTesting(async () => {
      await db.prepare("UPDATE workpackage SET verification = 'sign_off' WHERE id = ?").bind(wp.id).run();
    });
    try {
      await expect(
        logProgress(db, { project_id: f.open.id, workpackage_id: wp.id, summary: "done", progress: 100 }, editor),
      ).rejects.toBeInstanceOf(ForbiddenError);
    } finally {
      setBeforeProgressWriteForTesting(null);
    }
    const row = (await db.prepare("SELECT * FROM workpackage WHERE id = ?").bind(wp.id).first<WorkpackageRow>())!;
    expect([row.status, row.progress, row.verified_by]).toEqual(["todo", 0, null]);
  });
});

describe("reopening a closed project (Ruling 47)", () => {
  /** A project closed by the system: one abandoned, one done. */
  async function closedProjects() {
    const k = ++n;
    const abandoned = await createProject(db, { title: `R51 reopen a ${k}`, owner: "Owner" }, SYS);
    await updateProject(db, abandoned.id, { status: "abandoned", closure_note_md: "stopped" }, SYS);
    const done = await createProject(db, { title: `R51 reopen d ${k}`, owner: "Owner" }, SYS);
    await updateProject(db, done.id, { status: "done", closure_note_md: "shipped", lessons_learned_md: "none" }, SYS);
    return [abandoned.id, done.id];
  }
  const statusOf = async (id: string) =>
    (await db.prepare("SELECT status FROM project WHERE id = ?").bind(id).first<{ status: string }>())!.status;

  it("editor cannot reopen a closed project", async () => {
    const editor = await userCaller(db, email("editor"));
    for (const id of await closedProjects()) {
      const before = await statusOf(id);
      for (const status of ["idea", "active", "on_hold"])
        await expect(updateProject(db, id, { status }, editor)).rejects.toBeInstanceOf(ForbiddenError);
      // over REST and MCP as well
      expect((await rest(email("editor"), "PATCH", `/api/projects/${id}`, { status: "idea" })).status).toBe(403);
      expect(toolError(await tool(email("editor"), "update_project", { id, patch: { status: "idea" } }))).toBe("forbidden");
      expect(await statusOf(id)).toBe(before);
      // other edits of a closed project stay ordinary writes
      expect((await updateProject(db, id, { summary: "edited while closed" }, editor)).status).toBe(before);
    }
  });

  it("decider can reopen", async () => {
    const [abandoned, done] = await closedProjects();
    const decider = await userCaller(db, email("decider"));
    expect((await updateProject(db, abandoned, { status: "idea" }, decider)).status).toBe("idea");
    expect((await rest(email("decider"), "PATCH", `/api/projects/${done}`, { status: "on_hold" })).status).toBe(200);
    expect(await statusOf(done)).toBe("on_hold");
  });

  it("service caller cannot reopen", async () => {
    const decider = await ensureUserPerson(db, email("decider"));
    for (const svc of [await serviceCaller(db, "hook:claude-code"), await serviceCaller(db, "hook:claude-code", decider.id)])
      for (const id of await closedProjects()) {
        const before = await statusOf(id);
        await expect(updateProject(db, id, { status: "idea" }, svc)).rejects.toBeInstanceOf(ForbiddenError);
        expect(await statusOf(id)).toBe(before);
      }
  });
});

describe("role change takes effect on next request", () => {
  it("REST: the next request uses the new role", async () => {
    const addr = "r51-switch@example.com";
    const id = await setRole(addr, "editor");
    expect((await rest(addr, "POST", "/api/projects", { title: `Switch ${++n}` })).status).toBe(201);
    // an admin demotes the user in the dashboard
    const admin = await userCaller(db, email("admin"));
    const p = (await db.prepare("SELECT version FROM person WHERE id = ?").bind(id).first<{ version: number }>())!;
    expect((await upsertPerson(db, { id, access_role: "viewer" }, admin, p.version)).access_role).toBe("viewer");
    expect((await rest(addr, "POST", "/api/projects", { title: `Switch ${++n}` })).status).toBe(403);
    expect((await rest(addr, "GET", "/api/projects")).status).toBe(200);
    await setRole(addr, "editor");
    expect((await rest(addr, "POST", "/api/projects", { title: `Switch ${++n}` })).status).toBe(201);
  });

  it("MCP: the next request uses the new role (the grant props carry no role)", async () => {
    const addr = "r51-switch@example.com";
    await setRole(addr, "editor");
    expect(toolError(await tool(addr, "create_project", { title: `Switch mcp ${++n}` }))).toBeNull();
    await setRole(addr, "viewer");
    expect(toolError(await tool(addr, "create_project", { title: `Switch mcp ${++n}` }))).toBe("forbidden");
    await setRole(addr, "decider");
    const f = await fixtures();
    expect(
      toolError(await tool(addr, "update_project", { id: f.open.id, patch: { status: "abandoned", closure_note_md: "x" } })),
    ).toBeNull();
    await setRole(addr, "editor");
    const caller = await mcpCaller(db, { email: addr, clientName: "Claude" });
    expect(caller.role).toBe("editor");
  });
});
