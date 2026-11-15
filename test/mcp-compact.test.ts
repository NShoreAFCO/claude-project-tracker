import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { compactResult, dropDuplicateDependsIds } from "../src/mcp/compact";
import { mcpApiHandler, SERVER_INSTRUCTIONS } from "../src/mcp/server";
import type { Env } from "../src/types";

describe("compactResult", () => {
  it("keeps false, 0 and \"0\"", () => {
    expect(compactResult({ a: false, b: 0, c: "0", d: "x" })).toEqual({ a: false, b: 0, c: "0", d: "x" });
  });
  it("drops null, empty text, empty lists and empty objects, nested", () => {
    expect(compactResult({ a: null, b: "", c: [], d: {}, e: { f: null, g: [], h: 1 } })).toEqual({ e: { h: 1 } });
  });
  it("drops an object that is empty only after compaction", () => {
    expect(compactResult({ a: { b: { c: null } }, k: 1 })).toEqual({ k: 1 });
  });
  it("keeps array elements and order, compacts object elements", () => {
    expect(compactResult({ l: [3, null, "", { a: null, b: 1 }, {}, 0] })).toEqual({ l: [3, null, "", { b: 1 }, {}, 0] });
  });
  it("drops schedule_issues only when it is the string \"[]\"", () => {
    expect(compactResult({ schedule_issues: "[]", x: 1 })).toEqual({ x: 1 });
    expect(compactResult({ schedule_issues: '[{"a":1}]' })).toEqual({ schedule_issues: '[{"a":1}]' });
  });
  it("does not alter strings", () => {
    expect(compactResult(" a b ")).toBe(" a b ");
    expect(compactResult({ s: "  " })).toEqual({ s: "  " });
  });
});

describe("dropDuplicateDependsIds", () => {
  it("drops the parsed copy, keeps it when different", () => {
    expect(dropDuplicateDependsIds({ depends_on: '["a"]', depends_ids: ["a"], k: [{ depends_on: '["b"]', depends_ids: ["b"] }] })).toEqual({
      depends_on: '["a"]',
      k: [{ depends_on: '["b"]' }],
    });
    expect(dropDuplicateDependsIds({ depends_on: '["a"]', depends_ids: ["z"] })).toEqual({ depends_on: '["a"]', depends_ids: ["z"] });
  });
});

let id = 0;
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const ctx = createExecutionContext() as ExecutionContext & { props?: unknown };
  ctx.props = { email: "user@example.com", clientName: "Claude Test" };
  const res = await mcpApiHandler.fetch(
    new Request("https://tracker.test/mcp", {
      method: "POST",
      headers: { Host: "tracker.test", "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
    }),
    env as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const t = await res.text();
  return (t.startsWith("{") ? JSON.parse(t) : JSON.parse(t.split("\n").find((l) => l.startsWith("data: "))!.slice(6))).result;
}
const parse = (r: any) => JSON.parse(r.content[0].text);

describe("MCP results are compacted", () => {
  it("omits empty fields, keeps false, drops nested project_id and depends_ids", async () => {
    const p = parse(await call("create_project", { title: "Compact" }));
    const a = parse(await call("upsert_workpackage", { project_id: p.id, title: "A", code: "WP3" }));
    const b = parse(await call("upsert_workpackage", { project_id: p.id, title: "B", code: "WP4", depends_on: [a.id] }));
    await call("upsert_milestone", { project_id: p.id, title: "M", due_date: "2030-01-01", gate: false });
    expect(JSON.stringify(b)).not.toContain('":null');
    expect(b.depends_ids).toBeUndefined();
    const full = parse(await call("get_project", { id: p.id }));
    const flat = JSON.stringify(full);
    expect(flat).not.toContain('":null');
    expect(flat).not.toContain('":""');
    expect(flat).not.toContain("depends_ids");
    expect(JSON.stringify(full.workpackages)).not.toContain("project_id");
    expect(JSON.stringify(full.milestones)).not.toContain("project_id");
    const sum = parse(await call("get_project", { id: p.id, view: "summary" }));
    expect(sum.milestones[0].gate).toBe(false);
  });
  it("leaves error replies unchanged", async () => {
    const r = await call("get_project", { id: "nope" });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text)).toEqual({ error: "not_found", message: expect.any(String) });
  });
  it("says so in the instructions", () => {
    expect(SERVER_INSTRUCTIONS).toContain("an absent field means empty");
  });
});
