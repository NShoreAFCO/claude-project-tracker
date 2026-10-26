// F2 (release R4): objectives, scope, acceptance criteria, verification.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { testCaller } from "./helpers";
import { createProject, getProjectDetail, updateProject } from "../src/data/projects";
import { upsertWorkpackage } from "../src/data/workpackages";
import { logProgress } from "../src/data/logs";
import { mcpCaller, serviceCaller, userCaller } from "../src/auth/caller";
import { ensureUserPerson, upsertPerson } from "../src/data/persons";
import { mcpApiHandler } from "../src/mcp/server";
import type { Env, WorkpackageRow } from "../src/types";

const db = env.DB;
const SYS = testCaller();
let n = 0;

const dash = (email = "user@example.com") => userCaller(db, email);
const agent = (email = "user@example.com") => mcpCaller(db, { email, clientName: "Claude" });
const svc = (onBehalfOf?: string) => serviceCaller(db, "hook:claude-code", onBehalfOf);
const wpRow = async (id: string) => (await db.prepare("SELECT * FROM workpackage WHERE id = ?").bind(id).first<WorkpackageRow>())!;
const conflict = (code: string) => ({ status: 409, current: expect.objectContaining({ code }) });

/** A project with one WP of the given verification method. */
async function setup(verification: string, extra: Record<string, unknown> = {}) {
  const p = await createProject(db, { title: `Verify ${++n}`, owner: "Owner" }, SYS);
  const wp = await upsertWorkpackage(db, p.id, { title: "Deliver", verification, ...extra }, SYS);
  return { p, wp };
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

describe("verification of work packages (F2)", () => {
  it("done with verification review defaults verified_by to the dashboard person", async () => {
    const { p, wp } = await setup("review");
    const me = await dash();
    const before = Date.now();
    const out = await upsertWorkpackage(db, p.id, { id: wp.id, status: "done" }, me);
    expect(out.status).toBe("done");
    expect(out.verified_by).toBe(me.personId);
    expect(Date.parse(out.verified_at!)).toBeGreaterThanOrEqual(before - 1000);
    // overridable: a dashboard person may name another person and a date
    const qa = await upsertPerson(db, { name: "QA Lead", email: "qa@example.com" }, SYS);
    const { p: p2, wp: w2 } = await setup("review");
    const o2 = await upsertWorkpackage(
      db,
      p2.id,
      { id: w2.id, status: "done", verified_by: "qa@example.com", verified_at: "2026-10-01" },
      me,
    );
    expect([o2.verified_by, o2.verified_at]).toEqual([qa.id, "2026-10-01"]);
    // reopening clears the verification
    const re = await upsertWorkpackage(db, p2.id, { id: w2.id, status: "doing" }, me);
    expect([re.verified_by, re.verified_at]).toEqual([null, null]);
  });

  it("sign_off cannot reach done through MCP without a person", async () => {
    const { p, wp } = await setup("sign_off");
    // an MCP caller whose grant carries no person
    const anon = await mcpCaller(db, { clientName: "Claude" });
    await expect(upsertWorkpackage(db, p.id, { id: wp.id, status: "done" }, anon)).rejects.toMatchObject(conflict("VERIFICATION_REQUIRED"));
    await expect(
      logProgress(db, { project_id: p.id, workpackage_id: wp.id, summary: "finished", progress: 100 }, anon),
    ).rejects.toMatchObject(conflict("VERIFICATION_REQUIRED"));
    // through the MCP tool: an explicit null, free text or an agent name is refused
    const r1 = await mcp("upsert_workpackage", { project_id: p.id, id: wp.id, status: "done", verified_by: null });
    expect(r1.isError).toBe(true);
    expect(body(r1)).toMatchObject({ error: "conflict", current: { code: "VERIFICATION_REQUIRED" } });
    const r2 = await mcp("upsert_workpackage", { project_id: p.id, id: wp.id, status: "done", verified_by: "mcp:Claude" });
    expect(r2.isError).toBe(true);
    expect(body(r2).error).toBe("invalid");
    // naming another person than the OAuth login is refused for agents
    await upsertPerson(db, { name: "Customer QA", email: "customer-qa@example.org" }, SYS);
    const r3 = await mcp("upsert_workpackage", { project_id: p.id, id: wp.id, status: "done", verified_by: "customer-qa@example.org" });
    expect(r3.isError).toBe(true);
    expect(body(r3).error).toBe("forbidden");
    expect((await wpRow(wp.id)).status).toBe("todo");
    // with the login's person (the default) it succeeds
    const ok = body(await mcp("upsert_workpackage", { project_id: p.id, id: wp.id, status: "done" }));
    const login = await ensureUserPerson(db, "user@example.com");
    expect([ok.status, ok.verified_by]).toEqual(["done", login.id]);
  });

  it("service caller without on_behalf_of cannot complete a verified WP", async () => {
    const { p, wp } = await setup("test");
    const bare = await svc();
    await expect(upsertWorkpackage(db, p.id, { id: wp.id, status: "done" }, bare)).rejects.toMatchObject(conflict("VERIFICATION_REQUIRED"));
    await expect(
      logProgress(db, { project_id: p.id, workpackage_id: wp.id, summary: "all green", progress: 100 }, bare),
    ).rejects.toMatchObject(conflict("VERIFICATION_REQUIRED"));
    expect((await wpRow(wp.id)).status).toBe("todo");
    // a service caller cannot name a person other than its on_behalf_of
    await expect(upsertWorkpackage(db, p.id, { id: wp.id, status: "done", verified_by: "user@example.com" }, bare)).rejects.toMatchObject({
      status: 403,
    });
    // a WP without verification is completed as before
    const { p: p2, wp: plain } = await setup("none");
    expect((await upsertWorkpackage(db, p2.id, { id: plain.id, status: "done" }, bare)).status).toBe("done");
    // with on_behalf_of the named person verifies (via log_progress too)
    const jane = await ensureUserPerson(db, "jane@example.com");
    const out = await logProgress(db, { project_id: p.id, workpackage_id: wp.id, summary: "all green", progress: 100 }, await svc(jane.id));
    expect([out.workpackage!.status, out.workpackage!.verified_by]).toEqual(["done", jane.id]);
    expect(out.workpackage!.verified_at).toBeTruthy();
  });

  it("log_progress refuses a completion whose verification appeared after the read", async () => {
    const { p, wp } = await setup("none");
    const bare = await svc();
    // verification set after the read of log_progress: the in-batch guard refuses
    const { setBeforeProgressWriteForTesting } = await import("../src/data/logs");
    setBeforeProgressWriteForTesting(async () => {
      await db.prepare("UPDATE workpackage SET verification = 'sign_off' WHERE id = ?").bind(wp.id).run();
    });
    try {
      await expect(
        logProgress(db, { project_id: p.id, workpackage_id: wp.id, summary: "done", progress: 100 }, bare),
      ).rejects.toMatchObject(conflict("VERIFICATION_REQUIRED"));
    } finally {
      setBeforeProgressWriteForTesting(null);
    }
    const row = await wpRow(wp.id);
    expect([row.status, row.progress, row.verified_by]).toEqual(["todo", 0, null]);
  });

  it("editing a done unverified WP's description succeeds", async () => {
    // legacy row: done before R4 (verification none, no verifier)
    const { p, wp } = await setup("none");
    await upsertWorkpackage(db, p.id, { id: wp.id, status: "done" }, SYS);
    for (const by of [await svc(), await agent(), await dash()]) {
      const out = await upsertWorkpackage(db, p.id, { id: wp.id, description_md: `edited by ${by.channel}` }, by);
      expect([out.status, out.description_md, out.verified_by]).toEqual(["done", `edited by ${by.channel}`, null]);
    }
    // a done row with a verification method but no verifier (written by an earlier version) stays editable too
    await db.prepare("UPDATE workpackage SET verification = 'sign_off' WHERE id = ?").bind(wp.id).run();
    const out = await upsertWorkpackage(
      db,
      p.id,
      { id: wp.id, title: "Deliver (renamed)", acceptance_criteria_md: "- builds" },
      await svc(),
    );
    expect([out.title, out.status, out.verified_by]).toEqual(["Deliver (renamed)", "done", null]);
  });

  it("agents cannot overwrite or re-date another person's verification", async () => {
    const { p, wp } = await setup("review");
    const other = await dash("reviewer@example.com");
    await upsertWorkpackage(db, p.id, { id: wp.id, status: "done", verified_at: "2026-10-01" }, other);
    const bot = await agent();
    for (const patch of [{ verification: "test" }, { verified_at: "2026-10-02" }, { verified_by: null }]) {
      await expect(upsertWorkpackage(db, p.id, { id: wp.id, ...patch }, bot)).rejects.toMatchObject({ status: 403 });
    }
    const row = await wpRow(wp.id);
    expect([row.verified_by, row.verified_at, row.verification]).toEqual([other.personId, "2026-10-01", "review"]);
    // unrelated edits and reopening (which clears the verification, kept in the history) stay possible
    expect((await upsertWorkpackage(db, p.id, { id: wp.id, description_md: "notes" }, bot)).verified_by).toBe(other.personId);
    expect((await upsertWorkpackage(db, p.id, { id: wp.id, status: "doing" }, bot)).verified_by).toBe(null);
  });

  it("log_progress refuses a completion after a reopen with sign_off between read and write", async () => {
    const { p, wp } = await setup("none");
    await upsertWorkpackage(db, p.id, { id: wp.id, status: "done" }, SYS);
    const bare = await svc();
    const { setBeforeProgressWriteForTesting } = await import("../src/data/logs");
    setBeforeProgressWriteForTesting(async () => {
      await upsertWorkpackage(db, p.id, { id: wp.id, status: "doing", progress: 50, verification: "sign_off" }, await dash());
    });
    try {
      await expect(
        logProgress(db, { project_id: p.id, workpackage_id: wp.id, summary: "done", progress: 100 }, bare),
      ).rejects.toMatchObject(conflict("VERIFICATION_REQUIRED"));
    } finally {
      setBeforeProgressWriteForTesting(null);
    }
    const row = await wpRow(wp.id);
    expect([row.status, row.verification, row.verified_by]).toEqual(["doing", "sign_off", null]);
  });

  it("agent cannot lower verification", async () => {
    const { p, wp } = await setup("sign_off");
    for (const by of [await svc(), await agent(), await svc((await ensureUserPerson(db, "jane@example.com")).id)]) {
      for (const lower of ["none", "test", "review"])
        await expect(upsertWorkpackage(db, p.id, { id: wp.id, verification: lower }, by)).rejects.toMatchObject({ status: 403 });
    }
    expect((await wpRow(wp.id)).verification).toBe("sign_off");
    // raising stays possible for agents; lowering is for dashboard persons
    const { p: p2, wp: w2 } = await setup("none");
    const bot = await agent();
    for (const up of ["review", "test", "sign_off"])
      expect((await upsertWorkpackage(db, p2.id, { id: w2.id, verification: up }, bot)).verification).toBe(up);
    expect((await upsertWorkpackage(db, p2.id, { id: w2.id, verification: "none" }, await dash())).verification).toBe("none");
  });

  it("agent cannot lower and complete in one write", async () => {
    const { p, wp } = await setup("sign_off");
    await expect(upsertWorkpackage(db, p.id, { id: wp.id, verification: "none", status: "done" }, await svc())).rejects.toMatchObject({
      status: 403,
    });
    const r = await mcp("upsert_workpackage", { project_id: p.id, id: wp.id, verification: "none", status: "done" });
    expect([r.isError, body(r).error]).toEqual([true, "forbidden"]);
    expect((await wpRow(wp.id)).status).toBe("todo");
  });

  it("service caller with on_behalf_of cannot change another person's verification", async () => {
    const { p, wp } = await setup("review");
    const reviewer = await dash("reviewer2@example.com");
    await upsertWorkpackage(db, p.id, { id: wp.id, status: "done" }, reviewer);
    const jane = await ensureUserPerson(db, "jane@example.com");
    const asJane = await svc(jane.id);
    for (const patch of [{ verified_by: jane.id }, { verified_at: "2026-10-02" }, { verification: "sign_off" }])
      await expect(upsertWorkpackage(db, p.id, { id: wp.id, ...patch }, asJane)).rejects.toMatchObject({ status: 403 });
    expect((await wpRow(wp.id)).verified_by).toBe(reviewer.personId);
  });

  it("verified_by must reference a person", async () => {
    const { p, wp } = await setup("demo");
    const me = await dash();
    await expect(upsertWorkpackage(db, p.id, { id: wp.id, status: "done", verified_by: "the customer" }, me)).rejects.toMatchObject({
      status: 400,
    });
    await expect(upsertWorkpackage(db, p.id, { id: wp.id, status: "done", verified_by: "mcp:Claude" }, me)).rejects.toMatchObject({
      status: 400,
    });
    // a person in the trash is not a verifier
    const gone = await upsertPerson(db, { name: "Former", email: "former@example.com" }, SYS);
    await db.prepare("UPDATE person SET deleted_at = '2026-01-01T00:00:00Z' WHERE id = ?").bind(gone.id).run();
    await expect(upsertWorkpackage(db, p.id, { id: wp.id, status: "done", verified_by: gone.id }, me)).rejects.toMatchObject({
      status: 400,
    });
    expect((await wpRow(wp.id)).status).toBe("todo");
    // an explicit null on done is "nobody verified": refused
    await expect(upsertWorkpackage(db, p.id, { id: wp.id, status: "done", verified_by: null }, me)).rejects.toMatchObject(
      conflict("VERIFICATION_REQUIRED"),
    );
  });

  it("validates verification fields and keeps them in the event diff", async () => {
    const { p, wp } = await setup("none", { deliverable: "Test report", acceptance_criteria_md: "- all tests pass" });
    expect([wp.verification, wp.deliverable, wp.acceptance_criteria_md]).toEqual(["none", "Test report", "- all tests pass"]);
    await expect(upsertWorkpackage(db, p.id, { id: wp.id, verification: "audit" }, SYS)).rejects.toMatchObject({ status: 400 });
    await expect(upsertWorkpackage(db, p.id, { id: wp.id, verified_at: "2999-01-01" }, SYS)).rejects.toMatchObject({ status: 400 });
    await expect(upsertWorkpackage(db, p.id, { id: wp.id, verified_at: "yesterday" }, SYS)).rejects.toMatchObject({ status: 400 });
    await expect(upsertWorkpackage(db, p.id, { id: wp.id, deliverable: "x".repeat(501) }, SYS)).rejects.toMatchObject({ status: 400 });
    // a new WP created as done with a verification method needs a verifier too
    await expect(upsertWorkpackage(db, p.id, { title: "Born done", status: "done", verification: "review" }, SYS)).rejects.toMatchObject(
      conflict("VERIFICATION_REQUIRED"),
    );
    const me = await dash();
    await upsertWorkpackage(db, p.id, { id: wp.id, verification: "review" }, me);
    await upsertWorkpackage(db, p.id, { id: wp.id, status: "done" }, me);
    const ev = await db
      .prepare("SELECT diff_json FROM event WHERE entity_id = ? AND action = 'update' ORDER BY id DESC LIMIT 1")
      .bind(wp.id)
      .first<{ diff_json: string }>();
    expect(JSON.parse(ev!.diff_json).verified_by).toEqual([null, me.personId]);
  });

  it("migration 0006 is additive: a row written without the new columns reads verification none", async () => {
    const p = await createProject(db, { title: `Legacy ${++n}`, owner: "Owner" }, SYS);
    const ts = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO workpackage (id, project_id, title, status, progress, weight, sort, version, created_at, updated_at) VALUES (?, ?, 'Old', 'done', 100, 1, 0, 1, ?, ?)",
      )
      .bind(`${p.id}-old`, p.id, ts, ts)
      .run();
    const row = await wpRow(`${p.id}-old`);
    expect([row.verification, row.verified_by, row.deliverable]).toEqual(["none", null, null]);
    const proj = await db.prepare("SELECT objectives_md, language FROM project WHERE id = ?").bind(p.id).first();
    expect(proj).toEqual({ objectives_md: null, language: null });
  });
});

describe("project objectives and scope (F2)", () => {
  it("stores objectives, scope, success criteria and language", async () => {
    const p = await createProject(
      db,
      { title: `Scope ${++n}`, owner: "Owner", objectives_md: "Ship v1", scope_in_md: "API", scope_out_md: "Mobile", language: "de" },
      SYS,
    );
    expect([p.objectives_md, p.scope_in_md, p.scope_out_md, p.language]).toEqual(["Ship v1", "API", "Mobile", "de"]);
    const u = await updateProject(db, p.id, { success_criteria_md: "- customer accepts", language: null }, SYS);
    expect([u.success_criteria_md, u.language]).toEqual(["- customer accepts", null]);
    await expect(updateProject(db, p.id, { language: "xx" }, SYS)).rejects.toMatchObject({ status: 400 });
    expect((await getProjectDetail(db, p.id)).project.objectives_md).toBe("Ship v1");
  });

  it("MCP create_project and update_project accept the objective and scope fields", async () => {
    const created = body(await mcp("create_project", { title: `Scope MCP ${++n}`, objectives_md: "Goal", scope_out_md: "Not this" }));
    expect([created.objectives_md, created.scope_out_md]).toEqual(["Goal", "Not this"]);
    const updated = body(await mcp("update_project", { id: created.id, patch: { scope_in_md: "This", language: "en" } }));
    expect([updated.scope_in_md, updated.language]).toEqual(["This", "en"]);
  });
});
