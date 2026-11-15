import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mcpApiHandler } from "../src/mcp/server";
import type { Env } from "../src/types";

let id = 0;
async function rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
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
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    }),
    env as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return text.startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
}
const call = async (name: string, args: Record<string, unknown>) => (await rpc("tools/call", { name, arguments: args })).result;
const data = async (name: string, args: Record<string, unknown>): Promise<any> => {
  const r = await call(name, args);
  expect(r.isError, r.content?.[0]?.text).toBeFalsy();
  return JSON.parse(r.content[0].text);
};

describe("MCP list limits", () => {
  it("search: default 10, more, limit, kind", async () => {
    const p = await data("create_project", { title: "Lists Search" });
    for (let i = 0; i < 13; i++) await data("upsert_workpackage", { project_id: p.id, title: `Quokka task ${i}` });
    await data("upsert_milestone", { project_id: p.id, title: "Quokka milestone" });
    const d = await data("search", { query: "Quokka" });
    expect(d.hits.length).toBe(10);
    expect(d.more).toBe(4);
    const small = await data("search", { query: "Quokka", limit: 3 });
    expect([small.hits.length, small.more]).toEqual([3, 11]);
    const ms = await data("search", { query: "Quokka", kind: "milestone" });
    expect(ms.hits.map((h: { kind: string }) => h.kind)).toEqual(["milestone"]);
    expect(ms.more).toBeUndefined();
    const wide = await data("search", { query: "Quokka", limit: 50 });
    expect(wide.hits.length).toBe(14);
    expect(wide.more).toBeUndefined();
  });

  it("search refuses limits outside 1..50, fractions and unknown kinds", async () => {
    for (const bad of [{ limit: 0 }, { limit: 51 }, { limit: 2.5 }, { kind: "branch" }])
      expect((await call("search", { query: "Quokka", ...bad })).isError).toBe(true);
  });

  it("list_risks: slim rows, id returns one in full", async () => {
    const p = await data("create_project", { title: "Lists Risks" });
    const r = await data("upsert_risk", {
      project_id: p.id,
      type: "risk",
      title: "Slim risk",
      description_md: "Long description",
      probability: 3,
      impact: 4,
      response: "reduce",
      action: "Do something",
    });
    const rows = await data("list_risks", { project_id: p.id });
    expect(rows.length).toBe(1);
    expect(Object.keys(rows[0]).sort()).toEqual(["id", "project_id", "score", "status", "title", "type"]); // empty owner and due are omitted
    expect(rows[0]).toMatchObject({ id: r.id, title: "Slim risk", score: 12, type: "risk", status: "open" });
    const one = await data("list_risks", { id: r.id });
    expect(one.description_md).toBe("Long description");
    expect(one.action).toBe("Do something");
    expect((await call("list_risks", { id: "nope" })).isError).toBe(true);
  });

  it("list_projects: active and on_hold by default, wp_counts only with counts", async () => {
    const act = await data("create_project", { title: "Lists Active", status: "idea" });
    await data("update_project", { id: act.id, patch: { status: "on_hold" } });
    const idea = await data("create_project", { title: "Lists Idea", status: "idea" });
    const def = await data("list_projects", {});
    const ids = def.map((x: { id: string }) => x.id);
    expect(ids).toContain(act.id);
    expect(ids).not.toContain(idea.id);
    expect(def.every((x: { status: string }) => ["active", "on_hold"].includes(x.status))).toBe(true);
    expect(def[0].wp_counts).toBeUndefined();
    const ideas = await data("list_projects", { status: "idea" });
    expect(ideas.map((x: { id: string }) => x.id)).toContain(idea.id);
    const counted = await data("list_projects", { counts: true });
    expect(counted[0].wp_counts).toBeDefined();
  });

  it("get_project view=full keeps the latest 20 branches and context docs, with totals", async () => {
    const p = await data("create_project", { title: "Lists Full" });
    for (let i = 0; i < 21; i++) {
      await data("link_branch", { project_id: p.id, repo: "r/x", name: `feat/b${String(i).padStart(2, "0")}` });
      await data("write_context", { owner_kind: "project", owner_id: p.id, title: `Doc ${i}`, content_md: `body ${i}` });
    }
    const full = await data("get_project", { id: p.id, view: "full" });
    expect(full.branches.length).toBe(20);
    expect(full.branches_total).toBe(21);
    expect(full.context_index.length).toBe(20);
    expect(full.context_total).toBe(21);
    const names = full.branches.map((b: { name: string }) => b.name);
    expect(names).toContain("feat/b20");
    expect(names).not.toContain("feat/b00");
    const small = await data("create_project", { title: "Lists Full Small" });
    await data("link_branch", { project_id: small.id, repo: "r/x", name: "feat/only" });
    const f2 = await data("get_project", { id: small.id, view: "full" });
    expect(f2.branches.length).toBe(1);
    expect(f2.branches_total).toBeUndefined();
    expect(f2.context_total).toBeUndefined();
  }, 30_000);
});
