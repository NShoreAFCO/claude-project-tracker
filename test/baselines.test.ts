// F4 (release R2): baselines, slip and critical path.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { call, installTestKeys, testCaller, userJwt } from "./helpers";
import { createProject, getProjectDetail } from "../src/data/projects";
import { upsertWorkpackage } from "../src/data/workpackages";
import { upsertMilestone } from "../src/data/milestones";
import { deleteEntity } from "../src/data/entities";
import { createBaseline } from "../src/data/baselines";
import { criticalPath } from "../src/data/critical-path";
import type { ScheduleSnapshot } from "../src/data/schedule";
import { ValidationError } from "../src/data/util";
import { mcpApiHandler } from "../src/mcp/server";
import type { Env } from "../src/types";

const db = env.DB;
const A = testCaller({ actor: "test" });
let n = 0;
const owned = (title: string) => createProject(db, { title: `${title} ${++n}`, owner: "Owner" }, A);
const wp = (id: string, start: string | null, end: string | null, depends_on: string[] = []) => ({
  id,
  parent_id: null,
  start_date: start,
  end_date: end,
  depends_on,
});
const ms = (id: string, requires: string[] = [], unlocks: string[] = []) => ({ id, due_date: null, requires, unlocks });
const sorted = (s: Set<string>) => [...s].sort();
type Node = { id: string; children: Node[] } & Record<string, unknown>;
const flat = (nodes: Node[]): Node[] => nodes.flatMap((x) => [x, ...flat(x.children)]);
beforeAll(installTestKeys);

async function mcp(name: string, args: Record<string, unknown>) {
  const ctx = createExecutionContext() as ExecutionContext & { props?: unknown };
  ctx.props = { email: "user@example.com", clientName: "Claude" };
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
  const line = text.startsWith("{")
    ? text
    : text
        .split("\n")
        .find((l) => l.startsWith("data: "))!
        .slice(6);
  return JSON.parse(line).result as { isError?: boolean; content: Array<{ text: string }> };
}

describe("criticalPath (pure)", () => {
  it("critical path on a diamond graph picks the longer branch", () => {
    const s: ScheduleSnapshot = {
      wps: [
        wp("a", "2027-01-01", "2027-01-05"),
        wp("b", "2027-01-05", "2027-01-15", ["a"]),
        wp("c", "2027-01-05", "2027-01-07", ["a"]),
        wp("d", "2027-01-15", "2027-01-20", ["b", "c"]),
      ],
      milestones: [],
    };
    expect(sorted(criticalPath(s))).toEqual(["a", "b", "d"]);
  });
  it("ties keep every tied path", () => {
    const s: ScheduleSnapshot = {
      wps: [
        wp("a", "2027-01-01", "2027-01-05"),
        wp("b", "2027-01-05", "2027-01-15", ["a"]),
        wp("c", "2027-01-05", "2027-01-15", ["a"]),
        wp("d", "2027-01-15", "2027-01-20", ["b", "c"]),
        wp("x", "2027-01-01", "2027-01-02"),
      ],
      milestones: [],
    };
    expect(sorted(criticalPath(s))).toEqual(["a", "b", "c", "d"]);
  });
  it("milestone requires → unlocks edges join the path", () => {
    const s: ScheduleSnapshot = {
      wps: [wp("a", "2027-01-01", "2027-01-10"), wp("b", "2027-01-10", "2027-01-20"), wp("x", "2027-01-01", "2027-01-15")],
      milestones: [ms("m", ["a"], ["b"])],
    };
    expect(sorted(criticalPath(s))).toEqual(["a", "b", "m"]);
  });
  it("cycle in depends_on does not hang (returns empty set + ValidationError on write)", async () => {
    const s: ScheduleSnapshot = {
      wps: [wp("a", "2027-01-01", "2027-01-10", ["b"]), wp("b", "2027-01-10", "2027-01-20", ["a"])],
      milestones: [],
    };
    expect(criticalPath(s).size).toBe(0);
    const p = await owned("Cycle");
    const a = await upsertWorkpackage(db, p.id, { title: "a" }, A);
    const b = await upsertWorkpackage(db, p.id, { title: "b", depends_on: [a.id] }, A);
    const c = await upsertWorkpackage(db, p.id, { title: "c", depends_on: [b.id] }, A);
    const err = await upsertWorkpackage(db, p.id, { id: a.id, depends_on: [c.id] }, A).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/cycle/);
    const row = await db.prepare("SELECT depends_on FROM workpackage WHERE id = ?").bind(a.id).first<{ depends_on: string | null }>();
    expect(row?.depends_on ?? null).toBeNull();
  });
  it("an undated plan has no critical path", () => {
    expect(criticalPath({ wps: [wp("a", null, null), wp("b", null, null, ["a"])], milestones: [] }).size).toBe(0);
  });
});

describe("baselines", () => {
  it("baseline snapshots all WP and milestone dates", async () => {
    const p = await owned("Baseline");
    const a = await upsertWorkpackage(db, p.id, { title: "a", start_date: "2027-01-01", end_date: "2027-01-10" }, A);
    const b = await upsertWorkpackage(db, p.id, { title: "b", parent_id: a.id }, A);
    const gone = await upsertWorkpackage(db, p.id, { title: "gone", start_date: "2027-02-01", end_date: "2027-02-02" }, A);
    await deleteEntity(db, "workpackage", gone.id, A);
    const m = await upsertMilestone(db, p.id, { title: "M1", due_date: "2027-01-12" }, A);
    const out = await createBaseline(db, p.id, "  Plan approved ", A);
    expect(out).toMatchObject({ label: "Plan approved", items: 3 });
    const rows = (
      await db
        .prepare("SELECT entity, entity_id, start_date, end_date FROM baseline_item WHERE baseline_id = ? ORDER BY entity, entity_id")
        .bind(out.id)
        .all()
    ).results;
    expect(rows).toEqual(
      [
        { entity: "milestone", entity_id: m.id, start_date: null, end_date: "2027-01-12" },
        { entity: "workpackage", entity_id: a.id, start_date: "2027-01-01", end_date: "2027-01-10" },
        { entity: "workpackage", entity_id: b.id, start_date: null, end_date: null },
      ].sort((x, y) => (x.entity + x.entity_id < y.entity + y.entity_id ? -1 : 1)),
    );
    const base = await db.prepare("SELECT decision_id, created_by FROM baseline WHERE id = ?").bind(out.id).first();
    expect(base).toEqual({ decision_id: null, created_by: "test" });
    const ev = await db.prepare("SELECT action FROM event WHERE entity = 'baseline' AND entity_id = ?").bind(out.id).first();
    expect(ev).toEqual({ action: "create" });

    const auto = await createBaseline(db, p.id, "Gate M1: go", A, { decision_id: "dec-1" });
    expect((await db.prepare("SELECT decision_id FROM baseline WHERE id = ?").bind(auto.id).first())?.decision_id).toBe("dec-1");

    expect(await createBaseline(db, p.id, " ", A).catch((e) => e)).toBeInstanceOf(ValidationError);
    expect(await createBaseline(db, "no-such-project", "x", A).catch((e) => e.constructor.name)).toBe("NotFoundError");
  });

  it("slip_days = end - baseline_end in days", async () => {
    const p = await owned("Slip");
    const a = await upsertWorkpackage(db, p.id, { title: "a", start_date: "2027-01-01", end_date: "2027-01-10" }, A);
    const b = await upsertWorkpackage(db, p.id, { title: "b", start_date: "2027-01-10", end_date: "2027-02-10", depends_on: [a.id] }, A);
    const m = await upsertMilestone(db, p.id, { title: "M", due_date: "2027-02-10", requires: [b.id] }, A);

    let d = await getProjectDetail(db, p.id);
    expect(d.baseline).toBeNull();
    expect(flat(d.workpackages as unknown as Node[]).find((w) => w.id === a.id)).toMatchObject({ baseline_end: null, slip_days: null });

    await createBaseline(db, p.id, "old", A);
    await upsertWorkpackage(db, p.id, { id: a.id, end_date: "2027-01-08" }, A);
    await createBaseline(db, p.id, "latest", A);
    await upsertWorkpackage(db, p.id, { id: a.id, end_date: "2027-01-10" }, A);
    await upsertWorkpackage(db, p.id, { id: b.id, end_date: "2027-03-02" }, A);
    await upsertMilestone(db, p.id, { id: m.id, due_date: "2027-03-01" }, A);
    const late = await upsertWorkpackage(db, p.id, { title: "after baseline", start_date: "2027-01-01", end_date: "2027-01-02" }, A);

    d = await getProjectDetail(db, p.id);
    expect(d.baseline).toMatchObject({ label: "latest" });
    const wps = flat(d.workpackages as unknown as Node[]);
    expect(wps.find((w) => w.id === a.id)).toMatchObject({
      baseline_start: "2027-01-01",
      baseline_end: "2027-01-08",
      slip_days: 2,
      critical: true,
    });
    expect(wps.find((w) => w.id === b.id)).toMatchObject({ baseline_end: "2027-02-10", slip_days: 20, critical: true });
    expect(wps.find((w) => w.id === late.id)).toMatchObject({ baseline_start: null, baseline_end: null, slip_days: null, critical: false });
    expect(d.milestones.find((x) => x.id === m.id)).toMatchObject({
      baseline_start: null,
      baseline_end: "2027-02-10",
      slip_days: 19,
      critical: true,
    });

    // pulled in: negative slip
    await upsertWorkpackage(db, p.id, { id: a.id, end_date: "2027-01-05" }, A);
    d = await getProjectDetail(db, p.id);
    expect(flat(d.workpackages as unknown as Node[]).find((w) => w.id === a.id)?.slip_days).toBe(-3);
  });

  it("MCP create_baseline and REST POST /api/projects/:id/baselines", async () => {
    const p = await owned("Api");
    await upsertWorkpackage(db, p.id, { title: "a", start_date: "2027-01-01", end_date: "2027-01-10" }, A);
    const jwt = await userJwt();
    const res = await call(`/api/projects/${p.id}/baselines`, {
      method: "POST",
      jwt,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Kick-off" }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ label: "Kick-off", items: 1 });
    const bad = await call(`/api/projects/${p.id}/baselines`, {
      method: "POST",
      jwt,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
    const detail = (await (await call(`/api/projects/${p.id}`, { jwt })).json()) as { baseline: { label: string } };
    expect(detail.baseline.label).toBe("Kick-off");

    const r = await mcp("create_baseline", { project_id: p.id, label: "Agent baseline" });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toMatchObject({ label: "Agent baseline", items: 1 });
    expect((await getProjectDetail(db, p.id)).baseline?.label).toBe("Agent baseline");
  });
});
