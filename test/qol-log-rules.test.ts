// Spec §25 (log rules): notes vs progress logs, locked and done work packages, actual and planned dates.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { call, installTestKeys, serviceJwt, testCaller, userJwt } from "./helpers";
import { gatedPlan } from "./fixtures/gated-plan";
import { createProject } from "../src/data/projects";
import { upsertWorkpackage } from "../src/data/workpackages";
import { upsertMilestone } from "../src/data/milestones";
import { logProgress, setBeforeProgressWriteForTesting } from "../src/data/logs";
import { overrideGateLock, recordGateDecision } from "../src/data/gates";
import { mcpCaller, serviceCaller, userCaller } from "../src/auth/caller";
import { ensureUserPerson } from "../src/data/persons";
import { mcpApiHandler } from "../src/mcp/server";
import type { Caller, Env, Role, WorkpackageRow } from "../src/types";

const db = env.DB;
const SYS = testCaller();
const EDITOR_MAIL = "logrules-editor@example.com";
const VIEWER_MAIL = "logrules-viewer@example.com";
const envOverride = { ALLOWED_EMAILS: ["user@example.com", EDITOR_MAIL, VIEWER_MAIL].join(",") };
const today = () => new Date().toISOString().slice(0, 10);
let n = 0;

const wpRow = async (id: string) => (await db.prepare("SELECT * FROM workpackage WHERE id = ?").bind(id).first<WorkpackageRow>())!;
const conflict = (code: string) => ({ status: 409, current: expect.objectContaining({ code }) });
const agent = () => mcpCaller(db, { email: "user@example.com", clientName: "Claude" });
const svc = () => serviceCaller(db, "hook:claude-code");
const lastEvent = (wpId: string) =>
  db.prepare("SELECT action, summary, diff_json FROM event WHERE entity_id = ? ORDER BY id DESC LIMIT 1").bind(wpId).first<any>();
/** The fields a note must never touch. */
const state = (w: WorkpackageRow) => ({
  status: w.status,
  progress: w.progress,
  start_date: w.start_date,
  end_date: w.end_date,
  actual_start: w.actual_start,
  actual_end: w.actual_end,
  effort_actual_pd: w.effort_actual_pd,
});

async function setRole(addr: string, role: Role): Promise<void> {
  const p = await ensureUserPerson(db, addr);
  await db.prepare("UPDATE person SET access_role = ? WHERE id = ?").bind(role, p.id).run();
}

const rest = async (addr: string, body: unknown) =>
  call("/api/progress", {
    method: "POST",
    jwt: await userJwt(addr),
    envOverride,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function mcp(args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> {
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
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "log_progress", arguments: args } }),
    }),
    { ...env, ...envOverride } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  const line = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data: "))!.slice(6);
  const r = JSON.parse(line).result as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: r.isError, text: r.content[0].text };
}

/** Gated plan: M1 is a gate (reached, no decision), so WP2 is locked; WP1 is done; WP3 is a free todo WP. */
async function gated() {
  const p = await createProject(db, { title: `Log rules ${++n}`, owner: "Owner", decision_maker: "dm@example.com" }, SYS);
  const plan = gatedPlan(`${p.id}-`);
  for (const w of plan.wps) await upsertWorkpackage(db, p.id, { ...w }, SYS);
  for (const m of plan.milestones) await upsertMilestone(db, p.id, { ...m, gate: m.title === "M1" }, SYS);
  const id = (s: string) => `${p.id}-${s}`;
  await upsertWorkpackage(db, p.id, { id: id("wp1"), status: "done" }, SYS);
  const free = await upsertWorkpackage(db, p.id, { title: "free", start_date: "2099-01-01", end_date: "2099-02-01" }, SYS);
  return { p, wp1: id("wp1"), wp2: id("wp2"), free: free.id };
}

let EDITOR: Caller;
let VIEWER: Caller;
beforeAll(async () => {
  await installTestKeys();
  await setRole(EDITOR_MAIL, "editor");
  await setRole(VIEWER_MAIL, "viewer");
  await setRole("dm@example.com", "decider");
  EDITOR = await userCaller(db, EDITOR_MAIL);
  VIEWER = await userCaller(db, VIEWER_MAIL);
});

describe("notes (D21 a)", () => {
  it("a note is accepted on locked, done, dropped and blocked WPs and changes nothing", async () => {
    const g = await gated();
    const dropped = await upsertWorkpackage(db, g.p.id, { title: "dropped", status: "dropped", drop_reason: "not needed" }, SYS);
    const blocked = await upsertWorkpackage(db, g.p.id, { title: "blocked", status: "blocked", blocked_by: "supplier" }, SYS);
    await db.prepare("UPDATE workpackage SET actual_start = NULL WHERE id = ?").bind(blocked.id).run();
    for (const by of [await agent(), await svc(), EDITOR, SYS]) {
      for (const id of [g.wp2, g.wp1, dropped.id, blocked.id]) {
        const before = state(await wpRow(id));
        const r = await logProgress(db, { project_id: g.p.id, workpackage_id: id, summary: "remark", note: true }, by);
        expect(state(r.workpackage!)).toEqual(before);
        const ev = await lastEvent(id);
        expect([ev.action, ev.summary, JSON.parse(ev.diff_json ?? "{}")]).toEqual(["note", "remark", {}]);
      }
    }
  }, 30000);

  it("a note carries no progress or effort; note must be a boolean", async () => {
    const g = await gated();
    await expect(logProgress(db, { project_id: g.p.id, workpackage_id: g.free, summary: "x", note: true, progress: 10 }, SYS)).rejects.toMatchObject({
      status: 400,
    });
    await expect(logProgress(db, { project_id: g.p.id, workpackage_id: g.free, summary: "x", note: true, effort_pd: 1 }, SYS)).rejects.toMatchObject({
      status: 400,
    });
    await expect(logProgress(db, { project_id: g.p.id, workpackage_id: g.free, summary: "x", note: "yes" as never }, SYS)).rejects.toMatchObject({
      status: 400,
    });
    expect((await wpRow(g.free)).status).toBe("todo");
  });

  it("MCP and REST take note: true on a locked WP", async () => {
    const g = await gated();
    const viaMcp = await mcp({ project_id: g.p.id, workpackage_id: g.wp2, summary: "behind the gate", note: true });
    expect(viaMcp.isError).toBeFalsy();
    const viaRest = await rest(EDITOR_MAIL, { project_id: g.p.id, workpackage_id: g.wp2, summary: "behind the gate", note: true });
    expect(viaRest.status).toBe(201);
    expect((await wpRow(g.wp2)).status).toBe("todo");
  });
});

describe("progress logs (D21 b, c, f)", () => {
  it("todo → doing with actual_start = log date (planned start in the future); planned dates unchanged", async () => {
    const g = await gated();
    const r = await logProgress(db, { project_id: g.p.id, workpackage_id: g.free, summary: "began" }, await agent());
    expect(state(r.workpackage!)).toMatchObject({ status: "doing", actual_start: today(), start_date: "2099-01-01", end_date: "2099-02-01" });
  });

  it("blocked and waiting keep their status and get an actual start", async () => {
    const g = await gated();
    const b = await upsertWorkpackage(db, g.p.id, { title: "b", status: "blocked", blocked_by: "x" }, SYS);
    const w = await upsertWorkpackage(db, g.p.id, { title: "w", status: "waiting", waiting_reason: "y" }, SYS);
    for (const id of [b.id, w.id]) {
      const before = await wpRow(id);
      await db.prepare("UPDATE workpackage SET actual_start = NULL WHERE id = ?").bind(id).run();
      const r = await logProgress(db, { project_id: g.p.id, workpackage_id: id, summary: "poked", progress: 20 }, await agent());
      expect(r.workpackage!).toMatchObject({ status: before.status, progress: 20, actual_start: today() });
    }
  });

  it("a progress log on a locked WP is 409 GATE_LOCKED pointing to note: true; an override lets it through", async () => {
    const g = await gated();
    for (const by of [await agent(), await svc(), EDITOR])
      for (const progress of [undefined, 10]) {
        const err = await logProgress(db, { project_id: g.p.id, workpackage_id: g.wp2, summary: "x", progress }, by).catch((e) => e);
        expect(err).toMatchObject(conflict("GATE_LOCKED"));
        expect(err.message).toContain("note: true");
      }
    const viaMcp = await mcp({ project_id: g.p.id, workpackage_id: g.wp2, summary: "x" });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.text).toContain("GATE_LOCKED");
    expect((await wpRow(g.wp2)).status).toBe("todo");
    await overrideGateLock(db, g.wp2, "start early", EDITOR);
    const r = await logProgress(db, { project_id: g.p.id, workpackage_id: g.wp2, summary: "x" }, await agent());
    expect(r.workpackage!).toMatchObject({ status: "doing", actual_start: today() });
  });

  it("a lock that appears between read and write still refuses the log", async () => {
    const g = await gated();
    const DM = await userCaller(db, "dm@example.com");
    await recordGateDecision(db, `${g.p.id}-m1`, { decision: "go" }, DM);
    setBeforeProgressWriteForTesting(async () => {
      await recordGateDecision(db, `${g.p.id}-m1`, { decision: "hold", note_md: "wait" }, DM);
    });
    try {
      const err = await logProgress(db, { project_id: g.p.id, workpackage_id: g.wp2, summary: "x" }, await agent()).catch((e) => e);
      expect(err).toMatchObject(conflict("GATE_LOCKED"));
      expect(err.message).toContain("note: true");
    } finally {
      setBeforeProgressWriteForTesting(null);
    }
    expect((await wpRow(g.wp2)).status).toBe("todo");
  });
});

describe("done WPs (D21 d)", () => {
  it("a progress log on a done WP is 409 WP_DONE for every caller without authorisation", async () => {
    const g = await gated();
    const before = state(await wpRow(g.wp1));
    for (const by of [await agent(), await svc(), EDITOR, SYS])
      for (const input of by === EDITOR ? [{}, { progress: 100 }] : [{}, { progress: 100 }, { authorize_done: true }]) {
        const err = await logProgress(db, { project_id: g.p.id, workpackage_id: g.wp1, summary: "late", ...input }, by).catch((e) => e);
        expect(err).toMatchObject(conflict("WP_DONE"));
        expect(err.message).toContain("note: true");
      }
    expect(state(await wpRow(g.wp1))).toEqual(before);
  });

  it("an agent can never authorise itself (MCP drops authorize_done, a service token is refused)", async () => {
    const g = await gated();
    const viaMcp = await mcp({ project_id: g.p.id, workpackage_id: g.wp1, summary: "late", authorize_done: true });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.text).toContain("WP_DONE");
    for (const by of [await agent(), await svc()])
      await expect(
        logProgress(db, { project_id: g.p.id, workpackage_id: g.wp1, summary: "late", authorize_done: true }, by),
      ).rejects.toMatchObject(conflict("WP_DONE"));
  });

  it("a dashboard editor authorises with authorize_done: actual_end = log date, status stays done, planned end unchanged", async () => {
    const g = await gated();
    await db.prepare("UPDATE workpackage SET actual_start = '2026-01-02', actual_end = '2026-01-05' WHERE id = ?").bind(g.wp1).run();
    const before = await wpRow(g.wp1);
    const res = await rest(EDITOR_MAIL, { project_id: g.p.id, workpackage_id: g.wp1, summary: "late fix", authorize_done: true });
    expect(res.status).toBe(201);
    const after = await wpRow(g.wp1);
    expect(state(after)).toEqual({ ...state(before), actual_end: today() });
    expect(JSON.parse((await lastEvent(g.wp1)).diff_json)).toEqual({ actual_end: ["2026-01-05", today()] });
    // a viewer cannot log at all; a lower progress is refused
    expect((await rest(VIEWER_MAIL, { project_id: g.p.id, workpackage_id: g.wp1, summary: "x", authorize_done: true })).status).toBe(403);
    await expect(
      logProgress(db, { project_id: g.p.id, workpackage_id: g.wp1, summary: "x", authorize_done: true, progress: 50 }, EDITOR),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("a WP that becomes done between read and write refuses the unauthorised log", async () => {
    const g = await gated();
    setBeforeProgressWriteForTesting(async () => {
      await upsertWorkpackage(db, g.p.id, { id: g.free, status: "done" }, SYS);
    });
    try {
      await expect(logProgress(db, { project_id: g.p.id, workpackage_id: g.free, summary: "x", progress: 40 }, await agent())).rejects.toMatchObject(
        conflict("WP_DONE"),
      );
    } finally {
      setBeforeProgressWriteForTesting(null);
    }
    expect((await wpRow(g.free)).progress).not.toBe(40);
  });
});

describe("planned end (D21 f)", () => {
  it("no log moves the planned dates", async () => {
    const g = await gated();
    const planned = async () => {
      const w = await wpRow(g.free);
      return [w.start_date, w.end_date];
    };
    const p0 = await planned();
    await logProgress(db, { project_id: g.p.id, workpackage_id: g.free, summary: "a" }, await agent());
    await logProgress(db, { project_id: g.p.id, workpackage_id: g.free, summary: "b", progress: 50 }, await agent());
    await logProgress(db, { project_id: g.p.id, workpackage_id: g.free, summary: "c", note: true }, await agent());
    await logProgress(db, { project_id: g.p.id, workpackage_id: g.free, summary: "d", progress: 100 }, EDITOR);
    await logProgress(db, { project_id: g.p.id, workpackage_id: g.free, summary: "e", authorize_done: true }, EDITOR);
    await logProgress(db, { project_id: g.p.id, workpackage_id: g.free, summary: "f", note: true }, await agent());
    expect(await planned()).toEqual(p0);
    expect((await wpRow(g.free)).status).toBe("done");
  });
});

describe("hook route", () => {
  it("note: true from the hook is stored as a note event", async () => {
    const p = await createProject(db, { title: `Log rules hook ${++n}`, owner: "Owner", local_path: "C:/Users/jane/Documents/Devel/logrules-hook" }, SYS);
    const res = await call("/api/hooks/claude-code", {
      method: "POST",
      jwt: await serviceJwt(),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "lr-1", cwd: "C:/Users/jane/Documents/Devel/logrules-hook", reason: "other", note: true }),
    });
    expect(res.status).toBe(200);
    const ev = await db
      .prepare("SELECT action FROM event WHERE project_id = ? AND entity = 'project' AND summary LIKE 'Claude Code session ended%' ORDER BY id DESC LIMIT 1")
      .bind(p.id)
      .first<any>();
    expect(ev.action).toBe("note");
  });
});
