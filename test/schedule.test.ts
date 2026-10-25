// F4 (release R2): schedule validation engine and stored issues.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { call, installTestKeys, testCaller, userJwt } from "./helpers";
import { gatedPlan } from "./fixtures/gated-plan";
import { createProject, updateProject } from "../src/data/projects";
import { upsertWorkpackage } from "../src/data/workpackages";
import { upsertMilestone } from "../src/data/milestones";
import { deleteEntity, restoreEntity } from "../src/data/entities";
import { scheduleIssues, type ScheduleIssue, type ScheduleSnapshot } from "../src/data/schedule";
import { TransitionError } from "../src/data/rules";
import { ValidationError } from "../src/data/util";
import { mcpApiHandler } from "../src/mcp/server";
import type { Env } from "../src/types";

const db = env.DB;
const A = testCaller({ actor: "test" });
let n = 0;
const uniq = (s: string) => `${s} ${++n}`;
const owned = (title: string, extra: Record<string, unknown> = {}) =>
  createProject(db, { title: uniq(title), owner: "Owner", ...extra }, A);
const wp = (id: string, start: string | null, end: string | null, o: Partial<ScheduleSnapshot["wps"][number]> = {}) => ({
  id,
  parent_id: null,
  start_date: start,
  end_date: end,
  depends_on: [],
  ...o,
});
const ms = (id: string, due: string | null, o: Partial<ScheduleSnapshot["milestones"][number]> = {}) => ({
  id,
  due_date: due,
  requires: [],
  unlocks: [],
  ...o,
});
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

const brief = (issues: ScheduleIssue[]) => issues.map((i) => [i.code, i.entity, i.entity_id, i.related_id]);
const stored = async (table: "workpackage" | "milestone", id: string): Promise<ScheduleIssue[]> => {
  const r = await db.prepare(`SELECT schedule_issues FROM ${table} WHERE id = ?`).bind(id).first<{ schedule_issues: string | null }>();
  return r?.schedule_issues ? JSON.parse(r.schedule_issues) : [];
};

describe("scheduleIssues (pure)", () => {
  it("DEP_START_BEFORE_PRED_END: successor starts before its predecessor ends", () => {
    const issues = scheduleIssues({
      wps: [wp("a", "2027-01-01", "2027-01-10"), wp("b", "2027-01-09", "2027-01-20", { depends_on: ["a"] })],
      milestones: [],
    });
    expect(brief(issues)).toEqual([["DEP_START_BEFORE_PRED_END", "workpackage", "b", "a"]]);
    expect(issues[0].message).toMatch(/2027-01-09/);
    expect(
      scheduleIssues({ wps: [wp("a", "2027-01-01", "2027-01-10"), wp("b", "2027-01-10", null, { depends_on: ["a"] })], milestones: [] }),
    ).toEqual([]);
  });
  it("START_BEFORE_GATE: WP starts before the due date of a milestone that unlocks it", () => {
    const issues = scheduleIssues({ wps: [wp("w", "2027-03-01", "2027-03-31")], milestones: [ms("g", "2027-03-05", { unlocks: ["w"] })] });
    expect(brief(issues)).toEqual([["START_BEFORE_GATE", "workpackage", "w", "g"]]);
    expect(scheduleIssues({ wps: [wp("w", "2027-03-05", null)], milestones: [ms("g", "2027-03-05", { unlocks: ["w"] })] })).toEqual([]);
  });
  it("CHILD_OUTSIDE_PARENT: child starts before or ends after its parent", () => {
    const early = scheduleIssues({
      wps: [wp("p", "2027-02-01", "2027-02-28"), wp("c", "2027-01-31", "2027-02-10", { parent_id: "p" })],
      milestones: [],
    });
    expect(brief(early)).toEqual([["CHILD_OUTSIDE_PARENT", "workpackage", "c", "p"]]);
    const late = scheduleIssues({
      wps: [wp("p", "2027-02-01", "2027-02-28"), wp("c", "2027-02-10", "2027-03-01", { parent_id: "p" })],
      milestones: [],
    });
    expect(brief(late)).toEqual([["CHILD_OUTSIDE_PARENT", "workpackage", "c", "p"]]);
    expect(
      scheduleIssues({
        wps: [wp("p", "2027-02-01", "2027-02-28"), wp("c", "2027-02-01", "2027-02-28", { parent_id: "p" })],
        milestones: [],
      }),
    ).toEqual([]);
  });
  it("MILESTONE_BEFORE_REQUIRED_END: milestone due before a required WP ends", () => {
    const issues = scheduleIssues({ wps: [wp("w", "2027-04-01", "2027-04-20")], milestones: [ms("m", "2027-04-19", { requires: ["w"] })] });
    expect(brief(issues)).toEqual([["MILESTONE_BEFORE_REQUIRED_END", "milestone", "m", "w"]]);
    expect(scheduleIssues({ wps: [wp("w", null, "2027-04-20")], milestones: [ms("m", "2027-04-20", { requires: ["w"] })] })).toEqual([]);
  });
  it("a WP without start_date produces no start-based issue; unknown ids are ignored", () => {
    const issues = scheduleIssues({
      wps: [
        wp("a", "2027-01-01", "2027-01-10"),
        wp("b", null, "2027-01-20", { depends_on: ["a", "ghost"] }),
        wp("p", "2027-01-05", "2027-01-31"),
      ],
      milestones: [ms("g", "2027-02-01", { unlocks: ["b", "ghost"], requires: ["ghost"] })],
    });
    expect(issues).toEqual([]);
  });
  it("r&d five conflicts: the gated plan has exactly five START_BEFORE_GATE pairs", () => {
    const plan = gatedPlan();
    const issues = scheduleIssues({ wps: plan.wps, milestones: plan.milestones });
    expect(issues.every((i) => i.code === "START_BEFORE_GATE")).toBe(true);
    expect(issues.map((i) => [i.entity_id, i.related_id]).sort()).toEqual([...plan.conflicts].sort());
  });
});

describe("schedule validation on writes", () => {
  it("unknown depends_on id is an error", async () => {
    const p = await owned("Deps unknown");
    const a = await upsertWorkpackage(db, p.id, { title: "a" }, A);
    const err = await upsertWorkpackage(db, p.id, { title: "b", depends_on: [a.id, "no-such-wp"] }, A).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/no-such-wp/);
    const self = await upsertWorkpackage(db, p.id, { id: a.id, depends_on: [a.id] }, A).catch((e) => e);
    expect(self).toBeInstanceOf(ValidationError);
  });
  it("write results carry warnings and entities store their issues", async () => {
    const p = await owned("Warn");
    const a = await upsertWorkpackage(db, p.id, { title: "a", start_date: "2027-01-01", end_date: "2027-01-10" }, A);
    const b = await upsertWorkpackage(db, p.id, { title: "b", start_date: "2027-01-05", depends_on: [a.id] }, A);
    expect(brief(b.warnings)).toEqual([["DEP_START_BEFORE_PRED_END", "workpackage", b.id, a.id]]);
    expect(brief(await stored("workpackage", b.id))).toEqual(brief(b.warnings));
    const m = await upsertMilestone(db, p.id, { title: "M", due_date: "2027-01-08", requires: [a.id] }, A);
    expect(brief(m.warnings)).toEqual([["MILESTONE_BEFORE_REQUIRED_END", "milestone", m.id, a.id]]);
    expect(brief(await stored("milestone", m.id))).toEqual(brief(m.warnings));
  });
  it("moving a predecessor updates the successor's stored issues", async () => {
    const p = await owned("Move pred");
    const a = await upsertWorkpackage(db, p.id, { title: "a", start_date: "2027-01-01", end_date: "2027-01-10" }, A);
    const b = await upsertWorkpackage(db, p.id, { title: "b", start_date: "2027-01-15", depends_on: [a.id] }, A);
    expect(b.warnings).toEqual([]);
    const moved = await upsertWorkpackage(db, p.id, { id: a.id, end_date: "2027-01-20" }, A);
    expect(brief(moved.warnings)).toEqual([["DEP_START_BEFORE_PRED_END", "workpackage", b.id, a.id]]);
    expect(brief(await stored("workpackage", b.id))).toEqual([["DEP_START_BEFORE_PRED_END", "workpackage", b.id, a.id]]);
    await upsertWorkpackage(db, p.id, { id: a.id, end_date: "2027-01-12" }, A);
    expect(await stored("workpackage", b.id)).toEqual([]);
  });
  it("deleting and restoring a predecessor recomputes the successor", async () => {
    const p = await owned("Trash pred");
    const a = await upsertWorkpackage(db, p.id, { title: "a", start_date: "2027-01-01", end_date: "2027-01-10" }, A);
    const b = await upsertWorkpackage(db, p.id, { title: "b", start_date: "2027-01-05", depends_on: [a.id] }, A);
    expect(await stored("workpackage", b.id)).toHaveLength(1);
    await deleteEntity(db, "workpackage", a.id, A);
    expect(await stored("workpackage", b.id)).toEqual([]);
    await restoreEntity(db, "workpackage", a.id, A);
    expect(await stored("workpackage", b.id)).toHaveLength(1);
  });
  it("strict mode turns warnings into 409", async () => {
    const p = await owned("Strict", { schedule_strict: true });
    const a = await upsertWorkpackage(db, p.id, { title: "a", start_date: "2027-01-01", end_date: "2027-01-10" }, A);
    const err = await upsertWorkpackage(db, p.id, { title: "b", start_date: "2027-01-05", depends_on: [a.id] }, A).catch((e) => e);
    expect(err).toBeInstanceOf(TransitionError);
    expect(err.status).toBe(409);
    expect(err.current.code).toBe("SCHEDULE_STRICT");
    expect(brief(err.current.issues)).toEqual([["DEP_START_BEFORE_PRED_END", "workpackage", expect.any(String), a.id]]);
    const left = await db.prepare("SELECT COUNT(*) AS n FROM workpackage WHERE project_id = ?").bind(p.id).first<{ n: number }>();
    expect(left!.n).toBe(1);
    // a consistent write passes; switching strict off lets the conflicting one through as a warning
    expect((await upsertWorkpackage(db, p.id, { title: "b", start_date: "2027-01-10", depends_on: [a.id] }, A)).warnings).toEqual([]);
    await updateProject(db, p.id, { schedule_strict: false }, A);
    const c = await upsertWorkpackage(db, p.id, { title: "c", start_date: "2027-01-05", depends_on: [a.id] }, A);
    expect(c.warnings).toHaveLength(1);
  });
  it("REST returns 409 with the issues for a strict project", async () => {
    const p = await owned("Strict REST", { schedule_strict: true });
    const a = await upsertWorkpackage(db, p.id, { title: "a", start_date: "2027-01-01", end_date: "2027-01-10" }, A);
    const res = await call("/api/workpackages", {
      method: "POST",
      body: JSON.stringify({ project_id: p.id, title: "b", start_date: "2027-01-02", depends_on: [a.id] }),
      jwt: await userJwt(),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { current: { code: string; issues: ScheduleIssue[] } };
    expect(body.current.code).toBe("SCHEDULE_STRICT");
    expect(body.current.issues).toHaveLength(1);
  });
  it("r&d five conflicts: loading the gated plan stores exactly the five START_BEFORE_GATE pairs", async () => {
    const p = await owned("Gated");
    const plan = gatedPlan(`${p.id}-`);
    for (const w of plan.wps) await upsertWorkpackage(db, p.id, { ...w }, A);
    for (const m of plan.milestones) await upsertMilestone(db, p.id, { ...m }, A);
    const pairs: Array<[string, string]> = [];
    for (const w of plan.wps) for (const i of await stored("workpackage", w.id)) pairs.push([i.entity_id, i.related_id]);
    for (const m of plan.milestones) expect(await stored("milestone", m.id)).toEqual([]);
    expect(pairs.sort()).toEqual([...plan.conflicts].sort());
  });
  it("MCP write results carry warnings; strict projects return the 409 details", async () => {
    const p = await owned("MCP warn");
    const a = await upsertWorkpackage(db, p.id, { title: "a", start_date: "2027-01-01", end_date: "2027-01-10" }, A);
    const r = await mcp("upsert_workpackage", { project_id: p.id, title: "b", start_date: "2027-01-03", depends_on: [a.id] });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text).warnings.map((i: ScheduleIssue) => i.code)).toEqual(["DEP_START_BEFORE_PRED_END"]);
    expect((await mcp("update_project", { id: p.id, patch: { schedule_strict: true } })).isError).toBeFalsy();
    const e = await mcp("upsert_workpackage", { project_id: p.id, title: "c", start_date: "2027-01-03", depends_on: [a.id] });
    expect(e.isError).toBe(true);
    expect(JSON.parse(e.content[0].text).current.code).toBe("SCHEDULE_STRICT");
  });
});
