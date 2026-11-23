// Health on the dashboard routes: the loader, the REST fields, and no health key in the MCP results.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { call, installTestKeys, testCaller, userJwt } from "./helpers";
import { createProject } from "../src/data/projects";
import { upsertWorkpackage } from "../src/data/workpackages";
import { upsertMilestone } from "../src/data/milestones";
import { upsertRisk } from "../src/data/risks";
import { healthByProject } from "../src/data/health";
import { mcpApiHandler } from "../src/mcp/server";
import type { Env } from "../src/types";

const db = env.DB;
const A = testCaller({ actor: "test" });
let n = 0;
const uniq = (s: string) => `${s} ${++n}`;
const TODAY = "2026-10-26";
const proj = async (extra: Record<string, unknown> = {}) =>
  (await createProject(db, { title: uniq("Health"), owner: "Owner", target_date: "2099-01-01", ...extra }, A)).id;
const sql = (q: string, ...b: unknown[]) =>
  db
    .prepare(q)
    .bind(...b)
    .run();

beforeAll(installTestKeys);

describe("healthByProject", () => {
  it("overdue milestone: late, with the milestone as first reason", async () => {
    const p = await proj();
    await upsertMilestone(db, p, { title: "Prototype", due_date: "2026-10-20" }, A);
    const h = (await healthByProject(db, TODAY, [p])).get(p);
    expect(h?.state).toBe("late");
    expect(h?.reasons[0]).toMatchObject({ kind: "milestone_overdue", title: "Prototype", days: 6 });
  });

  it("on-hold project: on_hold; done project: null", async () => {
    const hold = await proj();
    await sql("UPDATE project SET status = 'on_hold' WHERE id = ?", hold);
    const done = await proj();
    await sql("UPDATE project SET status = 'done' WHERE id = ?", done);
    const map = await healthByProject(db, TODAY, [hold, done]);
    expect(map.get(hold)).toEqual({ state: "on_hold", reasons: [{ kind: "on_hold" }] });
    expect(map.get(done)).toBeNull();
  });

  it("loads all live projects when no ids are given, and skips deleted ones", async () => {
    const live = await proj();
    const gone = await proj();
    await sql("UPDATE project SET deleted_at = ? WHERE id = ?", "2026-10-01T00:00:00.000Z", gone);
    const map = await healthByProject(db, TODAY);
    expect(map.has(live)).toBe(true);
    expect(map.has(gone)).toBe(false);
    expect((await healthByProject(db, TODAY, [])).size).toBe(0);
  });

  it("high risk, blocked work package and late work package make the project at risk", async () => {
    const risky = await proj();
    await upsertRisk(db, risky, { title: "Supplier loss", probability: 4, impact: 4 }, A);
    const blocked = await proj();
    await upsertWorkpackage(db, blocked, { title: "Stuck", status: "blocked", blocked_by: "x" }, A);
    const slow = await proj();
    await upsertWorkpackage(db, slow, { title: "Slow", status: "doing", end_date: "2026-10-10" }, A);
    const map = await healthByProject(db, TODAY, [risky, blocked, slow]);
    expect(map.get(risky)?.state).toBe("at_risk");
    expect(map.get(risky)?.reasons[0]).toMatchObject({ kind: "high_risk", score: 16 });
    expect(map.get(blocked)?.reasons[0]).toMatchObject({ kind: "wp_blocked", title: "Stuck" });
    expect(map.get(slow)?.reasons[0]).toMatchObject({ kind: "wp_late", days: 16 });
  });

  it("a reached gate without a decision due soon is at risk; a decided one is not", async () => {
    const open = await proj();
    const decided = await proj();
    for (const p of [open, decided]) {
      const g = await upsertMilestone(db, p, { title: "Gate", gate: true, due_date: "2026-10-27" }, A);
      await sql("UPDATE milestone SET reached_at = ? WHERE id = ?", "2026-10-20T10:00:00.000Z", g.id);
      if (p === decided)
        await sql(
          "INSERT INTO decision (id, project_id, milestone_id, decision, decided_by, decided_at, actor, created_at) VALUES (?, ?, ?, 'go', 'test', ?, 'test', ?)",
          `d-${g.id}`,
          p,
          g.id,
          "2026-10-21T10:00:00.000Z",
          "2026-10-21T10:00:00.000Z",
        );
    }
    const map = await healthByProject(db, TODAY, [open, decided]);
    expect(map.get(open)?.state).toBe("at_risk");
    expect(map.get(open)?.reasons[0]).toMatchObject({ kind: "gate_due" });
    expect(map.get(decided)?.state).toBe("on_track");
  });

  it("an active project without progress for stale_days is stalled when it has open work", async () => {
    const p = await proj();
    await upsertWorkpackage(db, p, { title: "Open", status: "todo" }, A);
    await sql("UPDATE project SET last_progress_at = ?, created_at = ? WHERE id = ?", "2026-09-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z", p);
    const h = (await healthByProject(db, TODAY, [p])).get(p);
    expect(h?.state).toBe("stalled");
    expect(h?.reasons[0]).toEqual({ kind: "no_activity", days: 55 });
  });
});

describe("REST health field", () => {
  it("project list cards and project detail carry health", async () => {
    const p = await proj();
    await upsertMilestone(db, p, { title: "Old", due_date: "2000-01-01" }, A);
    const jwt = await userJwt();
    const list = (await (await call("/api/projects", { jwt })).json()) as Array<{ id: string; health: unknown }>;
    const card = list.find((x) => x.id === p);
    expect(card?.health).toMatchObject({ state: "late" });
    const detail = (await (await call(`/api/projects/${p}`, { jwt })).json()) as { project: { id: string }; health: unknown };
    expect(detail.project.id).toBe(p);
    expect(detail.health).toMatchObject({ state: "late" });
  });

  it("a closed project has health null", async () => {
    const p = await proj();
    await sql("UPDATE project SET status = 'done' WHERE id = ?", p);
    const detail = (await (await call(`/api/projects/${p}`, { jwt: await userJwt() })).json()) as { health: unknown };
    expect(detail.health).toBeNull();
  });
});

describe("MCP results carry no health", () => {
  let id = 0;
  async function tool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const ctx = createExecutionContext() as ExecutionContext & { props?: unknown };
    ctx.props = { email: "user@example.com", clientName: "Claude Test" };
    const res = await mcpApiHandler.fetch(
      new Request("https://tracker.test/mcp", {
        method: "POST",
        headers: {
          Host: "tracker.test",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
      }),
      env as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const body = await res.text();
    const json = body.startsWith("{")
      ? JSON.parse(body)
      : JSON.parse(
          body
            .split("\n")
            .find((l) => l.startsWith("data: "))!
            .slice(6),
        );
    return JSON.parse(json.result.content[0].text);
  }

  it("list_projects, get_project and get_portfolio_summary have no health key", async () => {
    const p = await proj();
    await upsertMilestone(db, p, { title: "Old", due_date: "2000-01-01" }, A);
    const listed = (await tool("list_projects", {})) as Array<Record<string, unknown>>;
    const card = listed.find((x) => x.id === p)!;
    expect(card).toBeDefined();
    expect("health" in card).toBe(false);
    const detail = (await tool("get_project", { id: p, view: "full" })) as Record<string, unknown>;
    expect(JSON.stringify(detail)).not.toContain('"health"');
    const summary = (await tool("get_portfolio_summary", {})) as Record<string, unknown>;
    expect(JSON.stringify(summary)).not.toContain('"health"');
  });
});
