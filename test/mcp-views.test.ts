import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mcpApiHandler } from "../src/mcp/server";
import type { Env } from "../src/types";

let id = 0;
async function rawCall(name: string, args: Record<string, unknown>): Promise<any> {
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
  const t = await res.text();
  const line = t.startsWith("{") ? t : t.split("\n").find((l) => l.startsWith("data: "))!.slice(6);
  return JSON.parse(line).result;
}
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  return JSON.parse((await rawCall(name, args)).content[0].text);
}

async function build() {
  const p = await call("create_project", { title: "Views default" });
  const w = async (a: Record<string, unknown>) => call("upsert_workpackage", { project_id: p.id, ...a });
  const top = await w({ title: "Top", code: "WP3" });
  const c1 = await w({ title: "C1", code: "WP3.1", parent_id: top.id, status: "doing" });
  await w({ title: "C2", code: "WP3.2", parent_id: top.id });
  await w({ title: "G1", code: "T01", parent_id: c1.id });
  return { p, top, c1 };
}

describe("get_project default and wp views", () => {
  it("no view is the summary; view=full keeps the full shape", async () => {
    const { p } = await build();
    const def = await call("get_project", { id: p.id });
    expect(def).toEqual(await call("get_project", { id: p.id, view: "summary" }));
    expect(def.workpackages).toBeUndefined();
    const full = await call("get_project", { id: p.id, view: "full" });
    expect(full.workpackages[0].code).toBe("WP3");
    expect(full.events).toBeDefined();
  });

  it("wp= returns the node without children plus direct children as depth 1 rows", async () => {
    const { p } = await build();
    const r = await call("get_project", { id: p.id, wp: "WP3" });
    expect(r.workpackage.code).toBe("WP3");
    expect(r.workpackage.children).toBeUndefined();
    expect(r.children.map((c: any) => [c.code, c.depth])).toEqual([["WP3.1", 1], ["WP3.2", 1]]);
    const outline = await call("get_project", { id: p.id, view: "outline" });
    const { depth: _d, ...row } = r.children[0];
    expect(row).toEqual(outline.workpackages.find((x: any) => x.code === "WP3.1"));
  });

  it("depth adds levels in tree order; status filters the rows", async () => {
    const { p, top } = await build();
    const r = await call("get_project", { id: p.id, wp: top.id, depth: 2 });
    expect(r.children.map((c: any) => [c.code, c.depth])).toEqual([["WP3.1", 1], ["T01", 2], ["WP3.2", 1]]);
    const f = await call("get_project", { id: p.id, wp: "WP3", depth: 2, status: ["doing"] });
    expect(f.children.map((c: any) => c.code)).toEqual(["WP3.1"]);
    const leaf = await call("get_project", { id: p.id, wp: "T01" });
    expect(leaf.children).toBeUndefined();
  });

  it("refuses depth outside 1..5 or not an integer; 5 is accepted", async () => {
    const { p } = await build();
    const bad = async (depth: unknown) => {
      const t = await rawCall("get_project", { id: p.id, wp: "WP3", depth });
      expect(t.isError).toBe(true);
    };
    for (const d of [0, 6, 1.5, "x"]) await bad(d);
    expect((await call("get_project", { id: p.id, wp: "WP3", depth: 5 })).children).toHaveLength(3);
  });

  it("an unknown wp is not_found", async () => {
    const { p } = await build();
    expect((await call("get_project", { id: p.id, wp: "WP99" })).error).toBe("not_found");
  });
});
