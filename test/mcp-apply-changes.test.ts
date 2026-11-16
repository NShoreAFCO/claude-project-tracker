// apply_changes: one call, up to 100 wp/ms upserts, all or nothing, same checks as the single tools.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { testCaller } from "./helpers";
import { mcpApiHandler } from "../src/mcp/server";
import { createProject } from "../src/data/projects";
import { upsertWorkpackage } from "../src/data/workpackages";
import { upsertMilestone } from "../src/data/milestones";
import { gateLockedWpIds, recordGateDecision } from "../src/data/gates";
import { setAfterScheduleReadForTesting } from "../src/data/schedule";
import { applyChanges, setAfterPlanForTesting } from "../src/data/apply-changes";
import { ensureUserPerson } from "../src/data/persons";
import { userCaller } from "../src/auth/caller";
import { TOOL_ACTIONS, toolAction } from "../src/auth/permissions";
import type { Env, Role } from "../src/types";

const db = (env as Env).DB;
const SYS = testCaller();
const LOGIN = "user@example.com";
let rid = 0;
let n = 0;

async function rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const ctx = createExecutionContext() as ExecutionContext & { props?: unknown };
  ctx.props = { email: LOGIN, clientName: "Claude Test" };
  const res = await mcpApiHandler.fetch(
    new Request("https://tracker.test/mcp", {
      method: "POST",
      headers: {
        Host: "tracker.test",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }),
    }),
    env as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return text.startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
}
const call = async (name: string, args: Record<string, unknown>) => (await rpc("tools/call", { name, arguments: args })).result;
const ok = async (name: string, args: Record<string, unknown>) => {
  const r = await call(name, args);
  expect(r.isError, r.content?.[0]?.text).toBeFalsy();
  return JSON.parse(r.content[0].text);
};
type Op = Record<string, unknown>;
const apply = (project_id: string, ops: Op[]) => ok("apply_changes", { project_id, ops });
const counts = async (pid: string) =>
  (await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM workpackage WHERE project_id = ?1) AS wps, (SELECT COUNT(*) FROM milestone WHERE project_id = ?1) AS ms,
        (SELECT COUNT(*) FROM event WHERE project_id = ?1) AS ev, (SELECT COUNT(*) FROM milestone_link l JOIN milestone m ON m.id = l.milestone_id WHERE m.project_id = ?1) AS links,
        (SELECT COUNT(*) FROM wp_stakeholder s JOIN workpackage w ON w.id = s.workpackage_id WHERE w.project_id = ?1) AS stake,
        (SELECT group_concat(id || ':' || version || ':' || status, ',') FROM (SELECT * FROM workpackage WHERE project_id = ?1 ORDER BY id)) AS rows,
        (SELECT last_changed_at FROM project WHERE id = ?1) AS changed, (SELECT schedule_rev FROM project WHERE id = ?1) AS rev`,
    )
    .bind(pid)
    .first())!;
/** Expects a refusal naming op `index` with `code`, and that nothing of the project changed. */
async function refused(pid: string, ops: Op[], code: string, index: number | null, error?: string, raced = false): Promise<any> {
  // raced: the test seam writes meanwhile (a decision event), so only the rows are compared.
  const state = async () => {
    const c: Record<string, unknown> = { ...(await counts(pid)) };
    if (raced) for (const k of ["ev", "changed", "rev"]) delete c[k];
    return c;
  };
  const before = await state();
  const r = await call("apply_changes", { project_id: pid, ops });
  expect(r.isError, r.content[0].text).toBe(true);
  const out = JSON.parse(r.content[0].text);
  expect(out.message).toMatch(/Nothing was applied\.$/);
  expect(out.failed?.code, r.content[0].text).toBe(code);
  expect(out.failed.index).toBe(index);
  if (error) expect(out.error).toBe(error);
  expect(await state()).toEqual(before);
  return out;
}
const project = async (extra: Record<string, unknown> = {}) =>
  (await createProject(db, { title: `Batch ${++n}`, owner: "Owner", decision_maker: "dm-batch@example.com", ...extra }, SYS)).id;
const wp = async (pid: string, input: Record<string, unknown>) => (await upsertWorkpackage(db, pid, input, SYS)).id;
const ms = async (pid: string, input: Record<string, unknown>) => (await upsertMilestone(db, pid, input, SYS)).id;
async function person(email: string, role: Role | null, name?: string): Promise<string> {
  const p = await ensureUserPerson(db, email);
  await db.prepare("UPDATE person SET access_role = ?, name = COALESCE(?, name) WHERE id = ?").bind(role, name ?? null, p.id).run();
  return p.id;
}
const loginId = async () => (await db.prepare("SELECT id FROM person WHERE email = ?").bind(LOGIN).first<{ id: string }>())!.id;
const DM = () => userCaller(db, "dm-batch@example.com");
const row = async (id: string) => (await db.prepare("SELECT * FROM workpackage WHERE id = ?").bind(id).first<any>())!;
const events = async (pid: string) =>
  (await db.prepare("SELECT * FROM event WHERE project_id = ? ORDER BY id").bind(pid).all<any>()).results;

beforeAll(async () => {
  await person(LOGIN, "editor");
  await person("dm-batch@example.com", "decider", "Dee Batch");
  await person("ann.parity@example.com", null, "Ann Parity");
  await person("bob.parity@example.com", null, "Bob Parity");
  await person("cy.parity@example.com", null, "Cy Parity");
});
afterEach(() => {
  setAfterScheduleReadForTesting(null);
  setAfterPlanForTesting(null);
});

/** A closed gate G (requires a, unlocks b; b1 under b) plus a free WP c and a started WP s. */
async function gatedProject() {
  const pid = await project();
  const a = await wp(pid, { code: "A", title: "Required" });
  const b = await wp(pid, { code: "B", title: "Behind the gate" });
  const b1 = await wp(pid, { code: "B1", title: "Sub of b", parent_id: b });
  const c = await wp(pid, { code: "C", title: "Free" });
  const s = await wp(pid, { code: "S", title: "Started", status: "doing" });
  const g = await ms(pid, { title: "G", gate: true, requires: [a], unlocks: [b] });
  return { pid, a, b, b1, c, s, g };
}

// ---- 20-op build: ops, and the same 20 single calls with ids filled in.
const BUILD: Op[] = [
  { op: "wp", code: "WP3", title: "Build", owner: "Ann Parity" },
  { op: "wp", code: "WP3.1", title: "Planning", parent_id: "@WP3" },
  { op: "wp", code: "WP3.2", title: "Review", parent_id: "@WP3", depends_on: ["@WP3.1"], owner: "bob.parity@example.com" },
  { op: "wp", code: "T01", title: "Task one", parent_id: "@WP3.1", priority_stakeholders: ["cy.parity@example.com"] },
  { op: "wp", code: "T02", title: "Task two", parent_id: "@WP3.1", depends_on: ["@T01"], start_date: "2026-03-01", end_date: "2026-03-10" },
  { op: "wp", code: "WP4", title: "Ship" },
  { op: "wp", code: "WP4.1", title: "Ship planning", parent_id: "@WP4" },
  { op: "wp", ref: "t3", code: "T03", title: "Task three", parent_id: "@WP4.1" },
  { op: "wp", code: "T04", title: "Task four", parent_id: "@WP4.1", depends_on: ["@t3"] },
  { op: "wp", code: "WP5", title: "Run" },
  { op: "wp", code: "WP5.1", title: "Run planning", parent_id: "@WP5" },
  { op: "wp", code: "T05", title: "Task five", parent_id: "@WP5.1", deliverable: "A report", acceptance_criteria_md: "- read" },
  { op: "wp", code: "T06", title: "Task six", parent_id: "@WP5.1", status: "done", verification: "review", verified_by: LOGIN },
  { op: "wp", code: "T07", title: "Task seven", parent_id: "@WP5.1", progress: 40 },
  { op: "wp", code: "T08", title: "Task eight", parent_id: "@WP4.1", status: "dropped", drop_reason: "not needed" },
  { op: "wp", code: "T09", title: "Task nine", parent_id: "@WP3.2", weight: 2, category: undefined },
  { op: "wp", code: "T10", title: "Task ten", parent_id: "@WP3.2", effort_planned_pd: 3 },
  { op: "ms", title: "M1", requires: ["@WP3.1"], due_date: "2026-04-01" },
  { op: "ms", ref: "gate", title: "Gate", gate: true, requires: ["@WP3"], unlocks: ["@WP4"] },
  { op: "ms", title: "M3", workpackage_id: "@WP5" },
].map((o) => JSON.parse(JSON.stringify(o)));

async function singleCalls(pid: string): Promise<void> {
  const ids = new Map<string, string>();
  const sub = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sub) : typeof v === "string" && v.startsWith("@") ? ids.get(v.slice(1)) : v;
  for (const { op, ref, ...f } of BUILD) {
    const args: Record<string, unknown> = { project_id: pid };
    for (const [k, v] of Object.entries(f)) args[k] = sub(v);
    const out = await ok(op === "wp" ? "upsert_workpackage" : "upsert_milestone", args);
    for (const k of [ref, f.code]) if (typeof k === "string") ids.set(k, out.id);
  }
}
/** A project's stored state with every id replaced by a stable name and timestamps dropped. */
async function snapshot(pid: string): Promise<unknown> {
  const full = await ok("get_project", { id: pid, view: "full" });
  const names = new Map<string, string>();
  const walk = (v: any): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      if (typeof v.id === "string" && typeof v.title === "string") names.set(v.id, v.code ?? v.title);
      Object.values(v).forEach(walk);
    }
  };
  walk(full.workpackages);
  walk(full.milestones);
  const norm = (v: any, k = ""): any => {
    if (Array.isArray(v)) return v.map((x) => norm(x));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .filter(([key]) => !/(_at|^id$|^project_id$|^ts$|^last_.*)$/.test(key))
          .map(([key, x]) => [key, norm(x, key)]),
      );
    if (typeof v === "string") {
      if (names.has(v)) return names.get(v);
      if (/^\d{4}-\d{2}-\d{2}T/.test(v) || k === "actual_start" || k === "actual_end") return "<ts>";
      return v.replaceAll(pid, "<p>");
    }
    return v;
  };
  const evs = (await events(pid))
    .filter((e) => e.entity !== "project")
    .map((e) => {
      const d = e.diff_json ? JSON.parse(e.diff_json) : null;
      return { entity: e.entity, action: e.action, summary: e.summary, actor: e.actor, person: e.person_id, diff: norm(d) };
    });
  return { wps: norm(full.workpackages), ms: norm(full.milestones), events: norm(evs) };
}

describe("apply_changes: happy path", () => {
  it("a 20-op build stores the same rows and events as 20 single calls", async () => {
    const a = await project();
    const b = await project();
    const t0 = Date.now();
    const out = await apply(a, BUILD);
    expect(out.warnings).toBeUndefined();
    expect(out.ops).toHaveLength(20);
    expect(out.ops[7].ref).toBe("t3");
    expect(out.ops[18].ref).toBe("gate");
    expect(out.ops.filter((l: any) => "ref" in l)).toHaveLength(2);
    expect(out.ops[0]).toEqual({ id: expect.any(String), code: "WP3", version: 1 });
    expect(out.ops[12].verified_by).toBeUndefined();
    expect((await row(out.ops[12].id)).verified_by).toBe(await loginId());
    expect(out.ops[13]).toMatchObject({ code: "T07", status: "doing", actual_start: expect.any(String) });
    expect(Date.now() - t0).toBeLessThan(30_000);
    await singleCalls(b);
    const sa: any = await snapshot(a);
    expect(sa.wps.length).toBeGreaterThan(2);
    expect(sa.ms).toHaveLength(3);
    expect(sa.events).toHaveLength(20);
    expect(JSON.stringify(sa)).toContain("Ann Parity");
    expect(sa).toEqual(await snapshot(b));
    // Person lookups in memory: owner by name and by email, stakeholder by email, verified_by by email.
    const t01 = (await row(out.ops[3].id)) as any;
    const st = await db.prepare("SELECT person_id FROM wp_stakeholder WHERE workpackage_id = ?").bind(t01.id).all<any>();
    expect(st.results).toHaveLength(1);
    expect((await row(out.ops[0].id)).owner_person_id).toBeTruthy();
    expect((await row(out.ops[2].id)).owner_person_id).toBeTruthy();
    // Audit: one event per op, in array order, actor mcp:<client>, the login's person.
    const ev = (await events(a)).filter((e) => e.entity !== "project");
    expect(ev.map((e) => e.entity_id)).toEqual(out.ops.map((l: any) => l.id));
    expect(new Set(ev.map((e) => e.actor))).toEqual(new Set(["mcp:Claude Test"]));
    expect(new Set(ev.map((e) => e.person_id))).toEqual(new Set([await loginId()]));
  }, 60_000);

  it("@code names stored WPs: reparent two stored WPs under a new one", async () => {
    const pid = await project();
    const s1 = await wp(pid, { code: "S1", title: "One" });
    const s2 = await wp(pid, { code: "S2", title: "Two" });
    const out = await apply(pid, [
      { op: "wp", code: "NEW", title: "New parent" },
      { op: "wp", wp_code: "S1", parent_id: "@NEW" },
      { op: "wp", id: s2, parent_id: "@NEW" },
    ]);
    expect((await row(s1)).parent_id).toBe(out.ops[0].id);
    expect((await row(s2)).parent_id).toBe(out.ops[0].id);
    expect(out.ops[1]).toEqual({ id: s1, code: "S1", version: 2 });
  });

  it("updates by wp_code and id; an empty diff keeps the version and writes no event; replaces stakeholders and links", async () => {
    const pid = await project();
    const ann = await person("ann.parity@example.com", null);
    const bob = await person("bob.parity@example.com", null);
    const x = await wp(pid, { code: "X", title: "X", priority_stakeholders: [ann] });
    const y = await wp(pid, { code: "Y", title: "Y" });
    const z = await wp(pid, { code: "Z", title: "Z" });
    const m = await ms(pid, { title: "Links", requires: [x], unlocks: [y] });
    const before = (await events(pid)).length;
    const out = await apply(pid, [
      { op: "wp", wp_code: "X", priority_stakeholders: ["bob.parity@example.com"] },
      { op: "wp", id: y, title: "Y" },
      { op: "ms", id: m, requires: [y], unlocks: ["@Z"] },
    ]);
    expect(out.ops[1]).toEqual({ id: y, code: "Y", version: 1 });
    expect(out.ops[2].version).toBe(2);
    const ev = (await events(pid)).slice(before).filter((e) => e.entity !== "project");
    expect(ev).toHaveLength(2);
    expect(JSON.parse(ev[0].diff_json)).toEqual({ priority_stakeholders: [[ann], [bob]] });
    expect(JSON.parse(ev[1].diff_json)).toEqual({ requires: [[x], [y]], unlocks: [[y], [z]] });
    const st = await db.prepare("SELECT person_id FROM wp_stakeholder WHERE workpackage_id = ?").bind(x).all<any>();
    expect(st.results.map((r) => r.person_id)).toEqual([bob]);
    const links = await db.prepare("SELECT workpackage_id, role FROM milestone_link WHERE milestone_id = ? ORDER BY role").bind(m).all<any>();
    expect(links.results).toEqual([
      { workpackage_id: y, role: "requires" },
      { workpackage_id: z, role: "unlocks" },
    ]);
  });

  it("echoes the fields the server set: auto doing and actual_start; done gives progress 100 and actual_end", async () => {
    const pid = await project();
    const t = await wp(pid, { code: "T", title: "T" });
    const d = await wp(pid, { code: "D", title: "D" });
    const out = await apply(pid, [
      { op: "wp", id: t, progress: 40 },
      { op: "wp", id: d, status: "done" },
    ]);
    expect(out.ops[0]).toMatchObject({ status: "doing", actual_start: expect.any(String) });
    expect(out.ops[0].progress).toBeUndefined();
    expect(out.ops[1]).toMatchObject({ progress: 100, actual_end: expect.any(String) });
    expect(out.ops[1].status).toBeUndefined();
  });

  it("returns schedule warnings tagged with the op", async () => {
    const pid = await project();
    const out = await apply(pid, [
      { op: "wp", code: "A", title: "A", start_date: "2026-05-01", end_date: "2026-05-10" },
      { op: "wp", code: "B", title: "B", start_date: "2026-05-05", end_date: "2026-05-20", depends_on: ["@A"] },
    ]);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatchObject({ op: 1, code: "DEP_START_BEFORE_PRED_END", entity_id: out.ops[1].id });
  });

  it("a 100-op call (local timing)", async () => {
    const pid = await project();
    const ops: Op[] = [{ op: "wp", code: "R", title: "Root" }];
    for (let i = 1; i < 100; i++) ops.push({ op: "wp", code: `T${i}`, title: `Task ${i}`, parent_id: "@R", depends_on: i > 1 ? [`@T${i - 1}`] : [] });
    const t0 = Date.now();
    const out = await apply(pid, ops);
    console.log(`apply_changes 100 ops: ${Date.now() - t0} ms wall time (local), result ${JSON.stringify(out).length} characters`);
    expect(out.ops).toHaveLength(100);
    expect((await counts(pid)).wps).toBe(100);
  }, 60_000);
});

describe("apply_changes: refusals", () => {
  it("refs: unknown, forward, duplicate, ambiguous", async () => {
    const pid = await project();
    await wp(pid, { code: "K", title: "Stored K" });
    await refused(pid, [{ op: "wp", title: "A", parent_id: "@nope" }], "REF_UNKNOWN", 0);
    await refused(pid, [{ op: "wp", title: "A", parent_id: "@L" }, { op: "wp", code: "L", title: "L" }], "REF_FORWARD", 0);
    await refused(pid, [{ op: "wp", title: "A", parent_id: "later-id" }, { op: "wp", id: "later-id", title: "L" }], "REF_FORWARD", 0);
    await refused(pid, [{ op: "wp", title: "A", depends_on: ["later-id"] }, { op: "wp", id: "later-id", title: "L" }], "REF_FORWARD", 0);
    await refused(pid, [{ op: "wp", ref: "r", title: "A" }, { op: "wp", ref: "r", title: "B" }], "REF_DUPLICATE", 1);
    const out = await refused(pid, [{ op: "wp", code: "K", title: "New K" }, { op: "wp", title: "Child", parent_id: "@K" }], "REF_AMBIGUOUS", 1);
    expect(out.failed.ref).toBeUndefined();
  });

  it("TARGET_DUPLICATE: two ops on one stored id, and an op on an id an earlier op created", async () => {
    const pid = await project();
    const x = await wp(pid, { code: "X", title: "X" });
    await refused(pid, [{ op: "wp", id: x, title: "X1" }, { op: "wp", wp_code: "X", sort: 2 }], "TARGET_DUPLICATE", 1);
    await refused(pid, [{ op: "wp", id: "made-here", title: "M" }, { op: "wp", id: "made-here", sort: 3 }], "TARGET_DUPLICATE", 1);
  });

  it("OP_INVALID: unknown key, wrong type, id with wp_code, project_id inside an op; an unknown kind is an SDK error", async () => {
    const pid = await project();
    const x = await wp(pid, { code: "X", title: "X" });
    expect((await refused(pid, [{ op: "wp", title: "A", parent: x }], "OP_INVALID", 0)).message).toContain("parent");
    expect((await refused(pid, [{ op: "wp", id: x }, { op: "wp", title: "A", progress: 150 }], "OP_INVALID", 1)).message).toContain("ops[1].progress");
    await refused(pid, [{ op: "wp", id: x, wp_code: "X", title: "B" }], "OP_INVALID", 0);
    expect((await refused(pid, [{ op: "wp", title: "A", project_id: pid }], "OP_INVALID", 0)).message).toContain("project_id");
    const before = await counts(pid);
    const r = await call("apply_changes", { project_id: pid, ops: [{ op: "risk", title: "R" }] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Input validation error/i);
    expect(await counts(pid)).toEqual(before);
  });

  it("limits: 101 ops and over 128 KB are 413; an empty list is OP_INVALID", async () => {
    const pid = await project();
    const many = Array.from({ length: 101 }, (_, i) => ({ op: "wp", title: `T${i}` }));
    await refused(pid, many, "too_large", null, "too_large");
    await refused(pid, [{ op: "wp", title: "Big", description_md: "x".repeat(130 * 1024) }], "too_large", null, "too_large");
    await refused(pid, [], "OP_INVALID", null, "invalid");
  });

  it("cross-project: target id, ref fields and wp_code of another project", async () => {
    const pid = await project();
    const other = await project();
    const xo = await wp(other, { code: "XO", title: "Other" });
    const own = await wp(pid, { code: "OWN", title: "Own" });
    expect((await refused(pid, [{ op: "wp", id: xo, title: "Steal" }], "invalid", 0)).message).toContain(`belongs to project ${other}`);
    await refused(pid, [{ op: "wp", title: "A", parent_id: xo }], "invalid", 0);
    await refused(pid, [{ op: "wp", id: own, depends_on: [xo] }], "invalid", 0);
    await refused(pid, [{ op: "ms", title: "M", requires: [xo] }], "invalid", 0);
    await refused(pid, [{ op: "ms", title: "M", unlocks: [xo] }], "invalid", 0);
    await refused(pid, [{ op: "ms", title: "M", workpackage_id: xo }], "invalid", 0);
    await refused(pid, [{ op: "wp", wp_code: "XO", title: "B" }], "not_found", 0, "not_found");
  });

  it("cycles across a stored row and a new one: parent and depends_on", async () => {
    const pid = await project();
    const p = await wp(pid, { code: "P", title: "P" });
    const s = await wp(pid, { code: "S", title: "S" });
    expect((await refused(pid, [{ op: "wp", code: "C", title: "C", parent_id: p }, { op: "wp", id: p, parent_id: "@C" }], "invalid", 1)).message).toContain(
      "cycle",
    );
    const out = await refused(pid, [{ op: "wp", code: "N", title: "N", depends_on: [s] }, { op: "wp", id: s, depends_on: ["@N"] }], "invalid", 0);
    expect(out.message).toContain(" -> ");
  });

  it("gate lock: (a) start a locked WP, (b) progress under a locked parent", async () => {
    const g = await gatedProject();
    const out = await refused(g.pid, [{ op: "wp", id: g.c, title: "C2" }, { op: "wp", id: g.b, status: "doing" }], "GATE_LOCKED", 1, "conflict");
    expect(out.current.gates[0].milestone_id).toBe(g.g);
    await refused(g.pid, [{ op: "wp", id: g.b1, progress: 10 }], "GATE_LOCKED", 0);
  });

  it("gate lock: (c) a gate created by an earlier op locks a later start; (d) start, then gate, is allowed", async () => {
    const g = await gatedProject();
    await refused(g.pid, [{ op: "ms", title: "New gate", gate: true, requires: [g.a], unlocks: [g.c] }, { op: "wp", id: g.c, status: "doing" }], "GATE_LOCKED", 1);
    let seen: Map<string, unknown> | null = null;
    setAfterPlanForTesting((l) => (seen = l));
    await apply(g.pid, [{ op: "wp", id: g.c, status: "doing" }, { op: "ms", title: "New gate", gate: true, requires: [g.a], unlocks: [g.c] }]);
    expect((await row(g.c)).status).toBe("doing");
    // Overlay parity: the lock set after the call equals the stored one.
    expect([...seen!.keys()].sort()).toEqual([...(await gateLockedWpIds(db, g.pid)).keys()].sort());
  });

  it("gate lock: (e) reparenting a WP locked through its ancestor; (f) a started WP under a locked parent", async () => {
    const g = await gatedProject();
    await refused(g.pid, [{ op: "wp", id: g.b1, parent_id: g.c }], "GATE_LOCKED", 0);
    await refused(g.pid, [{ op: "wp", title: "New started", status: "doing", parent_id: g.b }], "GATE_LOCKED", 0);
    await refused(g.pid, [{ op: "wp", id: g.s, parent_id: g.b }], "GATE_LOCKED", 0);
    let seen: Map<string, unknown> | null = null;
    setAfterPlanForTesting((l) => (seen = l));
    await apply(g.pid, [{ op: "wp", id: g.c, parent_id: g.b }]);
    expect([...seen!.keys()].sort()).toEqual([...(await gateLockedWpIds(db, g.pid)).keys()].sort());
  });

  it("a gate reached inside the call (go recorded before) lets a later op start its unlocked WP", async () => {
    const g = await gatedProject();
    await recordGateDecision(db, g.g, { decision: "go" }, await DM());
    let seen: Map<string, unknown> | null = null;
    setAfterPlanForTesting((l) => (seen = l));
    const before = (await events(g.pid)).length;
    await apply(g.pid, [{ op: "wp", id: g.a, status: "done" }, { op: "wp", id: g.b, status: "doing" }]);
    expect((await row(g.b)).status).toBe("doing");
    const ev = (await events(g.pid)).slice(before).filter((e) => e.entity !== "project");
    expect(ev.map((e) => `${e.entity}/${e.action}`)).toEqual(["workpackage/update", "milestone/reached", "workpackage/update"]);
    expect([...seen!.keys()].sort()).toEqual([...(await gateLockedWpIds(db, g.pid)).keys()].sort());
  });

  it("agents do not remove a closed gate's flag or unlocks", async () => {
    const g = await gatedProject();
    await refused(g.pid, [{ op: "ms", id: g.g, gate: false }], "forbidden", 0, "forbidden");
    await refused(g.pid, [{ op: "wp", id: g.c, title: "C2" }, { op: "ms", id: g.g, unlocks: [] }], "forbidden", 1, "forbidden");
  });

  it("verification rules", async () => {
    const pid = await project();
    const v = await wp(pid, { code: "V", title: "V", verification: "review" });
    const out = await apply(pid, [{ op: "wp", id: v, status: "done" }]);
    expect(out.ops[0].verified_by).toBe(await loginId());
    const t = await wp(pid, { code: "TT", title: "Tested", verification: "test" });
    await refused(pid, [{ op: "wp", id: t, verification: "review" }], "forbidden", 0, "forbidden");
    await refused(pid, [{ op: "wp", title: "Signed", verification: "sign_off", status: "done" }], "forbidden", 0, "forbidden");
    await refused(pid, [{ op: "wp", title: "Other", verification: "review", status: "done", verified_by: "ann.parity@example.com" }], "forbidden", 0);
  });

  it("drop reason, closed project, trash", async () => {
    const pid = await project();
    const x = await wp(pid, { code: "X", title: "X" });
    await refused(pid, [{ op: "wp", id: x, status: "dropped" }], "DROP_REASON_MISSING", 0);
    const tr = await wp(pid, { code: "TR", title: "Trash" });
    await db.prepare("UPDATE workpackage SET deleted_at = ? WHERE id = ?").bind(new Date().toISOString(), tr).run();
    await refused(pid, [{ op: "wp", id: tr, title: "Back" }], "not_found", 0, "not_found");
    const done = await project();
    const d = await wp(done, { code: "D", title: "D", status: "done" });
    await db.prepare("UPDATE project SET status = 'done' WHERE id = ?").bind(done).run();
    await refused(done, [{ op: "wp", id: d, status: "doing" }], "PROJECT_CLOSED", 0);
  });

  it("expected_version mismatch on op 5: 409 with current slimmed to op 5's fields", async () => {
    const pid = await project();
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await wp(pid, { code: `E${i}`, title: `E${i}` }));
    const ops: Op[] = ids.map((id, i) => ({ op: "wp", id, sort: i + 1 }));
    ops[5] = { op: "wp", id: ids[5], title: "Changed", expected_version: 7 };
    const out = await refused(pid, ops, "conflict", 5, "conflict");
    expect(out.current).toEqual({ version: 1, title: "E5" });
  });

  it("schedule_strict: fails when the final plan adds issues, passes when only an intermediate state would", async () => {
    const pid = await project();
    await db.prepare("UPDATE project SET schedule_strict = 1 WHERE id = ?").bind(pid).run();
    const out = await refused(
      pid,
      [
        { op: "wp", code: "A", title: "A", start_date: "2026-05-01", end_date: "2026-05-10" },
        { op: "wp", code: "B", title: "B", start_date: "2026-05-05", end_date: "2026-05-20", depends_on: ["@A"] },
      ],
      "SCHEDULE_STRICT",
      1,
    );
    expect(out.current.issues[0]).toMatchObject({ op: 1, code: "DEP_START_BEFORE_PRED_END" });
    const a = await wp(pid, { code: "SA", title: "SA", start_date: "2026-05-01", end_date: "2026-05-10" });
    const b = await wp(pid, { code: "SB", title: "SB", start_date: "2026-05-20", end_date: "2026-05-30", depends_on: [a] });
    await apply(pid, [
      { op: "wp", id: a, end_date: "2026-05-25" },
      { op: "wp", id: b, start_date: "2026-06-01", end_date: "2026-06-10" },
    ]);
  });
});

describe("apply_changes: rollback and races", () => {
  it("a failing op 10 of 20 stores nothing: no rows, no events, activity and schedule_rev unchanged", async () => {
    const pid = await project();
    const ops = BUILD.map((o) => ({ ...o }));
    ops[10] = { op: "wp", title: "Bad", status: "dropped" };
    await refused(pid, ops, "DROP_REASON_MISSING", 10);
  });

  it("a version race on op 3's target: 409 naming op 3, nothing of ops 0-2 stored", async () => {
    const pid = await project();
    const t = await wp(pid, { code: "T", title: "T" });
    setAfterScheduleReadForTesting(async () => {
      await db.prepare("UPDATE workpackage SET version = version + 1 WHERE id = ?").bind(t).run();
    });
    const before = (await counts(pid)).wps;
    const r = JSON.parse(
      (
        await call("apply_changes", {
          project_id: pid,
          ops: [{ op: "wp", title: "A" }, { op: "wp", title: "B" }, { op: "ms", title: "M" }, { op: "wp", id: t, title: "T2" }],
        })
      ).content[0].text,
    );
    expect(r.failed).toEqual({ index: 3, code: "conflict" });
    expect(r.current).toEqual({ version: 2, title: "T" });
    expect((await counts(pid)).wps).toBe(before);
  });

  it("a hold recorded meanwhile: 403 for an unlock removal, GATE_LOCKED for a start (the SQL guard fires)", async () => {
    const g = await gatedProject();
    const c2 = await wp(g.pid, { code: "C2", title: "Second unlock" });
    await upsertMilestone(db, g.pid, { id: g.g, unlocks: [g.b, c2] }, SYS);
    await upsertWorkpackage(db, g.pid, { id: g.a, status: "done" }, SYS);
    const dm = await DM();
    await recordGateDecision(db, g.g, { decision: "go" }, dm);
    const hold = async () => {
      setAfterScheduleReadForTesting(null);
      await recordGateDecision(db, g.g, { decision: "hold", note_md: "wait" }, dm);
    };
    setAfterScheduleReadForTesting(hold);
    const ops = [{ op: "wp", id: g.c, title: "x" }, { op: "wp", title: "n1" }, { op: "wp", title: "n2" }, { op: "wp", title: "n3" }];
    await refused(g.pid, [...ops, { op: "ms", id: g.g, unlocks: [g.b] }], "forbidden", 4, "forbidden", true);
    await recordGateDecision(db, g.g, { decision: "go" }, dm);
    setAfterScheduleReadForTesting(hold);
    await refused(g.pid, [{ op: "wp", title: "n1" }, { op: "wp", title: "n2" }, { op: "wp", id: c2, status: "doing" }], "GATE_LOCKED", 2, "conflict", true);
  });

  it("a project closed meanwhile: PROJECT_CLOSED, nothing stored", async () => {
    const pid = await project();
    setAfterScheduleReadForTesting(async () => {
      await db.prepare("UPDATE project SET status = 'done' WHERE id = ?").bind(pid).run();
    });
    await refused(pid, [{ op: "ms", title: "M" }, { op: "wp", title: "New" }], "PROJECT_CLOSED", 1);
  });
});

describe("apply_changes: permissions", () => {
  it("a viewer login is refused before any read", async () => {
    const pid = await project();
    await person(LOGIN, "viewer");
    try {
      const r = await call("apply_changes", { project_id: pid, ops: [{ op: "wp", title: "A" }] });
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.content[0].text).error).toBe("forbidden");
    } finally {
      await person(LOGIN, "editor");
    }
  });

  it("per op kind through the action lookup, fail closed", async () => {
    const pid = await project();
    const editor = testCaller({ role: "editor", channel: "mcp", actor: "mcp:t", personId: await loginId() });
    const decideMs = (t: string) => (t === "upsert_milestone" ? "decide" : toolAction(t));
    await expect(applyChanges(db, pid, [{ op: "wp", title: "A" }, { op: "ms", title: "M" }], editor, { actionOf: decideMs })).rejects.toMatchObject({
      status: 403,
      failed: { index: 1, code: "forbidden" },
    });
    await expect(applyChanges(db, pid, [{ op: "wp", title: "A" }], editor, { actionOf: () => undefined })).rejects.toMatchObject({
      status: 403,
      failed: { index: 0 },
    });
    expect(TOOL_ACTIONS.apply_changes).toBe("write");
  });
});
