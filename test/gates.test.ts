// F5 (release R2): gate decisions, lock enforcement, human override.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, installTestKeys, testCaller, userJwt } from "./helpers";
import { gatedPlan } from "./fixtures/gated-plan";
import { createProject, getProjectDetail, setBeforeProjectWriteForTesting, updateProject } from "../src/data/projects";
import { upsertWorkpackage } from "../src/data/workpackages";
import { listMilestones, upsertMilestone } from "../src/data/milestones";
import { logProgress, listEvents, setBeforeProgressWriteForTesting } from "../src/data/logs";
import { deleteEntity } from "../src/data/entities";
import { moveWorkpackages } from "../src/data/rules";
import { gateLockedWpIds, overrideGateLock, recordGateDecision, setBeforeDecisionWriteForTesting } from "../src/data/gates";
import { setAfterScheduleReadForTesting } from "../src/data/schedule";
import { mcpCaller, serviceCaller, userCaller } from "../src/auth/caller";
import { ensureUserPerson } from "../src/data/persons";
import { POLICY } from "../src/policy";
import { mcpApiHandler } from "../src/mcp/server";
import { getContextBundle } from "../src/data/context-read";
import { upsertRisk } from "../src/data/risks";
import type { Caller, Env, Role, WorkpackageRow } from "../src/types";

const db = env.DB;
const SYS = testCaller();
let n = 0;
const ids: Record<string, string> = {};

async function person(email: string, role: Role): Promise<string> {
  const p = await ensureUserPerson(db, email);
  await db.prepare("UPDATE person SET access_role = ? WHERE id = ?").bind(role, p.id).run();
  return p.id;
}
const dash = (email: string) => userCaller(db, email);
const agent = (email: string) => mcpCaller(db, { email, clientName: "Claude" });
const svc = (onBehalfOf?: string) => serviceCaller(db, "hook:claude-code", onBehalfOf);
const wpRow = async (id: string) => (await db.prepare("SELECT * FROM workpackage WHERE id = ?").bind(id).first<WorkpackageRow>())!;
const conflict = (code: string) => ({ status: 409, current: expect.objectContaining({ code }) });

/** The neutral gated plan with M1 as a gate; WP1 is done (M1 reached), WP2 waits for the decision. */
async function gated(opts: { dm?: string | null; finishWp1?: boolean } = {}) {
  const p = await createProject(
    db,
    { title: `Gate ${++n}`, owner: "Owner", decision_maker: opts.dm === undefined ? "dm@example.com" : opts.dm },
    SYS,
  );
  const plan = gatedPlan(`${p.id}-`);
  for (const w of plan.wps) await upsertWorkpackage(db, p.id, { ...w }, SYS);
  for (const m of plan.milestones) await upsertMilestone(db, p.id, { ...m, gate: m.title === "M1" }, SYS);
  const id = (s: string) => `${p.id}-${s}`;
  if (opts.finishWp1 !== false) await upsertWorkpackage(db, p.id, { id: id("wp1"), status: "done" }, SYS);
  return { p, wp1: id("wp1"), wp2: id("wp2"), wp3: id("wp3"), m1: id("m1"), m2: id("m2") };
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

let DM: Caller;
let OTHER: Caller;
let ADMIN: Caller;
let EDITOR: Caller;
let VIEWER: Caller;
let userRole: Role | null = null;
beforeAll(async () => {
  await installTestKeys();
  ids.dm = await person("dm@example.com", "decider");
  await person("other@example.com", "decider");
  await person("admin@example.com", "admin");
  await person("editor@example.com", "editor");
  await person("viewer@example.com", "viewer");
  userRole = (await ensureUserPerson(db, "user@example.com")).access_role;
  DM = await dash("dm@example.com");
  OTHER = await dash("other@example.com");
  ADMIN = await dash("admin@example.com");
  EDITOR = await dash("editor@example.com");
  VIEWER = await dash("viewer@example.com");
});
afterAll(async () => {
  await db.prepare("UPDATE person SET access_role = ? WHERE email = 'user@example.com'").bind(userRole).run();
  setAfterScheduleReadForTesting(null);
  setBeforeDecisionWriteForTesting(null);
  setBeforeProjectWriteForTesting(null);
  setBeforeProgressWriteForTesting(null);
});

describe("gate lock", () => {
  it("WP2 stays locked until go on M1", async () => {
    const g = await gated();
    const before = (await listMilestones(db, g.p.id)).find((m) => m.id === g.m1)!;
    expect(before.reached_at).not.toBeNull();
    expect(before.gate).toBe(true);
    expect(before.decision_state).toBe("pending");
    expect([...(await gateLockedWpIds(db, g.p.id)).keys()]).toEqual([g.wp2]);

    // MCP upsert_workpackage → 409 naming the gate
    const r = await mcp("upsert_workpackage", { project_id: g.p.id, id: g.wp2, status: "doing" });
    expect(r.isError).toBe(true);
    const err = body(r);
    expect(err.current.code).toBe("GATE_LOCKED");
    expect(err.current.gates).toEqual([{ milestone_id: g.m1, title: "M1" }]);
    expect(err.message).toContain("M1");
    // done and progress are refused too; a hook (service token) is an agent as well
    await expect(upsertWorkpackage(db, g.p.id, { id: g.wp2, status: "done" }, await agent("user@example.com"))).rejects.toMatchObject(
      conflict("GATE_LOCKED"),
    );
    await expect(upsertWorkpackage(db, g.p.id, { id: g.wp2, progress: 10 }, await svc())).rejects.toMatchObject(conflict("GATE_LOCKED"));
    await expect(
      logProgress(db, { project_id: g.p.id, summary: "worked", workpackage_id: g.wp2, progress: 20 }, await svc()),
    ).rejects.toMatchObject(conflict("GATE_LOCKED"));
    // spec §25 (D21 c): a progress log without progress is refused as well; a note is kept and starts nothing
    await expect(logProgress(db, { project_id: g.p.id, summary: "looked at it", workpackage_id: g.wp2 }, await svc())).rejects.toMatchObject(
      conflict("GATE_LOCKED"),
    );
    const logged = await logProgress(db, { project_id: g.p.id, summary: "looked at it", workpackage_id: g.wp2, note: true }, await svc());
    expect(logged.workpackage!.status).toBe("todo");
    // edits that do not start the WP stay possible
    expect((await mcp("upsert_workpackage", { project_id: g.p.id, id: g.wp2, title: "WP2 renamed" })).isError).toBeFalsy();
    expect((await wpRow(g.wp2)).status).toBe("todo");

    const d = await recordGateDecision(db, g.m1, { decision: "go" }, DM);
    expect(d.decision_id).toBeTruthy();
    const after = (await listMilestones(db, g.p.id)).find((m) => m.id === g.m1)!;
    expect(after.decision_state).toBe("go");
    expect(after.decisions).toHaveLength(1);
    expect(after.decisions[0]).toMatchObject({ decision: "go", decided_by: { person_id: ids.dm, name: "dm" } });
    expect((await gateLockedWpIds(db, g.p.id)).size).toBe(0);
    const ok = await mcp("upsert_workpackage", { project_id: g.p.id, id: g.wp2, status: "doing" });
    expect(ok.isError).toBeFalsy();
    expect(body(ok).status).toBe("doing");
  });

  it("dashboard override with reason succeeds and is in history", async () => {
    const g = await gated();
    const jwt = await userJwt();
    const missing = await call(`/api/workpackages/${g.wp2}/gate-override`, { method: "POST", body: "{}", jwt });
    expect(missing.status).toBe(400);
    const res = await call(`/api/workpackages/${g.wp2}/gate-override`, {
      method: "POST",
      body: JSON.stringify({ reason: "Supplier slot only available this week" }),
      jwt,
    });
    expect(res.status).toBe(200);
    const wp = (await res.json()) as WorkpackageRow;
    expect(wp.gate_override_reason).toBe("Supplier slot only available this week");
    expect(wp.gate_override_at).toBeTruthy();
    const user = await ensureUserPerson(db, "user@example.com");
    expect(wp.gate_override_by).toBe(user.id);
    const ev = (await listEvents(db, { project_id: g.p.id })).find((e) => e.action === "gate_override")!;
    expect(ev).toMatchObject({ entity: "workpackage", entity_id: g.wp2, person_id: user.id });
    expect(JSON.parse(ev.diff_json!).gate_override_reason).toEqual([null, "Supplier slot only available this week"]);
    // agents may now work on it normally
    expect((await gateLockedWpIds(db, g.p.id)).has(g.wp2)).toBe(false);
    const ok = await mcp("upsert_workpackage", { project_id: g.p.id, id: g.wp2, status: "doing" });
    expect(ok.isError).toBeFalsy();
    // a second override of a WP that is no longer locked is refused
    await expect(overrideGateLock(db, g.wp2, "again", EDITOR)).rejects.toMatchObject(conflict("GATE_NOT_LOCKED"));
  });

  it("override via mcp channel is refused", async () => {
    const g = await gated();
    await expect(overrideGateLock(db, g.wp2, "agent wants to start", await agent("admin@example.com"))).rejects.toMatchObject({
      status: 403,
    });
    await expect(overrideGateLock(db, g.wp2, "hook", await svc("admin@example.com"))).rejects.toMatchObject({ status: 403 });
    // viewers cannot override either; editors can
    await expect(overrideGateLock(db, g.wp2, "viewer", VIEWER)).rejects.toMatchObject({ status: 403 });
    expect((await wpRow(g.wp2)).gate_override_at).toBeNull();
    const done = await overrideGateLock(db, g.wp2, "editor decided to start", EDITOR);
    expect(done.gate_override_by).toBe(EDITOR.personId);
  });

  it("gate=true on reached milestone locks only unstarted WPs", async () => {
    const p = await createProject(db, { title: `Late gate ${++n}`, owner: "Owner", decision_maker: "dm@example.com" }, SYS);
    const a = await upsertWorkpackage(db, p.id, { title: "a" }, SYS);
    const b = await upsertWorkpackage(db, p.id, { title: "b" }, SYS);
    const c = await upsertWorkpackage(db, p.id, { title: "c" }, SYS);
    const m = await upsertMilestone(db, p.id, { title: "M", requires: [a.id], unlocks: [b.id, c.id] }, SYS);
    await upsertWorkpackage(db, p.id, { id: a.id, status: "done" }, SYS);
    await upsertWorkpackage(db, p.id, { id: b.id, status: "doing" }, SYS);
    expect((await listMilestones(db, p.id))[0].reached_at).not.toBeNull();
    expect((await gateLockedWpIds(db, p.id)).size).toBe(0);

    await upsertMilestone(db, p.id, { id: m.id, gate: true }, SYS);
    expect([...(await gateLockedWpIds(db, p.id)).keys()]).toEqual([c.id]);
    const bot = await agent("user@example.com");
    expect((await upsertWorkpackage(db, p.id, { id: b.id, status: "done" }, bot)).status).toBe("done");
    await expect(upsertWorkpackage(db, p.id, { id: c.id, status: "doing" }, bot)).rejects.toMatchObject(conflict("GATE_LOCKED"));
    // a todo → blocked detour does not unlock it: blocked without progress is still unstarted
    await upsertWorkpackage(db, p.id, { id: c.id, status: "blocked", blocked_by: "ext:supplier" }, bot);
    await expect(upsertWorkpackage(db, p.id, { id: c.id, status: "doing" }, bot)).rejects.toMatchObject(conflict("GATE_LOCKED"));
    // the detail read flags the lock
    const detail = await getProjectDetail(db, p.id);
    const node = detail.workpackages.find((w) => w.id === c.id)!;
    expect(node.locked).toBe(true);
    expect(node.gate_locked).toEqual({ milestone_id: m.id, title: "M" });
    expect(detail.workpackages.find((w) => w.id === b.id)!.locked).toBe(false);
  });

  it("a hold recorded between an agent's read and its write still refuses the start (same batch)", async () => {
    const g = await gated();
    await recordGateDecision(db, g.m1, { decision: "go" }, DM);
    const bot = await agent("user@example.com");
    setAfterScheduleReadForTesting(async () => {
      setAfterScheduleReadForTesting(null);
      await recordGateDecision(db, g.m1, { decision: "hold", note_md: "re-check supplier" }, DM);
    });
    await expect(upsertWorkpackage(db, g.p.id, { id: g.wp2, status: "doing" }, bot)).rejects.toMatchObject(conflict("GATE_LOCKED"));
    const row = await wpRow(g.wp2);
    expect(row.status).toBe("todo");
    expect(row.version).toBe(1);
    expect((await listEvents(db, { project_id: g.p.id })).some((e) => e.entity_id === g.wp2 && e.action === "update")).toBe(false);
  });

  it("agents cannot remove a gate, its unlocks, or move a locked WP away", async () => {
    const g = await gated();
    const bot = await agent("user@example.com");
    await expect(upsertMilestone(db, g.p.id, { id: g.m1, gate: false }, bot)).rejects.toMatchObject({ status: 403 });
    await expect(upsertMilestone(db, g.p.id, { id: g.m1, unlocks: [] }, bot)).rejects.toMatchObject({ status: 403 });
    await expect(deleteEntity(db, "milestone", g.m1, bot)).rejects.toMatchObject({ status: 403 });
    const target = await createProject(db, { title: `Target ${++n}`, owner: "Owner" }, SYS);
    await expect(moveWorkpackages(db, g.p.id, target.id, [g.wp2], bot)).rejects.toMatchObject(conflict("GATE_LOCKED"));
    // agents may still edit other fields, and add a gate
    expect((await upsertMilestone(db, g.p.id, { id: g.m1, title: "M1 kickoff" }, bot)).title).toBe("M1 kickoff");
    expect((await upsertMilestone(db, g.p.id, { id: g.m2, gate: true }, bot)).gate).toBe(true);
    // a person may remove the gate
    expect((await upsertMilestone(db, g.p.id, { id: g.m1, gate: false }, EDITOR)).gate).toBe(false);
    expect((await gateLockedWpIds(db, g.p.id)).has(g.wp2)).toBe(false);
  });

  it("policy gates.require_decision=false: gates unlock when reached", async () => {
    const g = await gated();
    POLICY.gates.require_decision = false;
    try {
      expect((await gateLockedWpIds(db, g.p.id)).size).toBe(0);
      expect((await upsertWorkpackage(db, g.p.id, { id: g.wp2, status: "doing" }, await agent("user@example.com"))).status).toBe("doing");
    } finally {
      POLICY.gates.require_decision = true;
    }
  });
});

describe("gate decisions", () => {
  it("service token cannot record decisions", async () => {
    const g = await gated();
    await expect(recordGateDecision(db, g.m1, { decision: "go" }, await svc("dm@example.com"))).rejects.toMatchObject({ status: 403 });
    await expect(recordGateDecision(db, g.m1, { decision: "go" }, await svc())).rejects.toMatchObject({ status: 403 });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM decision WHERE milestone_id = ?").bind(g.m1).first<{ n: number }>())!.n).toBe(0);
  });

  it("only the named decision maker may decide", async () => {
    const g = await gated();
    await expect(recordGateDecision(db, g.m1, { decision: "go" }, OTHER)).rejects.toMatchObject({ status: 403 });
    await expect(recordGateDecision(db, g.m1, { decision: "go" }, EDITOR)).rejects.toMatchObject({ status: 403 });
    await expect(recordGateDecision(db, g.m1, { decision: "go" }, ADMIN)).rejects.toMatchObject({ status: 403 });
    // admins on behalf need a note; non-admins cannot claim on behalf
    await expect(recordGateDecision(db, g.m1, { decision: "go", on_behalf_of_decision_maker: true }, ADMIN)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      recordGateDecision(db, g.m1, { decision: "go", on_behalf_of_decision_maker: true, note_md: "for dm" }, OTHER),
    ).rejects.toMatchObject({ status: 403 });
    // the decision maker, but without the decider role
    await db.prepare("UPDATE person SET access_role = 'editor' WHERE id = ?").bind(ids.dm).run();
    await expect(recordGateDecision(db, g.m1, { decision: "go" }, await dash("dm@example.com"))).rejects.toMatchObject({ status: 403 });
    await db.prepare("UPDATE person SET access_role = 'decider' WHERE id = ?").bind(ids.dm).run();

    // the decision maker via MCP: decided_by is the OAuth login's person
    const viaMcp = await recordGateDecision(db, g.m1, { decision: "hold", note_md: "wait for test report" }, await agent("dm@example.com"));
    const row = await db.prepare("SELECT * FROM decision WHERE id = ?").bind(viaMcp.decision_id).first<Record<string, unknown>>();
    expect(row).toMatchObject({ decided_by: ids.dm, decision: "hold", on_behalf: 0, actor: "mcp:Claude" });
    // an admin on behalf, with a note
    const onBehalf = await recordGateDecision(
      db,
      g.m1,
      { decision: "go", on_behalf_of_decision_maker: true, note_md: "Decided by dm in the review meeting" },
      ADMIN,
    );
    const row2 = await db.prepare("SELECT * FROM decision WHERE id = ?").bind(onBehalf.decision_id).first<Record<string, unknown>>();
    expect(row2).toMatchObject({ decided_by: ADMIN.personId, on_behalf: 1 });
    const m = (await listMilestones(db, g.p.id)).find((x) => x.id === g.m1)!;
    expect(m.decisions.map((d) => d.decision)).toEqual(["hold", "go"]);
    expect(m.decision_state).toBe("go");
  });

  it("free-text decision maker → any decider, note required", async () => {
    const g = await gated({ dm: "Steering board" });
    expect((await getProjectDetail(db, g.p.id)).project.decision_maker).toEqual({ text: "Steering board" });
    await expect(recordGateDecision(db, g.m1, { decision: "go" }, OTHER)).rejects.toMatchObject({ status: 400 });
    await expect(recordGateDecision(db, g.m1, { decision: "go", note_md: "Steering board, 2026-10-20" }, EDITOR)).rejects.toMatchObject({
      status: 403,
    });
    const d = await recordGateDecision(db, g.m1, { decision: "go", note_md: "Steering board approved on 2026-10-20" }, OTHER);
    expect(d.decision_id).toBeTruthy();
  });

  it("decision_maker required before a gate can be decided", async () => {
    const g = await gated({ dm: null });
    await expect(recordGateDecision(db, g.m1, { decision: "go" }, ADMIN)).rejects.toMatchObject(conflict("DECISION_MAKER_MISSING"));
    // once set it may not be cleared while a gate exists
    await updateProject(db, g.p.id, { decision_maker: "dm@example.com" }, SYS);
    await expect(updateProject(db, g.p.id, { decision_maker: null }, SYS)).rejects.toMatchObject(conflict("DECISION_MAKER_REQUIRED"));
    // a non-gate milestone cannot be decided
    await expect(recordGateDecision(db, g.m2, { decision: "go" }, DM)).rejects.toMatchObject({ status: 400 });
  });

  it("decision maker changed between read and write → 409, nothing written", async () => {
    const g = await gated();
    setBeforeDecisionWriteForTesting(async () => {
      setBeforeDecisionWriteForTesting(null);
      await updateProject(db, g.p.id, { decision_maker: "other@example.com" }, SYS);
    });
    await expect(recordGateDecision(db, g.m1, { decision: "go" }, DM)).rejects.toMatchObject(conflict("DECISION_CONFLICT"));
    expect((await db.prepare("SELECT COUNT(*) AS n FROM decision WHERE project_id = ?").bind(g.p.id).first<{ n: number }>())!.n).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM baseline WHERE project_id = ?").bind(g.p.id).first<{ n: number }>())!.n).toBe(0);
  });

  it("go auto-creates a baseline", async () => {
    const g = await gated();
    const d = await recordGateDecision(
      db,
      g.m1,
      { decision: "go", note_md: "all criteria met", evidence: ["https://example.com/report"] },
      DM,
    );
    expect(d.baseline_id).toBeTruthy();
    const b = await db.prepare("SELECT * FROM baseline WHERE id = ?").bind(d.baseline_id).first<Record<string, unknown>>();
    expect(b).toMatchObject({ project_id: g.p.id, decision_id: d.decision_id, person_id: ids.dm });
    const items = await db
      .prepare("SELECT COUNT(*) AS n FROM baseline_item WHERE baseline_id = ?")
      .bind(d.baseline_id)
      .first<{ n: number }>();
    expect(items!.n).toBe(16); // 10 WPs + 6 milestones
    const row = await db
      .prepare("SELECT baseline_id, evidence FROM decision WHERE id = ?")
      .bind(d.decision_id)
      .first<Record<string, unknown>>();
    expect(row).toEqual({ baseline_id: d.baseline_id, evidence: JSON.stringify(["https://example.com/report"]) });
    expect((await getProjectDetail(db, g.p.id)).baseline!.decision_id).toBe(d.decision_id);
    // hold creates none
    const h = await recordGateDecision(db, g.m1, { decision: "hold", note_md: "re-check" }, DM);
    expect(h.baseline_id).toBeUndefined();
  });

  it("evidence must be http(s) links or context documents of the project", async () => {
    const g = await gated();
    await expect(recordGateDecision(db, g.m1, { decision: "go", evidence: ["javascript:alert(1)"] }, DM)).rejects.toMatchObject({
      status: 400,
    });
    await expect(recordGateDecision(db, g.m1, { decision: "go", evidence: ["no-such-doc"] }, DM)).rejects.toMatchObject({ status: 400 });
  });

  it("go_with_conditions creates WPs", async () => {
    const g = await gated();
    await expect(recordGateDecision(db, g.m1, { decision: "go", conditions: ["x"] }, DM)).rejects.toMatchObject({ status: 400 });
    const d = await recordGateDecision(
      db,
      g.m1,
      { decision: "go_with_conditions", conditions: ["Close open review findings", "Order spare parts"] },
      DM,
    );
    expect(d.baseline_id).toBeTruthy();
    expect(d.created_wps).toHaveLength(2);
    const wps = await Promise.all(d.created_wps!.map(wpRow));
    expect(wps.map((w) => [w.title, w.status, w.project_id])).toEqual([
      ["Close open review findings", "todo", g.p.id],
      ["Order spare parts", "todo", g.p.id],
    ]);
    // linked to the gate as `requires` (spec F5 "linked to the milestone"): the follow-up work shows on the
    // gate; never as `unlocks`, so a later hold cannot lock the condition WPs themselves
    const { results: links } = await db
      .prepare("SELECT milestone_id, workpackage_id, role FROM milestone_link WHERE workpackage_id IN (?, ?) ORDER BY workpackage_id")
      .bind(...d.created_wps!)
      .all();
    expect(links).toEqual(
      d
        .created_wps!.map((id) => ({ milestone_id: g.m1, workpackage_id: id, role: "requires" }))
        .sort((a, b) => a.workpackage_id.localeCompare(b.workpackage_id)),
    );
    const m = (await listMilestones(db, g.p.id)).find((x) => x.id === g.m1)!;
    expect(m.requires).toEqual(expect.arrayContaining(d.created_wps!));
    expect(m.reached_at).not.toBeNull(); // reached stays set; the gate stays open
    expect(m.decision_state).toBe("go_with_conditions");
    expect(m.decisions[0].conditions).toEqual([
      { title: "Close open review findings", workpackage_id: d.created_wps![0] },
      { title: "Order spare parts", workpackage_id: d.created_wps![1] },
    ]);
    // the baseline is taken after the condition WPs exist
    const items = await db
      .prepare("SELECT COUNT(*) AS n FROM baseline_item WHERE baseline_id = ? AND entity = 'workpackage'")
      .bind(d.baseline_id)
      .first<{ n: number }>();
    expect(items!.n).toBe(12);
    expect((await gateLockedWpIds(db, g.p.id)).size).toBe(0);
    // a later hold locks the gate's unlocks again, never the condition WPs
    await recordGateDecision(db, g.m1, { decision: "hold", note_md: "re-check" }, DM);
    const locked = await gateLockedWpIds(db, g.p.id);
    expect(d.created_wps!.some((id) => locked.has(id))).toBe(false);
  });

  it("the decision event carries note, evidence, conditions and on_behalf", async () => {
    const g = await gated();
    const d = await recordGateDecision(
      db,
      g.m1,
      {
        decision: "go_with_conditions",
        note_md: "Board agreed on 2 conditions",
        evidence: ["https://example.com/review"],
        conditions: ["Fix finding 1"],
      },
      DM,
    );
    const ev = (await listEvents(db, { project_id: g.p.id, limit: 500 })).find((e) => e.entity === "milestone" && e.action === "decision")!;
    const diff = JSON.parse(ev.diff_json!);
    expect(diff.decision).toEqual([null, "go_with_conditions"]);
    expect(diff.note_md).toEqual([null, "Board agreed on 2 conditions"]);
    expect(diff.evidence).toEqual([null, ["https://example.com/review"]]);
    expect(diff.conditions).toEqual([null, [{ title: "Fix finding 1", workpackage_id: d.created_wps![0] }]]);
    expect(diff.on_behalf).toEqual([null, false]);
    // on behalf of the decision maker (admin)
    await recordGateDecision(db, g.m1, { decision: "hold", note_md: "for the DM", on_behalf_of_decision_maker: true }, ADMIN);
    const evs = (await listEvents(db, { project_id: g.p.id, limit: 500 })).filter(
      (e) => e.entity === "milestone" && e.action === "decision",
    );
    const hold = evs.map((e) => JSON.parse(e.diff_json!)).find((x) => x.decision[1] === "hold")!;
    expect([hold.decision, hold.on_behalf, hold.note_md, hold.evidence, hold.conditions]).toEqual([
      ["go_with_conditions", "hold"],
      [null, true],
      [null, "for the DM"],
      [null, []],
      [null, []],
    ]);
  });

  it("bundle lists gate status", async () => {
    const g = await gated();
    await upsertRisk(db, g.p.id, { title: "Supplier slips", probability: 4, impact: 4, status: "open" }, SYS);
    const md = (await getContextBundle(db, { project_id: g.p.id })).markdown;
    expect(md).toContain("## Gates");
    const gates = md.slice(md.indexOf("## Gates"));
    // after the open risks, in the same style
    expect(md.indexOf("## Open risks")).toBeGreaterThan(-1);
    expect(md.indexOf("## Open risks")).toBeLessThan(md.indexOf("## Gates"));
    const m1 = (await listMilestones(db, g.p.id)).find((m) => m.id === g.m1)!;
    expect(gates).toContain(`- M1 (${g.m1}; due ${m1.due_date}; reached: yes; latest decision: none)`);
    expect(gates).toContain(`- WP2 (${g.wp2}; locked by gate M1)`);
    // other gates of the plan are not gates here; non-gate milestones are not listed
    expect(gates).not.toContain(`(${g.m2};`);
    // soft delete: a trashed locked WP is not listed
    await deleteEntity(db, "workpackage", g.wp2, SYS);
    expect((await getContextBundle(db, { project_id: g.p.id })).markdown).not.toContain(g.wp2);
    // decided: the section goes away
    await recordGateDecision(db, g.m1, { decision: "go" }, DM);
    expect((await getContextBundle(db, { project_id: g.p.id })).markdown).not.toContain("## Gates");
  });

  it("stop puts project on_hold with closure_decision_pending", async () => {
    const g = await gated();
    const d = await recordGateDecision(db, g.m1, { decision: "stop", note_md: "market gone" }, DM);
    expect(d.baseline_id).toBeUndefined();
    const p = (await getProjectDetail(db, g.p.id)).project;
    expect(p.status).toBe("on_hold");
    expect(p.closure_decision_pending).toBe(1);
    expect((await gateLockedWpIds(db, g.p.id)).has(g.wp2)).toBe(true);
    // reactivating clears the flag
    const re = await updateProject(db, g.p.id, { status: "active" }, SYS);
    expect(re.closure_decision_pending).toBe(0);
  });

  it("decisions on a closed project are refused", async () => {
    const g = await gated();
    await db.prepare("UPDATE project SET status = 'abandoned', closure_note_md = 'x' WHERE id = ?").bind(g.p.id).run();
    await expect(recordGateDecision(db, g.m1, { decision: "go" }, DM)).rejects.toMatchObject(conflict("PROJECT_CLOSED"));
  });

  it("MCP record_gate_decision and REST POST /api/milestones/:id/decisions", async () => {
    const user = await ensureUserPerson(db, "user@example.com");
    await db.prepare("UPDATE person SET access_role = 'decider' WHERE id = ?").bind(user.id).run();
    const g = await gated({ dm: "user@example.com" });
    const r = await mcp("record_gate_decision", { milestone_id: g.m1, decision: "hold", note_md: "the user said: hold" });
    expect(r.isError).toBeFalsy();
    expect(body(r).decision_id).toBeTruthy();
    const res = await call(`/api/milestones/${g.m1}/decisions`, {
      method: "POST",
      body: JSON.stringify({ decision: "go", note_md: "approved" }),
      jwt: await userJwt(),
    });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { decision_id: string; baseline_id: string };
    expect(out.baseline_id).toBeTruthy();
    const m = (await listMilestones(db, g.p.id)).find((x) => x.id === g.m1)!;
    expect(m.decisions.map((d) => [d.decision, d.decided_by.person_id])).toEqual([
      ["hold", user.id],
      ["go", user.id],
    ]);
    // upsert_milestone takes gate
    const ms = await mcp("upsert_milestone", { project_id: g.p.id, id: g.m2, gate: true });
    expect(body(ms).gate).toBe(true);
  });
});

describe("gate fix round 1", () => {
  it("agent cannot change decision maker while a gate is undecided", async () => {
    const g = await gated();
    const bot = await agent("user@example.com");
    for (const decision_maker of ["user@example.com", "Steering board", null])
      await expect(updateProject(db, g.p.id, { decision_maker }, bot)).rejects.toMatchObject(conflict("DECISION_MAKER_LOCKED"));
    await expect(updateProject(db, g.p.id, { decision_maker: "Board" }, await svc())).rejects.toMatchObject(
      conflict("DECISION_MAKER_LOCKED"),
    );
    // via MCP update_project too
    const r = await mcp("update_project", { id: g.p.id, patch: { decision_maker: "user@example.com" } });
    expect(r.isError).toBe(true);
    expect(body(r).current.code).toBe("DECISION_MAKER_LOCKED");
    // other agent edits of the project still work
    expect((await updateProject(db, g.p.id, { summary: "edited by agent" }, bot)).summary).toBe("edited by agent");
    // a person in the dashboard may change it
    expect((await updateProject(db, g.p.id, { decision_maker: "other@example.com" }, EDITOR)).decision_maker).toMatchObject({
      name: "other",
    });
    // re-checked in the UPDATE: a hold recorded between the agent's read and write still refuses it
    await recordGateDecision(db, g.m1, { decision: "go" }, OTHER);
    expect((await updateProject(db, g.p.id, { decision_maker: "dm@example.com" }, bot)).decision_maker).toMatchObject({ name: "dm" });
    setBeforeProjectWriteForTesting(async () => {
      setBeforeProjectWriteForTesting(null);
      await recordGateDecision(db, g.m1, { decision: "hold", note_md: "wait" }, DM);
    });
    await expect(updateProject(db, g.p.id, { decision_maker: "user@example.com" }, bot)).rejects.toMatchObject(
      conflict("DECISION_MAKER_LOCKED"),
    );
    expect((await getProjectDetail(db, g.p.id)).project.decision_maker).toMatchObject({ name: "dm" });
  });

  it("sub-WP of a locked WP is locked for agents", async () => {
    const g = await gated();
    const bot = await agent("user@example.com");
    const child = await upsertWorkpackage(db, g.p.id, { title: "WP2 child", parent_id: g.wp2 }, SYS);
    const grand = await upsertWorkpackage(db, g.p.id, { title: "WP2 grandchild", parent_id: child.id }, SYS);
    const locks = await gateLockedWpIds(db, g.p.id);
    expect([...locks.keys()].sort()).toEqual([g.wp2, child.id, grand.id].sort());
    expect(locks.get(grand.id)).toEqual({ milestone_id: g.m1, title: "M1" });
    for (const patch of [{ status: "doing" }, { status: "done" }, { progress: 30 }])
      await expect(upsertWorkpackage(db, g.p.id, { id: grand.id, ...patch }, bot)).rejects.toMatchObject(conflict("GATE_LOCKED"));
    await expect(logProgress(db, { project_id: g.p.id, summary: "x", workpackage_id: child.id, progress: 10 }, bot)).rejects.toMatchObject(
      conflict("GATE_LOCKED"),
    );
    await expect(logProgress(db, { project_id: g.p.id, summary: "x", workpackage_id: child.id }, bot)).rejects.toMatchObject(conflict("GATE_LOCKED"));
    expect((await logProgress(db, { project_id: g.p.id, summary: "x", workpackage_id: child.id, note: true }, bot)).workpackage!.status).toBe("todo");
    // creating a started sub-WP, or moving a started WP under the locked one, is refused; a todo sub-WP is fine
    await expect(upsertWorkpackage(db, g.p.id, { title: "new", parent_id: g.wp2, status: "doing" }, bot)).rejects.toMatchObject(
      conflict("GATE_LOCKED"),
    );
    await expect(upsertWorkpackage(db, g.p.id, { title: "new", parent_id: child.id, progress: 5 }, bot)).rejects.toMatchObject(
      conflict("GATE_LOCKED"),
    );
    expect((await upsertWorkpackage(db, g.p.id, { title: "new todo", parent_id: g.wp2 }, bot)).status).toBe("todo");
    const started = await upsertWorkpackage(db, g.p.id, { title: "started elsewhere", status: "doing" }, SYS);
    await expect(upsertWorkpackage(db, g.p.id, { id: started.id, parent_id: g.wp2 }, bot)).rejects.toMatchObject(conflict("GATE_LOCKED"));
    // taking a sub-WP out of the locked subtree would lift its lock
    await expect(upsertWorkpackage(db, g.p.id, { id: grand.id, parent_id: null }, bot)).rejects.toMatchObject(conflict("GATE_LOCKED"));
    // the guard on the new parent runs in the batch: a hold recorded meanwhile refuses the create
    await recordGateDecision(db, g.m1, { decision: "go" }, DM);
    setAfterScheduleReadForTesting(async () => {
      setAfterScheduleReadForTesting(null);
      await recordGateDecision(db, g.m1, { decision: "hold", note_md: "re-check" }, DM);
    });
    await expect(upsertWorkpackage(db, g.p.id, { title: "raced", parent_id: g.wp2, status: "doing" }, bot)).rejects.toMatchObject(
      conflict("GATE_LOCKED"),
    );
    expect(await db.prepare("SELECT 1 FROM workpackage WHERE title = 'raced' AND project_id = ?").bind(g.p.id).first()).toBeNull();
    // after go the subtree is free
    await recordGateDecision(db, g.m1, { decision: "go" }, DM);
    expect((await upsertWorkpackage(db, g.p.id, { id: grand.id, status: "doing" }, bot)).status).toBe("doing");
  });

  it("dashboard start of a locked WP without override → 409, with override → ok", async () => {
    const g = await gated();
    const err = await upsertWorkpackage(db, g.p.id, { id: g.wp2, status: "doing" }, EDITOR).catch((e) => e);
    expect(err).toMatchObject(conflict("GATE_LOCKED"));
    expect(err.current.override_endpoint).toBe(`POST /api/workpackages/${g.wp2}/gate-override`);
    for (const patch of [{ status: "done" }, { progress: 10 }])
      await expect(upsertWorkpackage(db, g.p.id, { id: g.wp2, ...patch }, EDITOR)).rejects.toMatchObject(conflict("GATE_LOCKED"));
    await expect(logProgress(db, { project_id: g.p.id, summary: "x", workpackage_id: g.wp2, progress: 10 }, EDITOR)).rejects.toMatchObject(
      conflict("GATE_LOCKED"),
    );
    // REST PATCH says the same
    const jwt = await userJwt();
    const res = await call(`/api/workpackages/${g.wp2}`, {
      method: "PATCH",
      body: JSON.stringify({ project_id: g.p.id, status: "doing" }),
      jwt,
    });
    expect(res.status).toBe(409);
    const b = (await res.json()) as { current: { code: string; override_endpoint: string } };
    expect(b.current).toMatchObject({ code: "GATE_LOCKED", override_endpoint: `POST /api/workpackages/${g.wp2}/gate-override` });
    // edits that do not start it stay possible
    expect((await upsertWorkpackage(db, g.p.id, { id: g.wp2, description_md: "notes" }, EDITOR)).description_md).toBe("notes");
    // with an override the start goes through
    await overrideGateLock(db, g.wp2, "customer needs the prototype early", EDITOR);
    expect((await upsertWorkpackage(db, g.p.id, { id: g.wp2, status: "doing" }, EDITOR)).status).toBe("doing");
  });

  it("agent progress log that leaves status and progress unchanged is still guarded in the batch", async () => {
    const g = await gated();
    await recordGateDecision(db, g.m1, { decision: "go" }, DM);
    await upsertWorkpackage(db, g.p.id, { id: g.wp2, status: "blocked", blocked_by: "ext:supplier" }, SYS);
    const bot = await agent("user@example.com");
    // between the read and the batch: the gate is put on hold and the WP is reset to todo
    setBeforeProgressWriteForTesting(async () => {
      setBeforeProgressWriteForTesting(null);
      await recordGateDecision(db, g.m1, { decision: "hold", note_md: "re-check" }, DM);
      await db.prepare("UPDATE workpackage SET status = 'todo', blocked_since = NULL, blocked_by = NULL WHERE id = ?").bind(g.wp2).run();
    });
    await expect(logProgress(db, { project_id: g.p.id, summary: "x", workpackage_id: g.wp2, progress: 0 }, bot)).rejects.toMatchObject(
      conflict("GATE_LOCKED"),
    );
    expect((await wpRow(g.wp2)).status).toBe("todo");
  });
});
