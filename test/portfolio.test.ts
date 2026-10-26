// F9 (release R4.2): portfolio summary, upcoming deadlines, my work packages.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { call, installTestKeys, testCaller, userJwt } from "./helpers";
import { createProject } from "../src/data/projects";
import { upsertWorkpackage } from "../src/data/workpackages";
import { upsertMilestone } from "../src/data/milestones";
import { upsertRisk } from "../src/data/risks";
import { deleteEntity } from "../src/data/entities";
import { upsertPerson } from "../src/data/persons";
import { mineWorkpackages, summary, upcomingWorkpackages } from "../src/data/portfolio";

const db = env.DB;
const A = testCaller({ actor: "test" });
let n = 0;
const uniq = (s: string) => `${s} ${++n}`;
const TODAY = "2026-10-26";
const proj = async (extra: Record<string, unknown> = {}) =>
  (await createProject(db, { title: uniq("P"), owner: "Owner", target_date: "2027-01-01", ...extra }, A)).id;
const wp = async (pid: string, extra: Record<string, unknown> = {}) =>
  (await upsertWorkpackage(db, pid, { title: uniq("W"), ...extra }, A)).id;
const sql = (q: string, ...b: unknown[]) =>
  db
    .prepare(q)
    .bind(...b)
    .run();

beforeAll(installTestKeys);

describe("portfolio summary", () => {
  it("by_status counts live projects per status", async () => {
    const before = (await summary(db, TODAY)).by_status;
    await proj({ status: "idea" });
    await proj({ status: "idea" });
    const gone = await proj({ status: "idea" });
    await deleteEntity(db, "project", gone, A);
    const after = (await summary(db, TODAY)).by_status;
    expect(after.idea - (before.idea ?? 0)).toBe(2);
  });

  it("overdue_milestones lists projects with an unreached milestone due before today", async () => {
    const p = await proj();
    const ok = await proj();
    await upsertMilestone(db, p, { title: "late", due_date: "2026-10-25" }, A);
    await upsertMilestone(db, ok, { title: "today", due_date: TODAY }, A);
    const s = await summary(db, TODAY);
    expect(s.overdue_milestones.project_ids).toContain(p);
    expect(s.overdue_milestones.project_ids).not.toContain(ok);
    expect(s.overdue_milestones.count).toBe(s.overdue_milestones.project_ids.length);
  });

  it("gates_awaiting_decision counts reached gates without a decision", async () => {
    const p = await proj();
    const q = await proj();
    const g = await upsertMilestone(db, p, { title: "gate", gate: true }, A);
    await upsertMilestone(db, q, { title: "gate not reached", gate: true }, A);
    await sql("UPDATE milestone SET reached_at = ? WHERE id = ?", "2026-10-20T10:00:00.000Z", g.id);
    const s = await summary(db, TODAY);
    expect(s.gates_awaiting_decision.project_ids).toContain(p);
    expect(s.gates_awaiting_decision.project_ids).not.toContain(q);
  });

  it("blocked lists projects with a blocked work package", async () => {
    const p = await proj();
    const q = await proj();
    await wp(p, { status: "blocked", blocked_by: "supplier" });
    await wp(q);
    const s = await summary(db, TODAY);
    expect(s.blocked.project_ids).toContain(p);
    expect(s.blocked.project_ids).not.toContain(q);
  });

  it("stale flips after stale_days of UTC date math", async () => {
    const p = await proj({ status: "active" });
    await sql(
      "UPDATE project SET last_progress_at = ?, created_at = ? WHERE id = ?",
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T00:00:00.000Z",
      p,
    );
    const q = await proj({ status: "active" });
    await sql("UPDATE project SET last_progress_at = ? WHERE id = ?", "2026-10-25T00:00:00.000Z", q);
    const s = await summary(db, TODAY);
    expect(s.stale.project_ids).toContain(p);
    expect(s.stale.project_ids).not.toContain(q);
  });

  it("missing_target_date and missing_owner", async () => {
    const a = await proj({ target_date: null });
    const b = await proj();
    await sql("UPDATE project SET owner_person_id = NULL, owner_text = NULL WHERE id = ?", b);
    const c = await proj();
    const s = await summary(db, TODAY);
    expect(s.missing_target_date.project_ids).toContain(a);
    expect(s.missing_target_date.project_ids).not.toContain(c);
    expect(s.missing_owner.project_ids).toContain(b);
    expect(s.missing_owner.project_ids).not.toContain(c);
  });

  it("schedule_issues counts stored issues, not NULL and not []", async () => {
    const p = await proj();
    const q = await proj();
    const r = await proj();
    const w1 = await wp(p);
    const w2 = await wp(q);
    await wp(r);
    await sql("UPDATE workpackage SET schedule_issues = ? WHERE id = ?", '[{"code":"x"}]', w1);
    await sql("UPDATE workpackage SET schedule_issues = '[]' WHERE id = ?", w2);
    await sql("UPDATE workpackage SET schedule_issues = NULL WHERE project_id = ?", r);
    const s = await summary(db, TODAY);
    expect(s.schedule_issues.project_ids).toContain(p);
    expect(s.schedule_issues.project_ids).not.toContain(q);
    expect(s.schedule_issues.project_ids).not.toContain(r);
  });

  it("open_high_risks uses score >= 15 on open risks", async () => {
    const p = await proj();
    const q = await proj();
    const r = await proj();
    await upsertRisk(db, p, { title: "high", probability: 5, impact: 3 }, A);
    await upsertRisk(db, q, { title: "low", probability: 2, impact: 2 }, A);
    const hi = await upsertRisk(db, r, { title: "closed high", probability: 5, impact: 5 }, A);
    await sql("UPDATE risk SET status = 'closed' WHERE id = ?", hi.id);
    const s = await summary(db, TODAY);
    expect(s.open_high_risks.project_ids).toContain(p);
    expect(s.open_high_risks.project_ids).not.toContain(q);
    expect(s.open_high_risks.project_ids).not.toContain(r);
  });

  it("deleted rows excluded, including children of a trashed project", async () => {
    const p = await proj({ target_date: null });
    await wp(p, { status: "blocked", blocked_by: "x" });
    await upsertMilestone(db, p, { title: "late", due_date: "2020-01-01" }, A);
    await upsertRisk(db, p, { title: "high", probability: 5, impact: 5 }, A);
    const s1 = await summary(db, TODAY);
    for (const k of ["blocked", "overdue_milestones", "open_high_risks", "missing_target_date"] as const)
      expect(s1[k].project_ids).toContain(p);
    await deleteEntity(db, "project", p, A);
    // simulate children that kept a NULL deleted_at: only the parent filter can exclude them
    await sql("UPDATE workpackage SET deleted_at = NULL WHERE project_id = ?", p);
    await sql("UPDATE milestone SET deleted_at = NULL WHERE project_id = ?", p);
    await sql("UPDATE risk SET deleted_at = NULL WHERE project_id = ?", p);
    const s2 = await summary(db, TODAY);
    for (const k of Object.keys(s2) as Array<keyof typeof s2>) {
      if (k === "by_status") continue;
      expect(s2[k].project_ids).not.toContain(p);
    }
  });

  it("a deleted work package does not count as blocked", async () => {
    const p = await proj();
    const w = await wp(p, { status: "blocked", blocked_by: "x" });
    await deleteEntity(db, "workpackage", w, A);
    expect((await summary(db, TODAY)).blocked.project_ids).not.toContain(p);
  });
});

describe("upcoming work packages", () => {
  it("upcoming sorted nearest first and filterable", async () => {
    const p = await proj();
    const q = await proj();
    const late = await wp(p, { end_date: "2026-12-01" });
    const soon = await wp(p, { end_date: "2026-11-01" });
    const other = await wp(q, { end_date: "2026-11-15" });
    const done = await wp(p, { end_date: "2026-10-30", status: "done" });
    const none = await wp(p);
    const del = await wp(p, { end_date: "2026-10-28" });
    await deleteEntity(db, "workpackage", del, A);
    const all = await upcomingWorkpackages(db, {});
    const ids = all.map((w) => w.id);
    expect(ids.indexOf(soon)).toBeLessThan(ids.indexOf(other));
    expect(ids.indexOf(other)).toBeLessThan(ids.indexOf(late));
    for (const x of [done, none, del]) expect(ids).not.toContain(x);
    const f = await upcomingWorkpackages(db, { project_id: p });
    expect(f.map((w) => w.id)).toEqual([soon, late]);
    expect(f[0]).toMatchObject({ project_id: p, end_date: "2026-11-01" });
    expect(await upcomingWorkpackages(db, { limit: 1 })).toHaveLength(1);
  });

  it("works over REST", async () => {
    const p = await proj();
    await wp(p, { end_date: "2026-11-01" });
    const res = await call(`/api/workpackages/upcoming?project_id=${p}&limit=5`, { jwt: await userJwt() });
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(1);
    const sum = await call("/api/portfolio/summary", { jwt: await userJwt() });
    expect(sum.status).toBe(200);
    expect(Object.keys((await sum.json()) as object)).toContain("open_high_risks");
  });
});

describe("my work packages", () => {
  it("mine includes inherited ownership unless assigned_only", async () => {
    const me = await upsertPerson(db, { name: uniq("Me"), email: `me${n}@example.com` }, A);
    const other = await upsertPerson(db, { name: uniq("Other"), email: `ot${n}@example.com` }, A);
    const p1 = await proj({ owner: me.id });
    const p2 = await proj({ owner: other.id });
    const inherited = await wp(p1);
    const explicit = await wp(p2, { owner: me.id });
    const textOwned = await wp(p1, { owner: "Somebody Else" });
    const foreign = await wp(p2);
    const finished = await wp(p1, { status: "done" });
    const trashed = await wp(p1);
    await deleteEntity(db, "workpackage", trashed, A);
    const all = (await mineWorkpackages(db, me.id, {})).map((w) => w.id);
    expect(all).toEqual(expect.arrayContaining([inherited, explicit]));
    for (const x of [textOwned, foreign, finished, trashed]) expect(all).not.toContain(x);
    const only = (await mineWorkpackages(db, me.id, { assigned_only: true })).map((w) => w.id);
    expect(only).toEqual([explicit]);
    expect(await mineWorkpackages(db, null, {})).toEqual([]);
  });

  it("mine sorts by in_progress, start and end", async () => {
    const me = await upsertPerson(db, { name: uniq("Me"), email: `me${n}@example.com` }, A);
    const p = await proj({ owner: me.id });
    const a = await wp(p, { start_date: "2026-11-05", end_date: "2026-11-09" });
    const b = await wp(p, { start_date: "2026-11-01", end_date: "2026-11-20", status: "doing" });
    const ids = async (sort: string) => (await mineWorkpackages(db, me.id, { sort: sort as any })).map((w) => w.id);
    expect(await ids("in_progress")).toEqual([b, a]);
    expect(await ids("start")).toEqual([b, a]);
    expect(await ids("end")).toEqual([a, b]);
  });
});
