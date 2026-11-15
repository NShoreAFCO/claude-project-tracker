import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pkg from "../package.json";
import { mcpApiHandler } from "../src/mcp/server";
import type { Env } from "../src/types";
import { buildBudgetProject } from "./fixtures/budget-project";

// Lower a budget when a change shrinks it. Never raise one without a reason in the PR.
// Each line: the measured size in characters + 5 %, rounded up to 100.
export const BUDGETS: Record<string, number> = {
  tools_list: 39700,
  def_upsert_workpackage: 7000,
  res_upsert_wp_update: 1200,
  res_log_progress_wp: 1100,
  res_get_project_default: 78600,
  res_get_project_summary: 1600,
  res_get_project_outline: 12500,
  res_get_project_wp_main: 11400,
  res_bundle_default: 35300,
  res_list_projects: 500,
};

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
const len = (r: any): number => {
  expect(r.isError).toBeFalsy();
  return r.content[0].text.length;
};

const measured: Record<string, number> = {};

describe("MCP size budgets", () => {
  beforeAll(async () => {
    const p = await buildBudgetProject(call);
    const tools = (await rpc("tools/list")).result.tools as Array<{ name: string }>;
    measured.tools_list = JSON.stringify(tools).length;
    measured.def_upsert_workpackage = JSON.stringify(tools.find((t) => t.name === "upsert_workpackage")).length;
    measured.res_get_project_default = len(await call("get_project", { id: p.id }));
    measured.res_get_project_summary = len(await call("get_project", { id: p.id, view: "summary" }));
    measured.res_get_project_outline = len(await call("get_project", { id: p.id, view: "outline" }));
    measured.res_get_project_wp_main = len(await call("get_project", { id: p.id, wp: p.topWp.code }));
    measured.res_bundle_default = len(await call("get_context_bundle", { project_id: p.id }));
    measured.res_list_projects = len(await call("list_projects", {}));
    // Writes last: they change the project.
    const wp = JSON.parse((await call("get_project", { id: p.id, wp: p.leafWp.code })).content[0].text).workpackage;
    measured.res_upsert_wp_update = len(await call("upsert_workpackage", { project_id: p.id, id: wp.id, status: "doing" }));
    measured.res_log_progress_wp = len(
      await call("log_progress", { project_id: p.id, workpackage_id: wp.id, progress: 40, summary: "Measured progress entry" }),
    );
  }, 120_000);

  afterAll(() => {
    const rows = Object.keys(BUDGETS).map((k) => `${k.padEnd(26)} ${String(measured[k]).padStart(8)} ${String(BUDGETS[k]).padStart(8)}`);
    console.log(`MCP size budgets (metric, value, budget)\n${rows.join("\n")}`);
  });

  for (const metric of Object.keys(BUDGETS)) {
    it(`${metric} is within its budget`, () => {
      expect(measured[metric]).toBeGreaterThan(0);
      expect(measured[metric]).toBeLessThanOrEqual(BUDGETS[metric]);
    });
  }

  it("initialize reports the package.json version", async () => {
    const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(r.result.serverInfo.version).toBe(pkg.version);
  });
});
