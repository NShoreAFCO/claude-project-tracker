import { env } from "cloudflare:test";
import { testCaller } from "./helpers";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/data/projects";
import { upsertWorkpackage } from "../src/data/workpackages";
import { logProgress, listEvents } from "../src/data/logs";
import { deleteEntity } from "../src/data/entities";
import { listMilestones, lockedWpIds, upsertMilestone } from "../src/data/milestones";
import { ConflictError, ValidationError } from "../src/data/util";

const db = env.DB;
const A = testCaller({ actor: "user:test@example.com" });
let n = 0;

async function setup() {
  const p = await createProject(db, { title: `MS ${++n}` }, A);
  const w1 = await upsertWorkpackage(db, p.id, { title: "w1" }, A);
  const w2 = await upsertWorkpackage(db, p.id, { title: "w2" }, A);
  const next = await upsertWorkpackage(db, p.id, { title: "next" }, A);
  const m = await upsertMilestone(db, p.id, { title: "M1", requires: [w1.id, w2.id], unlocks: [next.id] }, A);
  return { p, w1, w2, next, m };
}
const get = async (projectId: string, id: string) => (await listMilestones(db, projectId)).find((m) => m.id === id)!;
const reachedEvents = async (projectId: string) =>
  (await listEvents(db, { project_id: projectId })).filter((e) => e.entity === "milestone" && e.action === "reached");

describe("milestones", () => {
  it("round-trips links and starts open and locking", async () => {
    const { p, w1, w2, next, m } = await setup();
    expect(m.requires.sort()).toEqual([w1.id, w2.id].sort());
    expect(m.unlocks).toEqual([next.id]);
    expect(m.done).toBe(false);
    expect(m.reached_at).toBeNull();
    expect(lockedWpIds(await listMilestones(db, p.id)).has(next.id)).toBe(true);
  });

  it("reached when all requires done", async () => {
    const { p, w1, w2, next, m } = await setup();
    await upsertWorkpackage(db, p.id, { id: w1.id, status: "done" }, A);
    expect((await get(p.id, m.id)).reached_at).toBeNull();
    await upsertWorkpackage(db, p.id, { id: w2.id, status: "done" }, A);
    const got = await get(p.id, m.id);
    expect(got.done).toBe(true);
    expect(got.reached_at).not.toBeNull();
    expect(await reachedEvents(p.id)).toHaveLength(1);
    expect(lockedWpIds(await listMilestones(db, p.id)).has(next.id)).toBe(false);
  });

  it("reached_at survives reopen", async () => {
    const { p, w1, w2, next, m } = await setup();
    await upsertWorkpackage(db, p.id, { id: w1.id, status: "done" }, A);
    await upsertWorkpackage(db, p.id, { id: w2.id, status: "done" }, A);
    const first = (await get(p.id, m.id)).reached_at;
    await upsertWorkpackage(db, p.id, { id: w2.id, status: "doing" }, A);
    const reopened = await get(p.id, m.id);
    expect(reopened.done).toBe(false);
    expect(reopened.reached_at).toBe(first);
    expect(lockedWpIds(await listMilestones(db, p.id)).has(next.id)).toBe(false);
    await upsertWorkpackage(db, p.id, { id: w2.id, status: "done" }, A);
    expect((await get(p.id, m.id)).reached_at).toBe(first);
    expect(await reachedEvents(p.id)).toHaveLength(1);
  });

  it("empty requires never reached", async () => {
    const p = await createProject(db, { title: `MS ${++n}` }, A);
    const w = await upsertWorkpackage(db, p.id, { title: "w" }, A);
    const m = await upsertMilestone(db, p.id, { title: "empty", unlocks: [w.id] }, A);
    await upsertWorkpackage(db, p.id, { id: w.id, status: "done" }, A);
    const got = await get(p.id, m.id);
    expect([got.done, got.reached_at]).toEqual([false, null]);
  });

  it("only-dropped requires never reached", async () => {
    const p = await createProject(db, { title: `MS ${++n}` }, A);
    const w = await upsertWorkpackage(db, p.id, { title: "w" }, A);
    const m = await upsertMilestone(db, p.id, { title: "dropped", requires: [w.id] }, A);
    await upsertWorkpackage(db, p.id, { id: w.id, status: "dropped" }, A);
    expect((await get(p.id, m.id)).reached_at).toBeNull();
  });

  it("dropped requires ignored", async () => {
    const { p, w1, w2, m } = await setup();
    await upsertWorkpackage(db, p.id, { id: w1.id, status: "dropped" }, A);
    await upsertWorkpackage(db, p.id, { id: w2.id, status: "done" }, A);
    expect((await get(p.id, m.id)).done).toBe(true);
  });

  it("log_progress reaches milestone", async () => {
    const { p, w1, w2, m } = await setup();
    await upsertWorkpackage(db, p.id, { id: w1.id, status: "done" }, A);
    await logProgress(db, { project_id: p.id, workpackage_id: w2.id, summary: "finished", progress: 100 }, A);
    expect((await get(p.id, m.id)).reached_at).not.toBeNull();
  });

  it("deleting the last open required WP reaches the milestone", async () => {
    const { p, w1, w2, m } = await setup();
    await upsertWorkpackage(db, p.id, { id: w1.id, status: "done" }, A);
    await deleteEntity(db, "workpackage", w2.id, A);
    const got = await get(p.id, m.id);
    expect(got.requires).toEqual([w1.id]);
    expect(got.reached_at).not.toBeNull();
  });

  it("an already satisfied milestone is reached on save", async () => {
    const p = await createProject(db, { title: `MS ${++n}` }, A);
    const w = await upsertWorkpackage(db, p.id, { title: "w", status: "done" }, A);
    const m = await upsertMilestone(db, p.id, { title: "late", requires: [w.id] }, A);
    expect(m.done).toBe(true);
    expect(m.reached_at).not.toBeNull();
  });

  it("cross-project link rejected", async () => {
    const { p } = await setup();
    const other = await createProject(db, { title: `Other ${++n}` }, A);
    const foreign = await upsertWorkpackage(db, other.id, { title: "f" }, A);
    await expect(upsertMilestone(db, p.id, { title: "x", requires: [foreign.id] }, A)).rejects.toBeInstanceOf(ValidationError);
    await expect(upsertMilestone(db, p.id, { title: "x", workpackage_id: foreign.id }, A)).rejects.toBeInstanceOf(ValidationError);
  });

  it("validates title and due_date", async () => {
    const { p } = await setup();
    await expect(upsertMilestone(db, p.id, { title: " " }, A)).rejects.toBeInstanceOf(ValidationError);
    await expect(upsertMilestone(db, p.id, { title: "x", due_date: "1.1.2027" }, A)).rejects.toBeInstanceOf(ValidationError);
  });

  it("update replaces links; stale expected_version → 409", async () => {
    const { p, w1, m } = await setup();
    const u = await upsertMilestone(db, p.id, { id: m.id, title: "M1b", requires: [w1.id], unlocks: [] }, A, 1);
    expect([u.title, u.requires, u.unlocks, u.version]).toEqual(["M1b", [w1.id], [], 2]);
    await expect(upsertMilestone(db, p.id, { id: m.id, title: "again" }, A, 1)).rejects.toBeInstanceOf(ConflictError);
  });

  it("delete milestone via deleteEntity", async () => {
    const { p, m } = await setup();
    await deleteEntity(db, "milestone", m.id, A);
    expect(await listMilestones(db, p.id)).toEqual([]);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM milestone_link WHERE milestone_id = ?").bind(m.id).first("n")).toBe(0);
  });
});
