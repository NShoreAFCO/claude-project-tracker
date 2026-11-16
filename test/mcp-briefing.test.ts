import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mcpApiHandler } from "../src/mcp/server";
import { TOOL_ACTIONS } from "../src/auth/permissions";
import type { Env } from "../src/types";

let id = 0;
async function raw(name: string, args: Record<string, unknown>): Promise<any> {
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
const json = async (name: string, args: Record<string, unknown>) => JSON.parse((await raw(name, args)).content[0].text);
const text = async (args: Record<string, unknown>) => {
  const r = await raw("get_briefing", args);
  expect(r.isError).toBeFalsy();
  return r.content[0].text as string;
};

async function build(title: string, handover = true) {
  const p = await json("create_project", { title, target_date: "2027-06-30" });
  const w = (a: Record<string, unknown>) => json("upsert_workpackage", { project_id: p.id, ...a });
  const top = await w({ title: "Top", code: "WP3" });
  const doing = await w({ title: "Doing one", code: "WP3.1", parent_id: top.id, status: "doing" });
  await w({ title: "Todo one", code: "WP3.2", parent_id: top.id });
  await json("upsert_milestone", { project_id: p.id, title: "Alpha", due_date: "2027-01-15" });
  await json("upsert_milestone", { project_id: p.id, title: "Gate A", due_date: "2027-02-01", gate: true, unlocks: [top.id] });
  if (handover) {
    await json("append_context", { owner_kind: "project", owner_id: p.id, slug: "handover", heading: "Old", text: "old session text" });
    await json("append_context", { owner_kind: "project", owner_id: p.id, slug: "handover", heading: "Newest", text: "newest session text" });
  }
  return { p, top, doing };
}

describe("get_briefing", () => {
  it("returns header, active rows, next milestone and gate, last handover section, index", async () => {
    const { p } = await build("Brief full");
    const t = await text({ project_id: p.id });
    expect(t).toContain("# Brief full");
    expect(t).toContain("1 doing");
    expect(t).toContain("WP3.1 Doing one");
    expect(t).not.toContain("Todo one");
    expect(t).toContain("Milestone: Alpha");
    expect(t).toContain("Gate: Gate A");
    expect(t).toContain("unlocks WP3");
    expect(t).toContain("newest session text");
    expect(t).not.toContain("old session text");
    expect(t).toContain("Reference data");
    expect(t).toContain("## Context documents");
    expect(t).toContain("handover");
    expect(t.length).toBeLessThanOrEqual(4000);
  });

  it("with a work package lists only its subtree, by id or code", async () => {
    const { p, top, doing } = await build("Brief wp");
    const sib = await json("upsert_workpackage", { project_id: p.id, title: "Other doing", code: "WP4", status: "doing" });
    const t = await text({ project_id: p.id, wp_code: "WP3" });
    expect(t).toContain("scope WP3 Top");
    expect(t).toContain("Doing one");
    expect(t).not.toContain("Other doing");
    expect(await text({ project_id: p.id, workpackage_id: sib.id })).not.toContain("Doing one");
    expect(await text({ project_id: p.id, workpackage_id: top.id })).toContain("Doing one");
    expect(doing.id).toBeTruthy();
  });

  it("prefers the handover of the work package when it has one", async () => {
    const { p, top } = await build("Brief wp handover");
    await json("append_context", { owner_kind: "workpackage", owner_id: top.id, slug: "handover", heading: "WP", text: "wp level note" });
    expect(await text({ project_id: p.id, workpackage_id: top.id })).toContain("wp level note");
    expect(await text({ project_id: p.id })).not.toContain("wp level note");
  });

  it("refuses a work package of another project", async () => {
    const a = await build("Brief a", false);
    const b = await build("Brief b", false);
    const r = await raw("get_briefing", { project_id: a.p.id, workpackage_id: b.top.id });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/not.?found/i);
    const r2 = await raw("get_briefing", { project_id: a.p.id, wp_code: "WP99" });
    expect(r2.isError).toBe(true);
  });

  it("works without a handover document", async () => {
    const { p } = await build("Brief no handover", false);
    const t = await text({ project_id: p.id });
    expect(t).not.toContain("Last handover");
    expect(t).toContain("WP3.1 Doing one");
  });

  it("cuts at 4000 characters with a note, index first", async () => {
    const { p } = await build("Brief cap");
    for (let i = 0; i < 20; i++)
      await json("upsert_workpackage", { project_id: p.id, title: `Busy ${i} ${"x".repeat(150)}`, code: `T${i}`, status: "doing" });
    for (let i = 0; i < 20; i++) await json("write_context", { owner_kind: "project", owner_id: p.id, title: `Doc ${i}`, content_md: "body" });
    await json("append_context", { owner_kind: "project", owner_id: p.id, slug: "handover", heading: "Big", text: "h".repeat(5000) });
    const t = await text({ project_id: p.id });
    expect(t.length).toBeLessThanOrEqual(4000);
    expect(t).toContain("(cut to fit 4000 characters)");
    expect(t).not.toContain("## Context documents");
    expect(t).toContain("… ");
  }, 60_000);

  it("keeps the truncation note when header, Next and handover alone exceed the cap", async () => {
    const { p } = await build("Brief note " + "T".repeat(200));
    await json("upsert_milestone", { project_id: p.id, title: "M".repeat(1500), due_date: "2026-12-01" });
    await json("upsert_milestone", { project_id: p.id, title: "G".repeat(1500), due_date: "2026-12-02", gate: true });
    await json("upsert_workpackage", { project_id: p.id, title: "W".repeat(300), code: "WLONG", status: "doing" });
    await json("append_context", { owner_kind: "project", owner_id: p.id, slug: "handover", heading: "Big", text: "h\n".repeat(2000) });
    const t = await text({ project_id: p.id });
    expect(t.length).toBeLessThanOrEqual(4000);
    expect(t.endsWith("(cut to fit 4000 characters)")).toBe(true);
  }, 60_000);

  it("a viewer can read the briefing", async () => {
    const { p } = await build("Brief viewer");
    const d = (env as Env).DB;
    const role = (await d.prepare("SELECT access_role FROM person WHERE email = ?").bind("user@example.com").first<{ access_role: string }>())!.access_role;
    await d.prepare("UPDATE person SET access_role = 'viewer' WHERE email = ?").bind("user@example.com").run();
    try {
      expect(await text({ project_id: p.id })).toContain("# Brief viewer");
    } finally {
      await d.prepare("UPDATE person SET access_role = ? WHERE email = ?").bind(role, "user@example.com").run();
    }
  });

  it("is in the permission table as read", () => {
    expect(TOOL_ACTIONS.get_briefing).toBe("read");
  });
});
