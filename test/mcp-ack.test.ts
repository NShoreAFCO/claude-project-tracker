import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ack, slimConflict } from "../src/mcp/ack";
import { mcpApiHandler } from "../src/mcp/server";
import type { Env } from "../src/types";

let rid = 0;
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
/** Calls a tool, expects success and parses the JSON text. */
const ok = async (name: string, args: Record<string, unknown>) => {
  const r = await call(name, args);
  expect(r.isError, r.content?.[0]?.text).toBeFalsy();
  return JSON.parse(r.content[0].text);
};

const wp = {
  id: "w1",
  project_id: "p",
  code: "WP3",
  title: "T",
  description_md: "long text",
  status: "doing",
  progress: 10,
  version: 2,
  weight: 1,
  actual_start: "2026-01-01",
  verified_by: "person-1",
  verified_at: "2026-01-02T00:00:00.000Z",
};

describe("ack", () => {
  it("keeps the minimum keys only", () => {
    expect(ack({ ...wp, actual_start: undefined, verified_by: null, verified_at: null, warnings: [] }, { id: "w1" })).toEqual({
      id: "w1",
      code: "WP3",
      version: 2,
      status: "doing",
      progress: 10,
    });
  });

  it("adds warnings only when non-empty", () => {
    const w = [{ code: "DEP_ORDER", id: "w1" }];
    expect(ack({ id: "a", version: 1, warnings: w }, {})).toEqual({ id: "a", version: 1, warnings: w });
    expect(ack({ id: "a", version: 1, warnings: [] }, {})).toEqual({ id: "a", version: 1 });
  });

  it("includes the status the server set when the caller sent none", () => {
    expect(ack({ id: "a", version: 2, status: "doing", progress: 5 }, { id: "a", progress: 5 })).toEqual({
      id: "a",
      version: 2,
      status: "doing",
      progress: 5,
    });
  });

  it("includes verified_by, verified_at and actual dates the server set, not the ones the caller sent", () => {
    expect(ack(wp, { id: "w1", status: "done" })).toMatchObject({
      actual_start: "2026-01-01",
      verified_by: "person-1",
      verified_at: "2026-01-02T00:00:00.000Z",
    });
    const sent = ack(wp, { id: "w1", actual_start: "2026-01-01", verified_by: "person-1" }) as Record<string, unknown>;
    expect(sent.actual_start).toBeUndefined();
    expect(sent.verified_by).toBeUndefined();
    expect(sent.verified_at).toBe("2026-01-02T00:00:00.000Z");
  });

  it("looks into patch for update_project style args", () => {
    const out = ack({ id: "p", version: 3, status: "active", actual_end: "2026-02-02" }, { id: "p", patch: { actual_end: "2026-02-02" } });
    expect(out).toEqual({ id: "p", version: 3, status: "active" });
  });

  it("drops everything else", () => {
    const out = ack(wp, { id: "w1" }) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(["actual_start", "code", "id", "progress", "status", "verified_at", "verified_by", "version"]);
  });

  it("acknowledges a progress log with its work package, or only the event", () => {
    expect(
      ack({ event_id: 7, workpackage: { ...wp, actual_start: null, verified_by: null, verified_at: null } }, { progress: 10 }),
    ).toEqual({
      id: "w1",
      code: "WP3",
      version: 2,
      status: "doing",
      progress: 10,
      event_id: 7,
    });
    expect(ack({ event_id: 7 }, { summary: "s" })).toEqual({ event_id: 7 });
  });

  it("counts a list result", () => {
    expect(ack([{ id: "a" }, { id: "b" }], {})).toEqual({ count: 2 });
  });
});

describe("slimConflict", () => {
  const row = { id: "w1", version: 4, status: "doing", progress: 10, title: "T", description_md: "long" };
  it("keeps the version and the patched keys that exist in current", () => {
    expect(slimConflict(row, { project_id: "p", id: "w1", progress: 50, expected_version: 2, nope: 1 })).toEqual({
      version: 4,
      progress: 10,
    });
    expect(slimConflict(row, { id: "p", patch: { status: "done", title: "x" } })).toEqual({ version: 4, status: "doing", title: "T" });
  });
  it("leaves code objects and null alone", () => {
    const gate = { code: "GATE_LOCKED", gates: [] };
    expect(slimConflict(gate, { progress: 1 })).toBe(gate);
    expect(slimConflict(null, {})).toBeNull();
  });
});

describe("MCP write acknowledgements", () => {
  it("upsert_workpackage acks by default and returns the row with return:full", async () => {
    const p = await ok("create_project", { title: "Ack project" });
    const created = await ok("upsert_workpackage", { project_id: p.id, code: "WP3", title: "W", description_md: "text" });
    expect(Object.keys(created).sort()).toEqual(["code", "id", "progress", "status", "version"]);
    const full = await ok("upsert_workpackage", { project_id: p.id, id: created.id, status: "doing", return: "full" });
    expect(full.title).toBe("W");
    expect(full.description_md).toBe("text");
    expect(full.effective_owner).toBeTruthy();
    const acked = await ok("upsert_workpackage", { project_id: p.id, id: created.id, progress: 30 });
    expect(acked).toMatchObject({ id: created.id, version: full.version + 1, progress: 30, status: "doing" });
    expect(acked.title).toBeUndefined();
  });

  it("the other write tools ack by default and return the row with return:full", async () => {
    const p = await ok("create_project", { title: "Ack tools" });
    expect(p.id).toBeTruthy();
    expect(p.version).toBe(1);
    expect(p.title).toBeUndefined();
    const pf = await ok("update_project", { id: p.id, patch: { summary: "s" }, return: "full" });
    expect(pf.summary).toBe("s");
    expect(pf.owner).toBeTruthy();
    const pu = await ok("update_project", { id: p.id, patch: { summary: "t" } });
    expect(pu).toEqual({ id: p.id, version: pf.version + 1, status: "active" });

    const b = await ok("link_branch", { project_id: p.id, repo: "r", name: "b" });
    expect(Object.keys(b).sort()).toEqual(["id", "status"]);
    expect((await ok("link_branch", { project_id: p.id, repo: "r", name: "b2", return: "full" })).repo).toBe("r");

    const tc = await ok("log_token_cost", { project_id: p.id, claude_tokens: 5 });
    expect(tc).toEqual({ id: expect.any(String) });
    expect((await ok("log_token_cost", { project_id: p.id, claude_tokens: 5, return: "full" })).claude_tokens).toBe(5);

    expect(await ok("set_scores", { project_id: p.id, scores: [{ criterion: "value", value: 5 }] })).toEqual({ count: 1 });
    const sf = await ok("set_scores", { project_id: p.id, scores: [{ criterion: "value", value: 6 }], return: "full" });
    expect(sf[0].criterion).toBe("value");

    const d = await ok("write_context", { owner_kind: "project", owner_id: p.id, title: "T", content_md: "hi", slug: "x" });
    expect(Object.keys(d).sort()).toEqual(["id", "status", "version"]);
    const mf = await ok("set_context_meta", { doc_id: d.id, pinned: true, return: "full" });
    expect(mf.pinned).toBe(1);
    expect(mf.slug).toBe("x");
    expect(await ok("set_context_meta", { doc_id: d.id, sort: 2 })).toMatchObject({ id: d.id });

    const m = await ok("upsert_milestone", { project_id: p.id, title: "M", due_date: "2030-01-01" });
    expect(Object.keys(m).sort()).toEqual(["id", "version"]);
    expect((await ok("upsert_milestone", { project_id: p.id, id: m.id, title: "M2", return: "full" })).title).toBe("M2");

    const r = await ok("upsert_risk", { project_id: p.id, title: "R", type: "risk", probability: 2, impact: 3 });
    expect(Object.keys(r).sort()).toEqual(["id", "status", "version"]);
    expect((await ok("upsert_risk", { project_id: p.id, id: r.id, impact: 4, return: "full" })).score).toBe(8);
  });

  it("log_progress acks the work package and the event; return:full gives the old shape", async () => {
    const p = await ok("create_project", { title: "Ack log" });
    const w = await ok("upsert_workpackage", { project_id: p.id, code: "WP3", title: "W" });
    const a = await ok("log_progress", { project_id: p.id, workpackage_id: w.id, progress: 40, summary: "s" });
    expect(a).toMatchObject({ id: w.id, code: "WP3", status: "doing", progress: 40 });
    expect(typeof a.event_id).toBe("number");
    expect(a.actual_start).toBeTruthy();
    const f = await ok("log_progress", { project_id: p.id, workpackage_id: w.id, summary: "s", return: "full" });
    expect(f.workpackage.title).toBe("W");
    expect(await ok("log_progress", { project_id: p.id, summary: "note" })).toEqual({ event_id: expect.any(Number) });
  });

  it("a stale expected_version returns a slim conflict with unchanged code and message", async () => {
    const p = await ok("create_project", { title: "Ack 409" });
    const w = await ok("upsert_workpackage", { project_id: p.id, code: "WP3", title: "W", description_md: "d" });
    await ok("upsert_workpackage", { project_id: p.id, id: w.id, progress: 10 });
    const r = await call("upsert_workpackage", { project_id: p.id, id: w.id, progress: 50, expected_version: w.version });
    expect(r.isError).toBe(true);
    const e = JSON.parse(r.content[0].text);
    expect(e.error).toBe("conflict");
    expect(e.message).toBe("version conflict");
    expect(e.current).toEqual({ version: w.version + 1, progress: 10 });
  });

  it("GATE_LOCKED conflicts keep their code object", async () => {
    const p = await ok("create_project", { title: "Ack gate" });
    const w = await ok("upsert_workpackage", { project_id: p.id, code: "WP3", title: "W" });
    const m = await ok("upsert_milestone", { project_id: p.id, title: "G", gate: true, due_date: "2030-01-01", unlocks: [w.id] });
    expect(m.id).toBeTruthy();
    const r = await call("log_progress", { project_id: p.id, workpackage_id: w.id, progress: 10, summary: "s" });
    expect(r.isError).toBe(true);
    const e = JSON.parse(r.content[0].text);
    expect(e.error).toBe("conflict");
    expect(e.current.code).toBe("GATE_LOCKED");
  });

  it("refuses an invalid return value without writing", async () => {
    const p = await ok("create_project", { title: "Ack bad return" });
    const r = await call("upsert_workpackage", { project_id: p.id, code: "WP3", title: "W", return: "everything" });
    expect(r.isError).toBe(true);
    const list = await ok("get_project", { id: p.id, view: "summary" });
    expect(JSON.stringify(list)).not.toContain('"WP3"');
  });

  it("set_context_meta acks the release stamp the server set", async () => {
    const p = await ok("create_project", { title: "Ack release" });
    const d = await ok("write_context", { owner_kind: "project", owner_id: p.id, title: "N", content_md: "x", slug: "notes" });
    await ok("set_context_meta", { doc_id: d.id, status: "draft" });
    const r = await ok("set_context_meta", { doc_id: d.id, status: "released" });
    expect(r.released_by).toBeTruthy();
    expect(r.released_at).toBeTruthy();
  });
});

/**
 * `return: "full"` must keep the result the write tools returned before acknowledgements existed (v0.3.5). The
 * data layer and the compaction are unchanged since then, so each expected object below is that result with the
 * values that differ per run replaced: ids, versions, timestamps and the dates the server sets.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
function normalise(value: unknown, ids: Record<string, string>): unknown {
  const pairs = Object.entries(ids).sort((a, b) => b[0].length - a[0].length);
  const walk = (x: unknown, key = ""): unknown => {
    if (Array.isArray(x)) return x.map((e) => walk(e, key));
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, e]) => [k, walk(e, k)]));
    if (typeof x === "number" && (key === "version" || key === "event_id")) return `<${key}>`;
    if (typeof x !== "string") return x;
    if (UUID_RE.test(x)) return "<uuid>";
    if (TS_RE.test(x)) return "<ts>";
    if (key === "actual_start" || key === "actual_end") return "<date>";
    return pairs.reduce((s, [from, to]) => s.split(from).join(to), x);
  };
  return walk(value);
}

describe("return:full keeps the v0.3.5 result of every acknowledging tool", () => {
  it("returns the complete row of each of the 11 tools", async () => {
    const ids: Record<string, string> = {};
    const full = async (name: string, args: Record<string, unknown>) => normalise(await ok(name, { ...args, return: "full" }), ids);
    const person = { person_id: "<uuid>", name: "user", initials: "U" };
    const projectRow = {
      id: "P",
      title: "Full project",
      status: "active",
      origin: "manual",
      progress_mode: "derived",
      version: "<version>",
      created_at: "<ts>",
      updated_at: "<ts>",
      owner_person_id: "<uuid>",
      schedule_rev: 0,
      closure_decision_pending: 0,
      last_progress_at: "<ts>",
      last_changed_at: "<ts>",
      stale: false,
      owner: person,
      progress_basis: { mode: "derived", done: 0, total: 0, weighted_percent: 0 },
      stalled_blocked: false,
      closure_due: false,
    };

    const created = await ok("create_project", { title: "Full project", return: "full" });
    ids[created.id] = "P";
    expect(normalise(created, ids)).toEqual(projectRow);

    const w = await ok("upsert_workpackage", { project_id: created.id, code: "WP3", title: "W", return: "full" });
    ids[w.id] = "W";
    expect(normalise(w, ids)).toEqual({
      id: "W",
      project_id: "P",
      title: "W",
      status: "todo",
      progress: 0,
      weight: 1,
      sort: 0,
      version: "<version>",
      created_at: "<ts>",
      updated_at: "<ts>",
      last_progress_at: "<ts>",
      last_changed_at: "<ts>",
      verification: "none",
      code: "WP3",
      effective_owner: person,
    });

    expect(await full("update_project", { id: created.id, patch: { summary: "s" } })).toEqual({
      ...projectRow,
      summary: "s",
      schedule_rev: 1,
      progress_basis: { mode: "derived", done: 0, total: 1, weighted_percent: 0 },
    });

    expect(await full("upsert_milestone", { project_id: created.id, title: "M", due_date: "2030-01-01", requires: [w.id] })).toEqual({
      id: "<uuid>",
      project_id: "P",
      title: "M",
      due_date: "2030-01-01",
      sort: 0,
      version: "<version>",
      created_at: "<ts>",
      updated_at: "<ts>",
      gate: false,
      done: false,
      requires: ["W"],
      requires_status: [{ id: "W", code: "WP3", title: "W", status: "todo", progress: 0 }],
      reached: false,
      decision_state: "none",
    });

    expect(await full("upsert_risk", { project_id: created.id, title: "R", type: "risk", probability: 2, impact: 3 })).toEqual({
      id: "P-risk-r",
      project_id: "P",
      type: "risk",
      title: "R",
      probability: 2,
      impact: 3,
      score: 6,
      status: "open",
      version: "<version>",
      created_at: "<ts>",
      updated_at: "<ts>",
    });

    expect(await full("log_progress", { project_id: created.id, workpackage_id: w.id, progress: 40, summary: "s" })).toEqual({
      event_id: "<event_id>",
      workpackage: {
        id: "W",
        project_id: "P",
        title: "W",
        status: "doing",
        progress: 40,
        weight: 1,
        sort: 0,
        version: "<version>",
        created_at: "<ts>",
        updated_at: "<ts>",
        last_progress_at: "<ts>",
        last_changed_at: "<ts>",
        verification: "none",
        code: "WP3",
        actual_start: "<date>",
      },
    });

    expect(await full("link_branch", { project_id: created.id, repo: "r", name: "b" })).toEqual({
      id: "<uuid>",
      project_id: "P",
      repo: "r",
      name: "b",
      kind: "branch",
      status: "open",
      last_activity: "<ts>",
    });

    expect(await full("set_scores", { project_id: created.id, scores: [{ criterion: "value", value: 5 }] })).toEqual([
      { id: "<uuid>", project_id: "P", criterion: "value", value: 5, recorded_at: "<ts>", actor: "mcp:Claude Test" },
    ]);

    expect(await full("log_token_cost", { project_id: created.id, claude_tokens: 5 })).toEqual({
      id: "<uuid>",
      project_id: "P",
      recorded_at: "<ts>",
      claude_tokens: 5,
      actor: "mcp:Claude Test",
    });

    const docRow = {
      id: "<uuid>",
      project_id: "P",
      owner_kind: "project",
      owner_id: "P",
      title: "T",
      slug: "x",
      source: "claude",
      pinned: 0,
      sort: 0,
      bytes: 2,
      version: "<version>",
      created_at: "<ts>",
      updated_at: "<ts>",
      created_by: "mcp:Claude Test",
      updated_by: "mcp:Claude Test",
      status: "released",
    };
    const doc = await ok("write_context", { owner_kind: "project", owner_id: created.id, title: "T", content_md: "hi", slug: "x", return: "full" });
    expect(normalise(doc, ids)).toEqual(docRow);
    expect(await full("set_context_meta", { doc_id: doc.id, pinned: true })).toEqual({ ...docRow, pinned: 1 });
  });
});
