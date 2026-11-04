// QoL 0.3.0 (T01): migration 0007 and its data layer: WP code, actual dates, project host, dashboard prefs.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { call, installTestKeys, testCaller, userJwt } from "./helpers";
import { createProject, getProjectDetail, listProjects, updateProject } from "../src/data/projects";
import { upsertWorkpackage } from "../src/data/workpackages";
import { logProgress } from "../src/data/logs";
import { ensureUserPerson, listPersons } from "../src/data/persons";
import { upcomingWorkpackages } from "../src/data/portfolio";
import { buildReport } from "../src/report/build";
import { mcpApiHandler } from "../src/mcp/server";
import { ValidationError } from "../src/data/util";
import type { Env, Role, WorkpackageRow } from "../src/types";

const db = env.DB;
const SYS = testCaller();
const VIEWER = "qol1-viewer@example.com";
const EDITOR = "qol1-editor@example.com";
const envOverride = { ALLOWED_EMAILS: ["user@example.com", VIEWER, EDITOR].join(",") };
const today = () => new Date().toISOString().slice(0, 10);
let n = 0;
const proj = () => createProject(db, { title: `QoL1 project ${++n}`, owner: "Owner" }, SYS);
const row = (id: string) => db.prepare("SELECT * FROM workpackage WHERE id = ?").bind(id).first<WorkpackageRow>();

async function setRole(addr: string, role: Role): Promise<void> {
  const p = await ensureUserPerson(db, addr);
  await db.prepare("UPDATE person SET access_role = ? WHERE id = ?").bind(role, p.id).run();
}
const rest = async (addr: string, method: string, path: string, body?: unknown) =>
  call(path, {
    method,
    jwt: await userJwt(addr),
    envOverride,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function mcpTool(addr: string, name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; body: any }> {
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
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
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
  const result = JSON.parse(line).result as { isError?: boolean; content: Array<{ text: string }> };
  let body: unknown = result.content[0].text;
  try {
    body = JSON.parse(result.content[0].text);
  } catch {
    /* error text */
  }
  return { isError: result.isError, body };
}

beforeAll(async () => {
  await installTestKeys();
  await setRole(VIEWER, "viewer");
  await setRole(EDITOR, "editor");
});

describe("migration 0007", () => {
  it("adds the columns and backfills actual dates from events", async () => {
    const p = await proj();
    const mk = async (id: string, status: string) => {
      await db
        .prepare(
          "INSERT INTO workpackage (id, project_id, title, status, progress, created_at, updated_at) VALUES (?, ?, ?, ?, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        )
        .bind(id, p.id, id, status)
        .run();
    };
    const ev = (id: string, ts: string, action: string, diff: unknown) =>
      db
        .prepare("INSERT INTO event (ts, actor, project_id, entity, entity_id, action, diff_json) VALUES (?, 'test', ?, 'workpackage', ?, ?, ?)")
        .bind(ts, p.id, id, action, diff === null ? null : JSON.stringify(diff))
        .run();
    await mk("bf-both", "done");
    await ev("bf-both", "2026-02-01T09:00:00Z", "create", { status: [null, "todo"], progress: [null, 0] });
    await ev("bf-both", "2026-02-03T09:00:00Z", "update", { status: ["todo", "doing"] });
    await ev("bf-both", "2026-02-10T09:00:00Z", "update", { status: ["doing", "done"], progress: [50, 100] });
    await mk("bf-progress", "doing");
    await ev("bf-progress", "2026-03-05T09:00:00Z", "update", { progress: [0, 20] });
    await mk("bf-log", "doing");
    await ev("bf-log", "2026-04-07T09:00:00Z", "progress", null);
    await mk("bf-reopened", "done");
    await ev("bf-reopened", "2026-05-01T09:00:00Z", "update", { status: ["todo", "done"] });
    await ev("bf-reopened", "2026-05-02T09:00:00Z", "update", { status: ["done", "doing"] });
    await ev("bf-reopened", "2026-05-09T09:00:00Z", "update", { status: ["doing", "done"] });
    await mk("bf-legacy", "done");
    await mk("bf-todo", "todo");
    await ev("bf-todo", "2026-06-01T09:00:00Z", "update", { title: ["a", "b"] });

    const mig = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0007"))!;
    const backfill = mig.queries.filter((q) => /UPDATE workpackage SET/i.test(q));
    expect(backfill.length).toBeGreaterThanOrEqual(2);
    await db.prepare("UPDATE workpackage SET actual_start = NULL, actual_end = NULL WHERE project_id = ?").bind(p.id).run();
    for (const q of backfill) await db.prepare(q).run();

    const get = async (id: string) => (await row(id))!;
    expect(await get("bf-both")).toMatchObject({ actual_start: "2026-02-03", actual_end: "2026-02-10" });
    expect(await get("bf-progress")).toMatchObject({ actual_start: "2026-03-05", actual_end: null });
    expect(await get("bf-log")).toMatchObject({ actual_start: "2026-04-07", actual_end: null });
    expect(await get("bf-reopened")).toMatchObject({ actual_start: "2026-05-01", actual_end: "2026-05-09" });
    // No events: D21 (e) falls back to the project (created_at here, no start date).
    expect(await get("bf-legacy")).toMatchObject({ actual_start: (await projCreated(p.id)), actual_end: null });
    expect(await get("bf-todo")).toMatchObject({ actual_start: null, actual_end: null });
  });

  it("D21 (e) fallback chain, todo exclusion (h), notes, override before the gate, end clamp; idempotent", async () => {
    const p = await proj();
    await db.prepare("UPDATE project SET start_date = NULL, created_at = '2026-01-20T08:00:00Z' WHERE id = ?").bind(p.id).run();
    const mk = (id: string, status: string, parent: string | null = null) =>
      db
        .prepare(
          "INSERT INTO workpackage (id, project_id, parent_id, title, status, progress, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        )
        .bind(id, p.id, parent, id, status)
        .run();
    const ev = (id: string, ts: string, action: string, diff: unknown) =>
      db
        .prepare("INSERT INTO event (ts, actor, project_id, entity, entity_id, action, diff_json) VALUES (?, 'test', ?, 'workpackage', ?, ?, ?)")
        .bind(ts, p.id, id, action, diff === null ? null : JSON.stringify(diff))
        .run();
    const gate = async (mid: string, reached: string | null, goAt: string | null, wps: string[]) => {
      await db
        .prepare("INSERT INTO milestone (id, project_id, title, gate, reached_at, created_at, updated_at) VALUES (?, ?, ?, 1, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
        .bind(mid, p.id, mid, reached)
        .run();
      for (const w of wps) await db.prepare("INSERT INTO milestone_link (milestone_id, workpackage_id, role) VALUES (?, ?, 'unlocks')").bind(mid, w).run();
      if (goAt)
        await db
          .prepare(
            "INSERT INTO decision (id, project_id, milestone_id, decision, decided_by, decided_at, actor, created_at) VALUES (?, ?, ?, 'go', 'x', ?, 'test', ?)",
          )
          .bind(`dec-${mid}`, p.id, mid, goAt, goAt)
          .run();
    };
    // 1: own event wins; a note before it does not count.
    await mk("fc-event", "done");
    await ev("fc-event", "2026-02-01T09:00:00Z", "note", { progress: [0, 10] });
    await ev("fc-event", "2026-02-05T09:00:00Z", "progress", null);
    // 1: log before the gate opening (override) wins over the gate.
    await mk("fc-override", "doing");
    await ev("fc-override", "2026-02-02T09:00:00Z", "progress", null);
    await gate("fc-g0", "2026-03-01T00:00:00Z", "2026-03-04T10:00:00Z", ["fc-override"]);
    // 2: later of reached and go (go later; then reached later).
    await mk("fc-gate-go", "done");
    await gate("fc-g1", "2026-03-01T00:00:00Z", "2026-03-04T10:00:00Z", ["fc-gate-go"]);
    await mk("fc-gate-reached", "doing");
    await gate("fc-g2", "2026-03-09T00:00:00Z", "2026-03-02T10:00:00Z", ["fc-gate-reached"]);
    // A gate with no go decision, or not reached, does not count: falls through to the parent.
    await mk("fc-gate-nogo", "doing");
    await gate("fc-g3", "2026-03-01T00:00:00Z", null, ["fc-gate-nogo"]);
    // 3: parent actual_start.
    await mk("fc-parent", "doing");
    await db.prepare("UPDATE workpackage SET actual_start = '2026-02-11' WHERE id = 'fc-parent'").run();
    await mk("fc-child", "doing", "fc-parent");
    // 4: project start date.
    const p2 = await proj();
    await db.prepare("UPDATE project SET start_date = '2026-01-15', created_at = '2026-01-20T08:00:00Z' WHERE id = ?").bind(p2.id).run();
    await db
      .prepare("INSERT INTO workpackage (id, project_id, title, status, progress, created_at, updated_at) VALUES ('fc-pstart', ?, 'x', 'waiting', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
      .bind(p2.id)
      .run();
    // 5: project created_at.
    await mk("fc-created", "blocked");
    // (h): todo WP with old progress events gets no start.
    await mk("fc-todo", "todo");
    await ev("fc-todo", "2026-02-03T09:00:00Z", "progress", null);
    // Clamp: fallback start later than the end.
    await mk("fc-clamp", "done");
    await ev("fc-clamp", "2026-01-25T09:00:00Z", "update", { status: ["doing", "done"] });
    await db.prepare("UPDATE workpackage SET actual_start = NULL, actual_end = NULL WHERE project_id IN (?, ?)").bind(p.id, p2.id).run();
    await db.prepare("UPDATE workpackage SET actual_start = '2026-02-11' WHERE id = 'fc-parent'").run();

    const mig = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0007"))!;
    const backfill = mig.queries.filter((q) => /UPDATE workpackage SET/i.test(q));
    const run = async () => {
      for (const q of backfill) await db.prepare(q).run();
    };
    await run();
    const snap = async () => (await db.prepare("SELECT id, actual_start, actual_end FROM workpackage WHERE project_id IN (?, ?) ORDER BY id").bind(p.id, p2.id).all()).results;
    const get = async (id: string) => (await row(id))!.actual_start;
    expect(await get("fc-event")).toBe("2026-02-05");
    expect(await get("fc-override")).toBe("2026-02-02");
    expect(await get("fc-gate-go")).toBe("2026-03-04");
    expect(await get("fc-gate-reached")).toBe("2026-03-09");
    expect(await get("fc-gate-nogo")).toBe("2026-01-20");
    expect(await get("fc-child")).toBe("2026-02-11");
    expect(await get("fc-pstart")).toBe("2026-01-15");
    expect(await get("fc-created")).toBe("2026-01-20");
    expect(await get("fc-todo")).toBeNull();
    expect(await row("fc-clamp")).toMatchObject({ actual_start: "2026-01-25", actual_end: "2026-01-25" });
    // Force a later fallback than the end: end 2026-01-10 with the project created 2026-01-20.
    await db.prepare("UPDATE workpackage SET actual_start = NULL, actual_end = '2026-01-10' WHERE id = 'fc-created'").run();
    await run();
    expect(await row("fc-created")).toMatchObject({ actual_start: "2026-01-10", actual_end: "2026-01-10" });
    const before = await snap();
    await run();
    expect(await snap()).toEqual(before);
  });
});

async function projCreated(id: string): Promise<string> {
  return (await db.prepare("SELECT substr(created_at, 1, 10) AS d FROM project WHERE id = ?").bind(id).first<{ d: string }>())!.d;
}

describe("actual dates", () => {
  it("status change sets actual_start once; done sets actual_end; reopening clears only the end", async () => {
    const p = await proj();
    const w = await upsertWorkpackage(db, p.id, { title: "status path" }, SYS);
    expect(w.actual_start).toBeNull();
    const started = await upsertWorkpackage(db, p.id, { id: w.id, status: "doing" }, SYS);
    expect(started.actual_start).toBe(today());
    expect(started.actual_end).toBeNull();
    await db.prepare("UPDATE workpackage SET actual_start = '2026-01-05' WHERE id = ?").bind(w.id).run();
    const done = await upsertWorkpackage(db, p.id, { id: w.id, status: "done" }, SYS);
    expect(done.actual_start).toBe("2026-01-05");
    expect(done.actual_end).toBe(today());
    const reopened = await upsertWorkpackage(db, p.id, { id: w.id, status: "doing" }, SYS);
    expect(reopened.actual_end).toBeNull();
    expect(reopened.actual_start).toBe("2026-01-05");
    const again = await upsertWorkpackage(db, p.id, { id: w.id, status: "todo" }, SYS);
    expect(again.actual_start).toBe("2026-01-05");
    const restarted = await upsertWorkpackage(db, p.id, { id: w.id, status: "doing" }, SYS);
    expect(restarted.actual_start).toBe("2026-01-05");
  });

  it("a log on a done WP with actual_end and no actual_start sets no start (progress log 409, note moves nothing)", async () => {
    const p = await proj();
    const w = await upsertWorkpackage(db, p.id, { title: "legacy done", status: "done" }, SYS);
    await db.prepare("UPDATE workpackage SET actual_start = NULL, actual_end = '2026-01-05' WHERE id = ?").bind(w.id).run();
    await expect(logProgress(db, { project_id: p.id, workpackage_id: w.id, summary: "late" }, SYS)).rejects.toMatchObject({
      status: 409,
      current: expect.objectContaining({ code: "WP_DONE" }),
    });
    const r = await logProgress(db, { project_id: p.id, workpackage_id: w.id, summary: "note", note: true }, SYS);
    expect(r.workpackage!.actual_start).toBeNull();
    expect(r.workpackage!.actual_end).toBe("2026-01-05");
  });

  it("progress above 0 starts a WP; creating done sets both", async () => {
    const p = await proj();
    const w = await upsertWorkpackage(db, p.id, { title: "progress path", progress: 10 }, SYS);
    expect(w.status).toBe("doing");
    expect(w.actual_start).toBe(today());
    const d = await upsertWorkpackage(db, p.id, { title: "born done", status: "done" }, SYS);
    expect(d.actual_start).toBe(today());
    expect(d.actual_end).toBe(today());
  });

  it("log_progress starts a WP (with and without progress) and finishes it at 100", async () => {
    const p = await proj();
    const a = await upsertWorkpackage(db, p.id, { title: "log plain" }, SYS);
    await logProgress(db, { project_id: p.id, summary: "worked", workpackage_id: a.id }, SYS);
    expect(await row(a.id)).toMatchObject({ status: "doing", actual_start: today(), actual_end: null });
    const b = await upsertWorkpackage(db, p.id, { title: "log progress" }, SYS);
    await logProgress(db, { project_id: p.id, summary: "some", workpackage_id: b.id, progress: 40 }, SYS);
    expect(await row(b.id)).toMatchObject({ status: "doing", actual_start: today(), actual_end: null });
    await db.prepare("UPDATE workpackage SET actual_start = '2026-01-05' WHERE id = ?").bind(b.id).run();
    await logProgress(db, { project_id: p.id, summary: "all", workpackage_id: b.id, progress: 100 }, SYS);
    expect(await row(b.id)).toMatchObject({ status: "done", actual_start: "2026-01-05", actual_end: today() });
    const c = await upsertWorkpackage(db, p.id, { title: "log straight to done" }, SYS);
    await logProgress(db, { project_id: p.id, summary: "quick", workpackage_id: c.id, progress: 100 }, SYS);
    expect(await row(c.id)).toMatchObject({ actual_start: today(), actual_end: today() });
    // A later log does not move the start.
    await db.prepare("UPDATE workpackage SET actual_start = '2026-01-06' WHERE id = ?").bind(a.id).run();
    await logProgress(db, { project_id: p.id, summary: "again", workpackage_id: a.id }, SYS);
    expect((await row(a.id))!.actual_start).toBe("2026-01-06");
  });

  it("explicit values: validated, future and inverted refused, null clears, events carry them", async () => {
    const p = await proj();
    const w = await upsertWorkpackage(db, p.id, { title: "explicit", actual_start: "2026-02-01", actual_end: "2026-02-09" }, SYS);
    expect(w).toMatchObject({ actual_start: "2026-02-01", actual_end: "2026-02-09" });
    await expect(upsertWorkpackage(db, p.id, { id: w.id, actual_end: "2026-01-31" }, SYS)).rejects.toThrow(ValidationError);
    await expect(upsertWorkpackage(db, p.id, { id: w.id, actual_start: "2999-01-01" }, SYS)).rejects.toThrow(/future/);
    await expect(upsertWorkpackage(db, p.id, { id: w.id, actual_start: "2026-13-40" }, SYS)).rejects.toThrow(/YYYY-MM-DD/);
    await expect(upsertWorkpackage(db, p.id, { id: w.id, actual_start: "yesterday" }, SYS)).rejects.toThrow(ValidationError);
    const cleared = await upsertWorkpackage(db, p.id, { id: w.id, actual_start: null, actual_end: null }, SYS);
    expect(cleared).toMatchObject({ actual_start: null, actual_end: null });
    const ev = await db
      .prepare("SELECT diff_json FROM event WHERE entity_id = ? AND action = 'update' ORDER BY id DESC LIMIT 1")
      .bind(w.id)
      .first<{ diff_json: string }>();
    expect(JSON.parse(ev!.diff_json)).toEqual({ actual_start: ["2026-02-01", null], actual_end: ["2026-02-09", null] });
  });

  it("auto-start: first progress log sets actual_start once, kept after a restart", async () => {
    const p = await proj();
    const w = await upsertWorkpackage(db, p.id, { title: "auto" }, SYS);
    await logProgress(db, { project_id: p.id, workpackage_id: w.id, summary: "first" }, SYS);
    expect(await row(w.id)).toMatchObject({ status: "doing", actual_start: today() });
    await db.prepare("UPDATE workpackage SET actual_start = '2026-01-05' WHERE id = ?").bind(w.id).run();
    await upsertWorkpackage(db, p.id, { id: w.id, status: "todo" }, SYS);
    await logProgress(db, { project_id: p.id, workpackage_id: w.id, summary: "again" }, SYS);
    expect(await row(w.id)).toMatchObject({ status: "doing", actual_start: "2026-01-05" });
  });

  it("log_progress refuses an automatic start that would follow the existing actual_end, writing nothing", async () => {
    const p = await proj();
    const w = await upsertWorkpackage(db, p.id, { title: "inv", actual_end: "2026-01-05" }, SYS);
    expect(await row(w.id)).toMatchObject({ status: "todo", actual_start: null, actual_end: "2026-01-05" });
    const events = async () => (await db.prepare("SELECT COUNT(*) AS n FROM event WHERE project_id = ?").bind(p.id).first<any>()).n;
    const n0 = await events();
    await expect(logProgress(db, { project_id: p.id, workpackage_id: w.id, summary: "x", session_id: "s-inv" }, SYS)).rejects.toThrow(ValidationError);
    await expect(logProgress(db, { project_id: p.id, workpackage_id: w.id, summary: "x", progress: 40 }, SYS)).rejects.toThrow(ValidationError);
    expect(await row(w.id)).toMatchObject({ status: "todo", actual_start: null, progress: 0, actual_end: "2026-01-05" });
    expect(await events()).toBe(n0);
    expect((await db.prepare("SELECT session_id FROM project WHERE id = ?").bind(p.id).first<any>()).session_id).not.toBe("s-inv");
  });

  it("REST and MCP: actual_end round-trips; an invalid code is 400", async () => {
    const p = await proj();
    const ok = await rest(EDITOR, "POST", "/api/workpackages", { project_id: p.id, title: "e", actual_start: "2026-03-01", actual_end: "2026-03-05" });
    expect(ok.status).toBe(201);
    const w = (await ok.json()) as any;
    expect(w).toMatchObject({ actual_end: "2026-03-05" });
    const list = (await (await rest(EDITOR, "GET", `/api/workpackages?project_id=${p.id}`)).json()) as any[];
    expect(list.find((x) => x.id === w.id)).toMatchObject({ actual_end: "2026-03-05" });
    const m = await mcpTool(EDITOR, "upsert_workpackage", { project_id: p.id, title: "m", actual_start: "2026-03-01", actual_end: "2026-03-07" });
    expect(m.isError).toBeFalsy();
    expect(m.body).toMatchObject({ actual_end: "2026-03-07" });
    const bad = await rest(EDITOR, "POST", "/api/workpackages", { project_id: p.id, title: "c", code: "bad code" });
    expect(bad.status).toBe(400);
  });

  it("REST: invalid and inverted dates are 400, valid values round-trip", async () => {
    const p = await proj();
    const bad = await rest(EDITOR, "POST", "/api/workpackages", { project_id: p.id, title: "r", actual_start: "2999-01-01" });
    expect(bad.status).toBe(400);
    const inv = await rest(EDITOR, "POST", "/api/workpackages", {
      project_id: p.id,
      title: "r",
      actual_start: "2026-03-02",
      actual_end: "2026-03-01",
    });
    expect(inv.status).toBe(400);
    const ok = await rest(EDITOR, "POST", "/api/workpackages", { project_id: p.id, title: "r", actual_start: "2026-03-01", code: "R-1" });
    expect(ok.status).toBe(201);
    const w = (await ok.json()) as any;
    expect(w).toMatchObject({ actual_start: "2026-03-01", code: "R-1" });
    const list = (await (await rest(EDITOR, "GET", `/api/workpackages?project_id=${p.id}`)).json()) as any[];
    expect(list.find((x) => x.id === w.id)).toMatchObject({ actual_start: "2026-03-01", code: "R-1" });
  });
});

describe("code", () => {
  it("accepts the D1 pattern, refuses others, null clears", async () => {
    const p = await proj();
    for (const ok of ["1", "WP1", "T01", "A.1-b", "A23456789012"]) {
      const w = await upsertWorkpackage(db, p.id, { title: `c ${ok}`, code: ok }, SYS);
      expect(w.code).toBe(ok);
    }
    for (const bad of ["-A", ".A", "A 1", "A_1", "A234567890123", "\u00c41", 5, "  "]) {
      await expect(upsertWorkpackage(db, p.id, { title: "bad", code: bad }, SYS)).rejects.toThrow(ValidationError);
    }
    const w = await upsertWorkpackage(db, p.id, { title: "clear me", code: "X1" }, SYS);
    expect((await upsertWorkpackage(db, p.id, { id: w.id, code: null }, SYS)).code).toBeNull();
    expect((await upsertWorkpackage(db, p.id, { id: w.id, code: "X2" }, SYS)).code).toBe("X2");
    expect((await upsertWorkpackage(db, p.id, { id: w.id, code: "" }, SYS)).code).toBeNull();
  });

  it("is returned by the detail tree, the upcoming list and reports, and shown before the title", async () => {
    const p = await proj();
    const w = await upsertWorkpackage(db, p.id, { title: "Coded WP", code: "WP7", end_date: "2030-01-01" }, SYS);
    const detail = await getProjectDetail(db, p.id);
    const find = (list: any[]): any => {
      for (const x of list) {
        if (x.id === w.id) return x;
        const f = find(x.children ?? []);
        if (f) return f;
      }
    };
    expect(find(detail.workpackages).code).toBe("WP7");
    const up = await upcomingWorkpackages(db, { project_id: p.id });
    expect(up.find((x) => x.id === w.id)!.code).toBe("WP7");
    const model = await buildReport(db, p.id);
    expect(model.workpackages.find((x) => x.title.includes("Coded WP"))!.title).toBe("WP7 Coded WP");
  });

  it("MCP round trip", async () => {
    const p = await proj();
    const r = await mcpTool(EDITOR, "upsert_workpackage", { project_id: p.id, title: "mcp", code: "M1", actual_start: "2026-03-01" });
    expect(r.isError).toBeFalsy();
    expect(r.body).toMatchObject({ code: "M1", actual_start: "2026-03-01" });
    const bad = await mcpTool(EDITOR, "upsert_workpackage", { project_id: p.id, title: "mcp2", code: "bad code" });
    expect(bad.isError).toBe(true);
  });
});

describe("local_host", () => {
  it("round-trips for editors and is absent for viewers in list, detail, events and MCP", async () => {
    const p = await createProject(db, { title: "QoL1 host", owner: "Owner", local_path: "C:/work/qol1", local_host: "  zz-host-name  " }, SYS);
    expect(p.local_host).toBe("zz-host-name");

    const eList = (await (await rest(EDITOR, "GET", "/api/projects")).json()) as any[];
    expect(eList.find((c) => c.id === p.id).local_host).toBe("zz-host-name");
    const vList = (await (await rest(VIEWER, "GET", "/api/projects")).json()) as any[];
    expect(vList.find((c) => c.id === p.id)).not.toHaveProperty("local_host");

    const eDetail = (await (await rest(EDITOR, "GET", `/api/projects/${p.id}`)).json()) as any;
    expect(eDetail.project.local_host).toBe("zz-host-name");
    const vText = await (await rest(VIEWER, "GET", `/api/projects/${p.id}`)).text();
    expect(JSON.parse(vText).project).not.toHaveProperty("local_host");
    expect(vText).not.toContain("zz-host-name");

    expect(await (await rest(VIEWER, "GET", `/api/events?project_id=${p.id}`)).text()).not.toContain("zz-host-name");
    expect(await (await rest(EDITOR, "GET", `/api/events?project_id=${p.id}`)).text()).toContain("zz-host-name");

    const vMcp = await mcpTool(VIEWER, "get_project", { id: p.id });
    expect(JSON.stringify(vMcp.body)).not.toContain("zz-host-name");
    expect((await mcpTool(EDITOR, "get_project", { id: p.id })).body.project.local_host).toBe("zz-host-name");

    const viewer = testCaller({ role: "viewer", channel: "dashboard" });
    expect((await getProjectDetail(db, p.id, viewer)).project).not.toHaveProperty("local_host");
    expect((await listProjects(db, {}, viewer)).find((c) => c.id === p.id)).not.toHaveProperty("local_host");
  });

  it("update via REST and MCP; null clears; over 100 characters is 400", async () => {
    const p = await proj();
    const r = await rest(EDITOR, "PATCH", `/api/projects/${p.id}`, { local_host: "laptop-1" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).local_host).toBe("laptop-1");
    const m = await mcpTool(EDITOR, "update_project", { id: p.id, patch: { local_host: "laptop-2" } });
    expect(m.body.local_host).toBe("laptop-2");
    expect((await updateProject(db, p.id, { local_host: null }, SYS)).local_host).toBeNull();
    expect((await rest(EDITOR, "PATCH", `/api/projects/${p.id}`, { local_host: "x".repeat(101) })).status).toBe(400);
    expect((await rest(EDITOR, "PATCH", `/api/projects/${p.id}`, { local_host: "x".repeat(100) })).status).toBe(200);
    const c = await mcpTool(EDITOR, "create_project", { title: "QoL1 mcp host", owner: "Owner", local_host: "box" });
    expect(c.body.local_host).toBe("box");
  });
});

describe("dashboard_prefs", () => {
  it("exists as a column but no person read returns it", async () => {
    const me = await ensureUserPerson(db, "user@example.com");
    await db.prepare("UPDATE person SET dashboard_prefs = ? WHERE id = ?").bind('{"zz":1}', me.id).run();
    expect(JSON.stringify(await listPersons(db))).not.toContain("dashboard_prefs");
    const res = await rest("user@example.com", "GET", "/api/persons");
    expect(await res.text()).not.toContain("zz");
  });
});
