// Gate lock until reached (a go before the gate is reached does not open it), milestone WP status lists,
// and the project card's current_gate.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, installTestKeys, serviceJwt, testCaller, userJwt } from "./helpers";
import { gatedPlan } from "./fixtures/gated-plan";
import { createProject, listProjects } from "../src/data/projects";
import { upsertWorkpackage } from "../src/data/workpackages";
import { listMilestones, lockedWpIds, upsertMilestone } from "../src/data/milestones";
import { deleteEntity } from "../src/data/entities";
import { gateLockedWpIds, recordGateDecision } from "../src/data/gates";
import { userCaller } from "../src/auth/caller";
import { ensureUserPerson } from "../src/data/persons";
import { POLICY } from "../src/policy";
import { mcpApiHandler } from "../src/mcp/server";
import { getContextBundle } from "../src/data/context-read";
import type { Caller, Env, Role } from "../src/types";

const db = env.DB;
const SYS = testCaller();
let n = 0;

async function person(email: string, role: Role): Promise<string> {
  const p = await ensureUserPerson(db, email);
  await db.prepare("UPDATE person SET access_role = ? WHERE id = ?").bind(role, p.id).run();
  return p.id;
}

/** The neutral gated plan with M1 as a gate (requires WP1, unlocks WP2); WP1 is left open unless finishWp1. */
async function gated(opts: { finishWp1?: boolean } = {}) {
  const p = await createProject(db, { title: `QoL gate ${++n}`, owner: "Owner", decision_maker: "qdm@example.com" }, SYS);
  const plan = gatedPlan(`${p.id}-`);
  for (const w of plan.wps) await upsertWorkpackage(db, p.id, { ...w }, SYS);
  for (const m of plan.milestones) await upsertMilestone(db, p.id, { ...m, gate: m.title === "M1" }, SYS);
  const id = (s: string) => `${p.id}-${s}`;
  if (opts.finishWp1) await upsertWorkpackage(db, p.id, { id: id("wp1"), status: "done" }, SYS);
  return { p, wp1: id("wp1"), wp2: id("wp2"), m1: id("m1"), m2: id("m2") };
}

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
  const line = text.startsWith("{")
    ? text
    : text
        .split("\n")
        .find((l) => l.startsWith("data: "))!
        .slice(6);
  return JSON.parse(line).result as { isError?: boolean; content: Array<{ text: string }> };
}
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

async function rest(path: string, method: string, payload?: unknown) {
  const res = await call(path, { method, jwt: await userJwt(), ...(payload ? { body: JSON.stringify(payload) } : {}) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> & { current?: { code?: string } } };
}

let DM: Caller;
let userRole: Role | null = null;
beforeAll(async () => {
  await installTestKeys();
  await person("qdm@example.com", "decider");
  userRole = (await ensureUserPerson(db, "user@example.com")).access_role;
  await db.prepare("UPDATE person SET access_role = 'editor' WHERE email = 'user@example.com'").run();
  DM = await userCaller(db, "qdm@example.com");
});
afterAll(async () => {
  await db.prepare("UPDATE person SET access_role = ? WHERE email = 'user@example.com'").bind(userRole).run();
  POLICY.gates.require_decision = true;
});

const lockedIds = async (projectId: string) => [...(await gateLockedWpIds(db, projectId)).keys()];

describe("gate lock until reached", () => {
  it("go before the gate is reached: decision says reached=false, the gate stays closed", async () => {
    const g = await gated();
    const d = await recordGateDecision(db, g.m1, { decision: "go" }, DM);
    expect(d.reached).toBe(false);
    expect(d.baseline_id).toBeTruthy(); // baselines behave as today
    const m1 = (await listMilestones(db, g.p.id)).find((m) => m.id === g.m1)!;
    expect(m1).toMatchObject({ reached: false, reached_at: null, decision_state: "go" });
    expect(await lockedIds(g.p.id)).toEqual([g.wp2]);
    // the bundle lists the gate as closed and not reached
    const md = (await getContextBundle(db, { project_id: g.p.id })).markdown;
    expect(md).toContain(`- M1 (${g.m1}; due ${m1.due_date}; reached: no; latest decision: go)`);
    expect(md).toContain(`- WP2 (${g.wp2}; locked by gate M1)`);
    // reaching the gate (WP1 done) with the go in place opens it
    await upsertWorkpackage(db, g.p.id, { id: g.wp1, status: "done" }, SYS);
    expect((await listMilestones(db, g.p.id)).find((m) => m.id === g.m1)!.reached).toBe(true);
    expect(await lockedIds(g.p.id)).toEqual([]);
    expect((await recordGateDecision(db, g.m1, { decision: "go" }, DM)).reached).toBe(true);
  });

  it("reached + go → unlocked; reached + hold → locked; not reached + no decision → locked", async () => {
    const open = await gated();
    expect(await lockedIds(open.p.id)).toEqual([open.wp2]);
    const g = await gated({ finishWp1: true });
    expect(await lockedIds(g.p.id)).toEqual([g.wp2]);
    await recordGateDecision(db, g.m1, { decision: "go" }, DM);
    expect(await lockedIds(g.p.id)).toEqual([]);
    await recordGateDecision(db, g.m1, { decision: "hold", note_md: "re-check" }, DM);
    expect(await lockedIds(g.p.id)).toEqual([g.wp2]);
  });

  it("dropping the required WP reaches the gate like finishing it", async () => {
    const g = await gated();
    // M1 needs a non-dropped requires WP: add a second one, then drop WP1 and finish the other
    const extra = await upsertWorkpackage(db, g.p.id, { title: "extra" }, SYS);
    await upsertMilestone(db, g.p.id, { id: g.m1, requires: [g.wp1, extra.id] }, SYS);
    await recordGateDecision(db, g.m1, { decision: "go_with_conditions" }, DM);
    await upsertWorkpackage(db, g.p.id, { id: g.wp1, status: "dropped", drop_reason: "not needed" }, SYS);
    expect(await lockedIds(g.p.id)).toEqual([g.wp2]);
    await upsertWorkpackage(db, g.p.id, { id: extra.id, status: "done" }, SYS);
    expect(await lockedIds(g.p.id)).toEqual([]);
  });

  it("policy gates.require_decision=false: reaching unlocks, nothing else changes", async () => {
    const g = await gated();
    POLICY.gates.require_decision = false;
    try {
      expect(await lockedIds(g.p.id)).toEqual([]);
      expect(lockedWpIds(await listMilestones(db, g.p.id)).has(g.wp2)).toBe(true);
      await upsertWorkpackage(db, g.p.id, { id: g.wp1, status: "done" }, SYS);
      expect(lockedWpIds(await listMilestones(db, g.p.id)).has(g.wp2)).toBe(false);
      const r = await mcp("upsert_workpackage", { project_id: g.p.id, id: g.wp2, status: "doing" });
      expect(r.isError).toBeFalsy();
    } finally {
      POLICY.gates.require_decision = true;
    }
  });

  it("agents cannot remove a gate that has an early go (still closed)", async () => {
    const g = await gated();
    await recordGateDecision(db, g.m1, { decision: "go" }, DM);
    for (const args of [{ gate: false }, { unlocks: [] }]) {
      const r = await mcp("upsert_milestone", { project_id: g.p.id, id: g.m1, ...args });
      expect(r.isError).toBe(true);
    }
    const del = await mcp("delete_entity", { entity: "milestone", id: g.m1 });
    expect(del.isError).toBe(true);
  });
});

describe("start writes re-check the lock (go recorded, requires unfinished)", () => {
  it("MCP: all five writes refused with GATE_LOCKED, then succeed once the requires WP is done", async () => {
    const g = await gated();
    const target = await createProject(db, { title: `QoL target ${++n}`, owner: "Owner" }, SYS);
    await recordGateDecision(db, g.m1, { decision: "go" }, DM);
    const writes: Array<[string, Record<string, unknown>]> = [
      ["upsert_workpackage", { project_id: g.p.id, id: g.wp2, status: "doing" }],
      ["upsert_workpackage", { project_id: g.p.id, id: g.wp2, progress: 10 }],
      ["log_progress", { project_id: g.p.id, summary: "worked", workpackage_id: g.wp2, progress: 20 }],
      ["upsert_workpackage", { project_id: g.p.id, title: "started child", parent_id: g.wp2, status: "doing" }],
      ["move_workpackages", { project_id: g.p.id, to_project_id: target.id, ids: [g.wp2] }],
    ];
    for (const [tool, args] of writes) {
      const r = await mcp(tool, args);
      expect(r.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(body(r).current.code).toBe("GATE_LOCKED");
    }
    expect((await db.prepare("SELECT status, progress FROM workpackage WHERE id = ?").bind(g.wp2).first())!).toEqual({
      status: "todo",
      progress: 0,
    });
    await upsertWorkpackage(db, g.p.id, { id: g.wp1, status: "done" }, SYS);
    for (const [tool, args] of writes) {
      const r = await mcp(tool, args);
      expect(r.isError, `${tool} ${JSON.stringify(args)}: ${r.content[0].text}`).toBeFalsy();
    }
    expect((await db.prepare("SELECT project_id FROM workpackage WHERE id = ?").bind(g.wp2).first())!.project_id).toBe(target.id);
  });

  it("REST (dashboard, no override): start writes refused with GATE_LOCKED, then succeed", async () => {
    const g = await gated();
    await recordGateDecision(db, g.m1, { decision: "go" }, DM);
    const writes: Array<[string, string, Record<string, unknown>]> = [
      [`/api/workpackages/${g.wp2}`, "PATCH", { project_id: g.p.id, status: "doing" }],
      [`/api/workpackages/${g.wp2}`, "PATCH", { project_id: g.p.id, progress: 10 }],
      ["/api/progress", "POST", { project_id: g.p.id, summary: "worked", workpackage_id: g.wp2, progress: 20 }],
      ["/api/workpackages", "POST", { project_id: g.p.id, title: "started child", parent_id: g.wp2, status: "doing" }],
    ];
    for (const [path, method, payload] of writes) {
      const r = await rest(path, method, payload);
      expect([r.status, r.json.current?.code], `${method} ${path} ${JSON.stringify(payload)}`).toEqual([409, "GATE_LOCKED"]);
    }
    await upsertWorkpackage(db, g.p.id, { id: g.wp1, status: "done" }, SYS);
    for (const [path, method, payload] of writes) {
      const r = await rest(path, method, payload);
      expect(r.status, `${method} ${path}: ${JSON.stringify(r.json)}`).toBeLessThan(300);
    }
  });
});

describe("move to another project (early go, gate not reached)", () => {
  // SPEC §19: only agents are refused moving a locked WP to another project; a person's move is the
  // dashboard's way to re-plan and is not gate-checked (unchanged by the reached rule). Agents cannot
  // reach the REST route, so the MCP check (above) is the only agent move path.
  const moveSetup = async () => {
    const g = await gated();
    const target = await createProject(db, { title: `QoL move target ${++n}`, owner: "Owner" }, SYS);
    await recordGateDecision(db, g.m1, { decision: "go" }, DM);
    expect(await lockedIds(g.p.id)).toEqual([g.wp2]);
    return { g, target, path: `/api/projects/${g.p.id}/move-workpackages`, payload: { to_project_id: target.id, ids: [g.wp2] } };
  };
  const projectOf = async (id: string) =>
    (await db.prepare("SELECT project_id FROM workpackage WHERE id = ?").bind(id).first<{ project_id: string }>())!.project_id;

  it("REST with a service token: refused 403 before the handler, nothing moves", async () => {
    const { g, path, payload } = await moveSetup();
    const res = await call(path, { method: "POST", jwt: await serviceJwt(), body: JSON.stringify(payload) });
    expect(res.status).toBe(403);
    expect(await projectOf(g.wp2)).toBe(g.p.id);
    expect(await lockedIds(g.p.id)).toEqual([g.wp2]);
  });

  it("REST by a person: not gate-checked, the WP moves and leaves the gate's unlocks", async () => {
    const { g, target, path, payload } = await moveSetup();
    const r = await rest(path, "POST", payload);
    expect([r.status, r.json]).toEqual([200, { moved: [g.wp2] }]);
    expect(await projectOf(g.wp2)).toBe(target.id);
    expect(await lockedIds(g.p.id)).toEqual([]);
    expect((await listMilestones(db, g.p.id)).find((m) => m.id === g.m1)!).toMatchObject({ reached: false, decision_state: "go" });
  });
});

describe("milestone WP status lists", () => {
  it("requires_status / unlocks_status: live WPs in sort order with code, title, status, progress", async () => {
    const g = await gated();
    const a = await upsertWorkpackage(db, g.p.id, { title: "A late", sort: 5, code: "A1", progress: 30 }, SYS);
    const b = await upsertWorkpackage(db, g.p.id, { title: "B early", sort: -1 }, SYS);
    const t = await upsertWorkpackage(db, g.p.id, { title: "trashed" }, SYS);
    await upsertMilestone(db, g.p.id, { id: g.m1, requires: [g.wp1, a.id, b.id, t.id] }, SYS);
    await deleteEntity(db, "workpackage", t.id, SYS);
    const m1 = (await listMilestones(db, g.p.id)).find((m) => m.id === g.m1)!;
    const wp1 = (await db.prepare("SELECT sort FROM workpackage WHERE id = ?").bind(g.wp1).first<{ sort: number }>())!;
    const expected = [
      { id: b.id, code: null, title: "B early", status: "todo", progress: 0, sort: -1 },
      { id: g.wp1, code: null, title: "WP1", status: "todo", progress: 0, sort: wp1.sort },
      { id: a.id, code: "A1", title: "A late", status: "doing", progress: 30, sort: 5 },
    ]
      .sort((x, y) => x.sort - y.sort)
      .map(({ sort: _s, ...rest }) => rest);
    expect(m1.requires_status).toEqual(expected);
    expect(m1.unlocks_status).toEqual([{ id: g.wp2, code: null, title: "WP2", status: "todo", progress: 0 }]);
    // REST and MCP carry the same lists
    const r = await rest(`/api/milestones?project_id=${g.p.id}`, "GET");
    const restM1 = (r.json as unknown as Array<{ id: string; requires_status: unknown; reached: boolean }>).find((m) => m.id === g.m1)!;
    expect(restM1.requires_status).toEqual(expected);
    expect(restM1.reached).toBe(false);
    const proj = body(await mcp("get_project", { id: g.p.id }));
    const mcpM1 = (proj.milestones as Array<{ id: string; unlocks_status: unknown }>).find((m) => m.id === g.m1)!;
    expect(mcpM1.unlocks_status).toEqual(m1.unlocks_status);
  });
});

describe("project card current_gate", () => {
  const card = async (id: string) => (await listProjects(db)).find((p) => p.id === id)!;

  it("earliest-due gate not (reached and go); null when all gates are open or none", async () => {
    const plain = await createProject(db, { title: `QoL plain ${++n}`, owner: "Owner" }, SYS);
    expect((await card(plain.id)).current_gate).toBeNull();

    const g = await gated();
    const m1 = (await listMilestones(db, g.p.id)).find((m) => m.id === g.m1)!;
    expect((await card(g.p.id)).current_gate).toEqual({
      id: g.m1,
      title: "M1",
      due_date: m1.due_date,
      reached: false,
      decision_state: "none",
    });
    await upsertMilestone(db, g.p.id, { id: g.m2, gate: true }, SYS);
    await recordGateDecision(db, g.m1, { decision: "go" }, DM);
    // an early go keeps M1 current
    expect((await card(g.p.id)).current_gate).toMatchObject({ id: g.m1, reached: false, decision_state: "go" });
    await upsertWorkpackage(db, g.p.id, { id: g.wp1, status: "done" }, SYS);
    // M1 reached with go → open; M2 is next
    expect((await card(g.p.id)).current_gate).toMatchObject({ id: g.m2, title: "M2", reached: false, decision_state: "none" });
    // trashed gates are left out
    await deleteEntity(db, "milestone", g.m2, SYS);
    expect((await card(g.p.id)).current_gate).toBeNull();
  });

  it("reached gate without decision is pending; REST and MCP cards carry it", async () => {
    const g = await gated({ finishWp1: true });
    const expected = { id: g.m1, reached: true, decision_state: "pending" };
    expect((await card(g.p.id)).current_gate).toMatchObject(expected);
    const r = await rest("/api/projects", "GET");
    expect((r.json as unknown as Array<{ id: string; current_gate: unknown }>).find((p) => p.id === g.p.id)!.current_gate).toMatchObject(
      expected,
    );
    const list = body(await mcp("list_projects", {}));
    const rows = (Array.isArray(list) ? list : list.projects) as Array<{ id: string; current_gate: unknown }>;
    expect(rows.find((p) => p.id === g.p.id)!.current_gate).toMatchObject(expected);
  });
});
