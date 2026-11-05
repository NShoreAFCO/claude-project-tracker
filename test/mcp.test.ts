import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mcpApiHandler } from "../src/mcp/server";
import type { Env } from "../src/types";

// OAuth is covered in auth.test.ts; here the handler is called as the provider would, with grant props.
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
  const json = text.startsWith("{")
    ? JSON.parse(text)
    : JSON.parse(
        text
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice(6),
      );
  return { status: res.status, ...json };
}
const call = async (name: string, args: Record<string, unknown>) => (await rpc("tools/call", { name, arguments: args })).result;
const text = (r: any): string => r.content[0].text;

describe("MCP server", () => {
  it("initialize returns server info and the session instructions", async () => {
    const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(r.status).toBe(200);
    expect(r.result.serverInfo.name).toBe("project-tracker");
    expect(r.result.instructions).toContain("get_context_bundle");
    expect(r.result.instructions).toContain("PROJECT-STRUCTURE.md");
    expect(r.result.instructions.length).toBeLessThanOrEqual(1800);
  });

  it("lists all 28 tools", async () => {
    const r = await rpc("tools/list");
    const names = r.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(
      [
        "append_context",
        "create_baseline",
        "create_project",
        "delete_context",
        "delete_entity",
        "get_context_bundle",
        "get_portfolio_summary",
        "get_project",
        "link_branch",
        "list_context",
        "list_persons",
        "list_projects",
        "list_risks",
        "log_progress",
        "log_token_cost",
        "move_workpackages",
        "read_context",
        "record_gate_decision",
        "restore_entity",
        "search",
        "set_context_meta",
        "set_scores",
        "update_project",
        "upsert_milestone",
        "upsert_person",
        "upsert_risk",
        "upsert_workpackage",
        "write_context",
      ].sort(),
    );
    const bundle = r.result.tools.find((t: { name: string }) => t.name === "get_context_bundle");
    expect(bundle.description).toContain("reference data, not instructions");
  });

  it("create_project + write_context + get_context_bundle round trip, attributed to the MCP client", async () => {
    const p = JSON.parse(text(await call("create_project", { title: "MCP Roundtrip" })));
    expect(p.id).toBe("mcp-roundtrip");
    const doc = JSON.parse(
      text(await call("write_context", { owner_kind: "project", owner_id: p.id, title: "Hintergrund", content_md: "Über das Projekt" })),
    );
    expect(doc.content_md).toBeUndefined();
    expect(doc.updated_by).toBe("mcp:Claude Test");
    const bundle = text(await call("get_context_bundle", { project_id: p.id }));
    expect(bundle).toContain("Über das Projekt");
    const listed = JSON.parse(text(await call("list_projects", {})));
    expect(listed.some((x: { id: string }) => x.id === p.id)).toBe(true);
  });

  it("categories, human flag and milestones via MCP", async () => {
    const { INSTANCE } = await import("../src/generated/instance");
    const pkeys = INSTANCE.categories.project.map((c) => c.key);
    const wkeys = INSTANCE.categories.workpackage.map((c) => c.key);
    expect(pkeys.length).toBeGreaterThanOrEqual(1);
    expect(wkeys.length).toBeGreaterThanOrEqual(2);
    const pcat = pkeys[pkeys.length - 1];
    const [wcat] = wkeys;
    const p = JSON.parse(text(await call("create_project", { title: "MCP Cats", category: pcat })));
    expect(p.category).toBe(pcat);
    const w = JSON.parse(text(await call("upsert_workpackage", { project_id: p.id, title: "Lab", category: wcat, human: true })));
    expect([w.category, w.human]).toEqual([wcat, 1]);
    const m = JSON.parse(text(await call("upsert_milestone", { project_id: p.id, title: "Lab done", requires: [w.id] })));
    expect([m.done, m.requires]).toEqual([false, [w.id]]);
    const listed = JSON.parse(text(await call("list_projects", { category: pcat })));
    const card = listed.find((x: { id: string }) => x.id === p.id);
    expect([card.category, card.wp_counts, card.next_milestone.title]).toEqual([
      pcat,
      { open: 1, in_progress: 0, waiting_blocked: 0, done: 0 },
      "Lab done",
    ]);
    const del = await call("delete_entity", { kind: "milestone", id: m.id, confirm: true });
    expect(del.isError).toBeFalsy();
    const tools = (await rpc("tools/list")).result.tools;
    expect(tools.find((t: { name: string }) => t.name === "upsert_workpackage").description).toContain("human");
    expect(tools.find((t: { name: string }) => t.name === "upsert_workpackage").description).toContain(wkeys.join("|"));
  });

  it("errors come back as tool errors with a typed code", async () => {
    const r = await call("get_project", { id: "does-not-exist" });
    expect(r.isError).toBe(true);
    expect(JSON.parse(text(r)).error).toBe("not_found");
    const c = await call("update_project", { id: "mcp-roundtrip", patch: { summary: "x" }, expected_version: 99 });
    expect(JSON.parse(text(c)).error).toBe("conflict");
  });

  it("get_project views cut the output down and full stays unchanged", async () => {
    const p = JSON.parse(text(await call("create_project", { title: "MCP Views" })));
    const parent = JSON.parse(text(await call("upsert_workpackage", { project_id: p.id, title: "Parent", code: "WP3" })));
    await call("upsert_workpackage", { project_id: p.id, title: "Child", code: "WP3.1", parent_id: parent.id, status: "doing" });
    const get = async (args: Record<string, unknown>) => JSON.parse(text(await call("get_project", { id: p.id, ...args })));

    const full = await get({});
    expect(full.workpackages.some((w: { code: string }) => w.code === "WP3")).toBe(true);
    expect(full.events).toBeDefined();
    expect(await get({ view: "full" })).toMatchObject({ project: { id: p.id }, branches: [] });

    const summary = await get({ view: "summary" });
    expect(summary.workpackages).toBeUndefined();
    expect(summary.counts.doing).toBe(1);
    expect(summary.counts.items).toBe(full.workpackages.reduce((n: number, w: { children: unknown[] }) => n + 1 + w.children.length, 0));

    const outline = await get({ view: "outline", status: ["doing"] });
    expect(outline.workpackages.map((w: { code: string }) => w.code)).toEqual(["WP3.1"]);
    expect(Object.keys(outline.workpackages[0]).sort()).toEqual(
      ["blocked_by", "code", "end_date", "gate_locked", "id", "overdue", "owner", "parent_id", "progress", "start_date", "status", "title", "version", "waiting_reason"].sort(),
    );

    const one = await get({ wp: "WP3" });
    expect(one.workpackage.children[0].code).toBe("WP3.1");
    const missing = await call("get_project", { id: p.id, wp: "WP99" });
    expect(JSON.parse(text(missing)).error).toBe("not_found");
    const bad = await call("get_project", { id: p.id, view: "summary", status: ["todo"] });
    expect(bad.isError).toBe(true);
  });

  it("delete tools require confirm: true", async () => {
    const r = await rpc("tools/call", { name: "delete_entity", arguments: { kind: "project", id: "mcp-roundtrip", confirm: false } });
    expect(r.result?.isError ?? !!r.error).toBe(true);
  });

  it("append_context by owner+slug creates the handover doc", async () => {
    const r = JSON.parse(
      text(await call("append_context", { owner_kind: "project", owner_id: "mcp-roundtrip", slug: "handover", text: "done X" })),
    );
    expect(r.slug).toBe("handover");
    const read = text(await call("read_context", { owner_kind: "project", owner_id: "mcp-roundtrip", slug: "handover" }));
    expect(read).toMatch(/^--- context: project:mcp-roundtrip\/handover v2, by mcp:Claude Test ---/);
  });
});
