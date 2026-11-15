// MCP write tools address a work package by id, or by project_id + wp_code; both run the same checks.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testCaller } from "./helpers";
import { gatedPlan } from "./fixtures/gated-plan";
import { createProject } from "../src/data/projects";
import { upsertWorkpackage } from "../src/data/workpackages";
import { upsertMilestone } from "../src/data/milestones";
import { resolveWpCode } from "../src/data/project-views";
import { deleteEntity } from "../src/data/entities";
import { ensureUserPerson } from "../src/data/persons";
import { mcpApiHandler } from "../src/mcp/server";
import type { Env, Role, WorkpackageRow } from "../src/types";

const db = env.DB;
const SYS = testCaller();
const EMAIL = "user@example.com";
let n = 0;

async function mcp(name: string, args: Record<string, unknown>) {
  const ctx = createExecutionContext() as ExecutionContext & { props?: unknown };
  ctx.props = { email: EMAIL, clientName: "Claude" };
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
  const line = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data: "))!.slice(6);
  const result = JSON.parse(line).result as { isError?: boolean; content: Array<{ text: string }> };
  const raw = result.content[0].text;
  // Schema errors from the SDK are plain text; the tool's own errors are JSON.
  const body = raw.startsWith("{") ? JSON.parse(raw) : { error: "schema", message: raw };
  return { isError: !!result.isError, body };
}

const wpRow = async (id: string) => (await db.prepare("SELECT * FROM workpackage WHERE id = ?").bind(id).first<WorkpackageRow>())!;

/** Project with two identical WPs (codes T01 and T02), so a write by id on one and by code on the other can be compared. */
async function twins() {
  const p = await createProject(db, { title: `Locator ${++n}`, owner: "Owner" }, SYS);
  const a = await upsertWorkpackage(db, p.id, { id: `${p.id}-a`, code: "T01", title: "Twin" }, SYS);
  const b = await upsertWorkpackage(db, p.id, { id: `${p.id}-b`, code: "T02", title: "Twin" }, SYS);
  return { p, a: a.id as string, b: b.id as string };
}

/** Drops what legitimately differs between the twins (ids, codes, timestamps) so results can be compared. */
function norm(value: unknown, ids: string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => norm(v, ids));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !/^(id|code|workpackage_id|branch_id|event_id|name|last_activity)$|(^|_)at$/.test(k))
        .map(([k, v]) => [k, norm(v, ids)]),
    );
  if (typeof value === "string") return ids.reduce((s, id) => s.split(id).join("<wp>"), value);
  return value;
}

/** The neutral gated plan with M1 as a gate: WP1 done, WP2 locked behind M1 (no decision yet). */
async function gated() {
  const p = await createProject(db, { title: `Locator gate ${++n}`, owner: "Owner", decision_maker: "dm@example.com" }, SYS);
  const plan = gatedPlan(`${p.id}-`);
  for (const w of plan.wps) await upsertWorkpackage(db, p.id, { ...w, code: w.title }, SYS);
  for (const m of plan.milestones) await upsertMilestone(db, p.id, { ...m, gate: m.title === "M1" }, SYS);
  await upsertWorkpackage(db, p.id, { id: `${p.id}-wp1`, status: "done" }, SYS);
  return { p, wp1: `${p.id}-wp1`, wp2: `${p.id}-wp2` };
}

let userRole: Role | null = null;
beforeAll(async () => {
  userRole = (await ensureUserPerson(db, EMAIL)).access_role;
  const dm = await ensureUserPerson(db, "dm@example.com");
  await db.prepare("UPDATE person SET access_role = 'decider' WHERE id = ?").bind(dm.id).run();
});
afterAll(async () => {
  await db.prepare("UPDATE person SET access_role = ? WHERE email = ?").bind(userRole, EMAIL).run();
});

describe("wp_code locator gives the same result as the id", () => {
  it("upsert_workpackage", async () => {
    const t = await twins();
    const byId = await mcp("upsert_workpackage", { project_id: t.p.id, id: t.a, progress: 30, expected_version: 1 });
    const byCode = await mcp("upsert_workpackage", { project_id: t.p.id, wp_code: "T02", progress: 30, expected_version: 1 });
    expect(byId.isError).toBe(false);
    expect(byCode.isError).toBe(false);
    expect(byCode.body.id).toBe(t.b);
    expect(norm(byCode.body, [t.b])).toEqual(norm(byId.body, [t.a]));
    expect((await wpRow(t.b)).progress).toBe(30);
    // expected_version is checked on the resolved id
    const stale = await mcp("upsert_workpackage", { project_id: t.p.id, wp_code: "T02", progress: 40, expected_version: 1 });
    expect(stale.body.error).toBe("conflict");
  });

  it("log_progress", async () => {
    const t = await twins();
    const byId = await mcp("log_progress", { project_id: t.p.id, workpackage_id: t.a, summary: "worked", progress: 20, effort_pd: 1 });
    const byCode = await mcp("log_progress", { project_id: t.p.id, wp_code: "T02", summary: "worked", progress: 20, effort_pd: 1 });
    expect(byId.isError).toBe(false);
    expect(norm(byCode.body, [t.b])).toEqual(norm(byId.body, [t.a]));
    const [a, b] = [await wpRow(t.a), await wpRow(t.b)];
    expect([b.status, b.progress, b.effort_actual_pd]).toEqual([a.status, a.progress, a.effort_actual_pd]);
    expect(b.status).toBe("doing");
  });

  it("link_branch", async () => {
    const t = await twins();
    const byId = await mcp("link_branch", { project_id: t.p.id, repo: "o/r", name: "feat/a", workpackage_id: t.a });
    const byCode = await mcp("link_branch", { project_id: t.p.id, repo: "o/r", name: "feat/b", wp_code: "T02" });
    expect(byId.isError).toBe(false);
    expect(byCode.body.workpackage_id).toBe(t.b);
    expect(norm(byCode.body, [t.b])).toEqual(norm(byId.body, [t.a]));
  });

  it("log_token_cost", async () => {
    const t = await twins();
    const byId = await mcp("log_token_cost", { project_id: t.p.id, claude_tokens: 100, workpackage_id: t.a });
    const byCode = await mcp("log_token_cost", { project_id: t.p.id, claude_tokens: 100, wp_code: "T02" });
    expect(byId.isError).toBe(false);
    expect(norm(byCode.body, [t.b])).toEqual(norm(byId.body, [t.a]));
    const row = await db.prepare("SELECT workpackage_id FROM token_cost WHERE project_id = ? AND workpackage_id = ?").bind(t.p.id, t.b).first();
    expect(row).not.toBeNull();
  });
});

describe("wp_code locator input", () => {
  it("surrounding whitespace in wp_code is trimmed", async () => {
    const t = await twins();
    const r = await mcp("log_progress", { project_id: t.p.id, wp_code: " T01 ", summary: "trimmed" });
    expect(r.isError).toBe(false);
    expect((await mcp("log_progress", { project_id: t.p.id, wp_code: "  T99	", summary: "x" })).body.error).toBe("not_found");
  });

  it("the code is matched in SQL: an exact code only, other WPs and other projects are not hit", async () => {
    const t = await twins();
    const other = await createProject(db, { title: `Locator sql ${++n}`, owner: "Owner" }, SYS);
    await upsertWorkpackage(db, other.id, { code: "T01", title: "Same code elsewhere" }, SYS);
    expect(await resolveWpCode(db, t.p.id, "T01")).toBe(t.a);
    expect(await resolveWpCode(db, t.p.id, "t01".toUpperCase())).toBe(t.a);
    await expect(resolveWpCode(db, t.p.id, "T0")).rejects.toThrow(/not found/);
    await expect(resolveWpCode(db, t.p.id, "T01 ")).rejects.toThrow(/not found/);
  });
});

describe("wp_code locator refusals", () => {
  it("both the id and wp_code is invalid, for every tool", async () => {
    const t = await twins();
    const calls: Array<[string, Record<string, unknown>]> = [
      ["upsert_workpackage", { project_id: t.p.id, id: t.a, wp_code: "T01", progress: 10 }],
      ["log_progress", { project_id: t.p.id, workpackage_id: t.a, wp_code: "T01", summary: "x" }],
      ["link_branch", { project_id: t.p.id, repo: "o/r", name: "x", workpackage_id: t.a, wp_code: "T01" }],
      ["log_token_cost", { project_id: t.p.id, claude_tokens: 1, workpackage_id: t.a, wp_code: "T01" }],
    ];
    for (const [name, args] of calls) expect([name, (await mcp(name, args)).body.error]).toEqual([name, "invalid"]);
    expect((await wpRow(t.a)).progress).toBe(0);
  });

  it("wp_code without project_id is invalid", async () => {
    await twins();
    for (const project_id of [undefined, ""]) {
      const r = await mcp("log_progress", { project_id, wp_code: "T01", summary: "x" });
      expect(r.isError).toBe(true);
      if (project_id === "") expect(r.body.error).toBe("invalid");
    }
  });

  it("wp_code never creates: an unknown code on upsert_workpackage is refused and nothing is created", async () => {
    const t = await twins();
    const r = await mcp("upsert_workpackage", { project_id: t.p.id, wp_code: "T99", title: "New" });
    expect(r.body.error).toBe("not_found");
    expect(r.body.message).toContain("T99");
    const count = await db.prepare("SELECT COUNT(*) AS c FROM workpackage WHERE project_id = ?").bind(t.p.id).first<{ c: number }>();
    expect(count!.c).toBe(2);
  });

  it("an unknown code, a code of another project and a trashed WP's code are not_found", async () => {
    const t = await twins();
    const other = await createProject(db, { title: `Locator other ${++n}`, owner: "Owner" }, SYS);
    await upsertWorkpackage(db, other.id, { code: "X01", title: "Elsewhere" }, SYS);
    await deleteEntity(db, "workpackage", t.b, SYS);
    for (const code of ["T99", "X01", "T02"]) {
      for (const [name, args] of [
        ["upsert_workpackage", { project_id: t.p.id, wp_code: code, progress: 10 }],
        ["log_progress", { project_id: t.p.id, wp_code: code, summary: "x" }],
        ["link_branch", { project_id: t.p.id, repo: "o/r", name: `b-${code}`, wp_code: code }],
        ["log_token_cost", { project_id: t.p.id, claude_tokens: 1, wp_code: code }],
      ] as Array<[string, Record<string, unknown>]>) {
        const r = await mcp(name, args);
        expect([name, code, r.body.error]).toEqual([name, code, "not_found"]);
        expect(r.body.message).toContain(code);
      }
    }
  });

  it("wp_code matches the code field only, never a row id", async () => {
    const t = await twins();
    const r = await mcp("log_progress", { project_id: t.p.id, wp_code: t.a, summary: "x" });
    expect(r.body.error).toBe("not_found");
    await upsertWorkpackage(db, t.p.id, { id: t.b, code: t.a }, SYS);
    const r2 = await mcp("log_progress", { project_id: t.p.id, wp_code: t.a, summary: "x" });
    expect(r2.isError).toBe(false);
  });

  it("a code shared by two live WPs of the project is invalid and names both ids", async () => {
    const t = await twins();
    await upsertWorkpackage(db, t.p.id, { id: t.b, code: "T01" }, SYS);
    const r = await mcp("log_progress", { project_id: t.p.id, wp_code: "T01", summary: "x" });
    expect(r.body.error).toBe("invalid");
    expect(r.body.message).toContain(t.a);
    expect(r.body.message).toContain(t.b);
  });
});

describe("wp_code locator runs the same checks as the id", () => {
  it("a gate-locked WP addressed by code is 409 GATE_LOCKED", async () => {
    const g = await gated();
    const up = await mcp("upsert_workpackage", { project_id: g.p.id, wp_code: "WP2", status: "doing" });
    expect(up.body.current.code).toBe("GATE_LOCKED");
    const log = await mcp("log_progress", { project_id: g.p.id, wp_code: "WP2", summary: "x", progress: 10 });
    expect(log.body.current.code).toBe("GATE_LOCKED");
    expect([up.body.error, log.body.error]).toEqual(["conflict", "conflict"]);
    expect((await wpRow(g.wp2)).status).toBe("todo");
  });

  it("a done WP addressed by code is 409 WP_DONE", async () => {
    const g = await gated();
    const r = await mcp("log_progress", { project_id: g.p.id, wp_code: "WP1", summary: "late" });
    expect(r.body.error).toBe("conflict");
    expect(r.body.current.code).toBe("WP_DONE");
  });

  it("completing a sign_off WP addressed by code needs a decider, as by id", async () => {
    const t = await twins();
    await upsertWorkpackage(db, t.p.id, { id: t.b, verification: "sign_off" }, SYS);
    const login = await ensureUserPerson(db, EMAIL);
    await db.prepare("UPDATE person SET access_role = 'editor' WHERE id = ?").bind(login.id).run();
    try {
      const up = await mcp("upsert_workpackage", { project_id: t.p.id, wp_code: "T02", status: "done" });
      const log = await mcp("log_progress", { project_id: t.p.id, wp_code: "T02", summary: "x", progress: 100 });
      expect([up.body.error, log.body.error]).toEqual(["forbidden", "forbidden"]);
      expect((await wpRow(t.b)).status).toBe("todo");
      await db.prepare("UPDATE person SET access_role = 'decider' WHERE id = ?").bind(login.id).run();
      const ok = await mcp("upsert_workpackage", { project_id: t.p.id, wp_code: "T02", status: "done" });
      expect([ok.body.status, ok.body.verified_by]).toEqual(["done", login.id]);
    } finally {
      await db.prepare("UPDATE person SET access_role = ? WHERE email = ?").bind(userRole, EMAIL).run();
    }
  });

  it("a viewer is forbidden, by code as by id", async () => {
    const t = await twins();
    await db.prepare("UPDATE person SET access_role = 'viewer' WHERE email = ?").bind(EMAIL).run();
    try {
      for (const [name, args] of [
        ["upsert_workpackage", { project_id: t.p.id, wp_code: "T01", progress: 10 }],
        ["log_progress", { project_id: t.p.id, wp_code: "T01", summary: "x" }],
        ["link_branch", { project_id: t.p.id, repo: "o/r", name: "v", wp_code: "T01" }],
        ["log_token_cost", { project_id: t.p.id, claude_tokens: 1, wp_code: "T01" }],
      ] as Array<[string, Record<string, unknown>]>)
        expect([name, (await mcp(name, args)).body.error]).toEqual([name, "forbidden"]);
    } finally {
      await db.prepare("UPDATE person SET access_role = ? WHERE email = ?").bind(userRole, EMAIL).run();
    }
    expect((await wpRow(t.a)).progress).toBe(0);
  });
});
