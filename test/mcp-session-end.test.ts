import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mcpApiHandler } from "../src/mcp/server";
import { setBeforeProgressWriteForTesting } from "../src/data/logs";
import { CONTEXT_DOC_MAX_BYTES, type Env } from "../src/types";

const EMAIL = "user@example.com";
const db = (env as Env).DB;

let rid = 0;
async function rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const ctx = createExecutionContext() as ExecutionContext & { props?: unknown };
  ctx.props = { email: EMAIL, clientName: "Claude Test" };
  const res = await mcpApiHandler.fetch(
    new Request("https://tracker.test/mcp", {
      method: "POST",
      headers: {
        Host: "tracker.test",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }),
    }),
    env as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return text.startsWith("{")
    ? JSON.parse(text)
    : JSON.parse(
        text
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice(6),
      );
}
const call = async (name: string, args: Record<string, unknown>) => (await rpc("tools/call", { name, arguments: args })).result;
const ok = async (name: string, args: Record<string, unknown>) => {
  const r = await call(name, args);
  expect(r.isError, r.content?.[0]?.text).toBeFalsy();
  return JSON.parse(r.content[0].text);
};
const fail = async (name: string, args: Record<string, unknown>) => {
  const r = await call(name, args);
  expect(r.isError).toBe(true);
  return JSON.parse(r.content[0].text);
};

const counts = async (projectId: string) => {
  const q = async (sql: string) => (await db.prepare(sql).bind(projectId).first<{ n: number }>())!.n;
  return {
    events: await q("SELECT COUNT(*) AS n FROM event WHERE project_id = ?"),
    docs: await q("SELECT COUNT(*) AS n FROM context_doc WHERE project_id = ? AND slug = 'handover'"),
    tokens: await q("SELECT COUNT(*) AS n FROM token_cost WHERE project_id = ?"),
  };
};
const handoverOf = (kind: string, id: string) =>
  db
    .prepare("SELECT id, version, content_md FROM context_doc WHERE owner_kind = ? AND owner_id = ? AND slug = 'handover'")
    .bind(kind, id)
    .first<{ id: string; version: number; content_md: string }>();

async function setup(title: string) {
  const p = await ok("create_project", { title });
  const w = await ok("upsert_workpackage", { project_id: p.id, code: "WP3", title: "W" });
  return { p, w };
}

describe("log_progress at session end", () => {
  it("writes progress, the WP handover and the token cost in one call", async () => {
    const { p, w } = await setup("Session end WP");
    const a = await ok("log_progress", {
      project_id: p.id,
      wp_code: "WP3",
      summary: "did things",
      progress: 30,
      session_id: "sess-1",
      handover_md: "done: X\nopen: Y",
      claude_tokens: 1200,
      copilot_prompts: 3,
    });
    expect(a.id).toBe(w.id);
    expect(a.progress).toBe(30);
    expect(a.event_id).toBeTypeOf("number");
    const doc = await handoverOf("workpackage", w.id);
    expect(doc!.content_md).toContain("## Session end sess-1 (");
    expect(doc!.content_md).toContain("done: X\nopen: Y");
    expect(a.handover).toEqual({ doc_id: doc!.id, version: doc!.version });
    const tc = await db.prepare("SELECT * FROM token_cost WHERE id = ?").bind(a.token_cost.id).first<any>();
    expect(tc).toMatchObject({ project_id: p.id, workpackage_id: w.id, claude_tokens: 1200, copilot_prompts: 3, note: "session sess-1" });
    expect(a.warnings).toBeUndefined();
  });

  it("puts the handover on the project without a WP and appends to an existing doc", async () => {
    const { p } = await setup("Session end project");
    const first = await ok("log_progress", { project_id: p.id, summary: "s1", handover_md: "one" });
    expect(Object.keys(first).sort()).toEqual(["event_id", "handover"]);
    const second = await ok("log_progress", { project_id: p.id, summary: "s2", handover_md: "two" });
    expect(second.handover.doc_id).toBe(first.handover.doc_id);
    expect(second.handover.version).toBe(first.handover.version + 1);
    const doc = await handoverOf("project", p.id);
    expect(doc!.content_md).toMatch(/## Session end \(.*one[\s\S]*## Session end \(.*two/s);
  });

  it("refuses a WP of another project before any write", async () => {
    const a = await setup("Session end A");
    const b = await setup("Session end B");
    const before = await counts(a.p.id);
    const beforeB = await counts(b.p.id);
    const wpB = await db.prepare("SELECT version, progress, status FROM workpackage WHERE id = ?").bind(b.w.id).first();
    const e = await fail("log_progress", {
      project_id: a.p.id,
      workpackage_id: b.w.id,
      summary: "x",
      handover_md: "h",
      claude_tokens: 1,
    });
    expect(e.error).toBe("not_found");
    expect(await counts(a.p.id)).toEqual(before);
    expect(await counts(b.p.id)).toEqual(beforeB);
    expect(await db.prepare("SELECT version, progress, status FROM workpackage WHERE id = ?").bind(b.w.id).first()).toEqual(wpB);
  });

  it("refuses a viewer before any write", async () => {
    const { p, w } = await setup("Session end viewer");
    const role = (await db.prepare("SELECT access_role FROM person WHERE email = ?").bind(EMAIL).first<{ access_role: string }>())!
      .access_role;
    const before = await counts(p.id);
    await db.prepare("UPDATE person SET access_role = 'viewer' WHERE email = ?").bind(EMAIL).run();
    try {
      const e = await fail("log_progress", { project_id: p.id, workpackage_id: w.id, summary: "x", handover_md: "h", claude_tokens: 1 });
      expect(e.error).toBe("forbidden");
    } finally {
      await db.prepare("UPDATE person SET access_role = ? WHERE email = ?").bind(role, EMAIL).run();
    }
    expect(await counts(p.id)).toEqual(before);
  });

  it("a gate-locked WP refuses progress and gets no handover; a note takes both", async () => {
    const { p, w } = await setup("Session end gate");
    await ok("upsert_milestone", { project_id: p.id, title: "G", gate: true, due_date: "2030-01-01", unlocks: [w.id] });
    const before = await counts(p.id);
    const e = await fail("log_progress", { project_id: p.id, workpackage_id: w.id, summary: "x", progress: 10, handover_md: "h", claude_tokens: 5 });
    expect(e.error).toBe("conflict");
    expect(e.current.code).toBe("GATE_LOCKED");
    expect(await counts(p.id)).toEqual(before);
    // append_context has no lock rule, and a note is accepted on a locked WP: both parts land.
    const a = await ok("log_progress", { project_id: p.id, workpackage_id: w.id, summary: "remark", note: true, handover_md: "h", claude_tokens: 5 });
    expect(a.handover.doc_id).toBeTruthy();
    expect(a.token_cost.id).toBeTruthy();
    expect(a.status).toBe("todo");
  });

  it("refuses an append that cannot fit before any write", async () => {
    const { p, w } = await setup("Session end full");
    await ok("append_context", { owner_kind: "workpackage", owner_id: w.id, slug: "handover", text: "x" });
    await db
      .prepare("UPDATE context_doc SET bytes = ? WHERE owner_kind = 'workpackage' AND owner_id = ? AND slug = 'handover'")
      .bind(CONTEXT_DOC_MAX_BYTES - 10, w.id)
      .run();
    const before = await counts(p.id);
    const e = await fail("log_progress", { project_id: p.id, workpackage_id: w.id, summary: "x", progress: 5, handover_md: "h", claude_tokens: 5 });
    expect(e.error).toBe("too_large");
    expect(await counts(p.id)).toEqual(before);
  });

  it("keeps the progress and warns when the append fails after it", async () => {
    const { p, w } = await setup("Session end warn");
    await ok("append_context", { owner_kind: "workpackage", owner_id: w.id, slug: "handover", text: "x" });
    // Fill the doc between the pre-checks and the writes: the append's own guard then refuses it.
    setBeforeProgressWriteForTesting(async () => {
      await db
        .prepare("UPDATE context_doc SET bytes = ? WHERE owner_kind = 'workpackage' AND owner_id = ? AND slug = 'handover'")
        .bind(CONTEXT_DOC_MAX_BYTES - 10, w.id)
        .run();
    });
    let a: any;
    try {
      a = await ok("log_progress", { project_id: p.id, workpackage_id: w.id, summary: "x", progress: 40, handover_md: "h", claude_tokens: 7 });
    } finally {
      setBeforeProgressWriteForTesting(null);
    }
    expect(a.progress).toBe(40);
    expect(a.handover).toBeUndefined();
    expect(a.warnings).toHaveLength(1);
    expect(a.warnings[0]).toMatch(/^handover not written: /);
    expect(a.token_cost.id).toBeTruthy();
  });

  it("return:'full' carries the progress result plus the extra parts", async () => {
    const { p, w } = await setup("Session end full return");
    const a = await ok("log_progress", {
      project_id: p.id,
      workpackage_id: w.id,
      summary: "x",
      progress: 20,
      handover_md: "h",
      copilot_prompts: 2,
      return: "full",
    });
    expect(a.workpackage.id).toBe(w.id);
    expect(a.workpackage.title).toBe("W");
    expect(a.event_id).toBeTypeOf("number");
    expect(a.handover.doc_id).toBeTruthy();
    expect(a.token_cost.id).toBeTruthy();
  });
});
