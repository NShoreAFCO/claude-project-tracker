import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { testCaller } from "./helpers";
import { createProject, getProjectDetail, updateProject } from "../src/data/projects";
import { upsertWorkpackage } from "../src/data/workpackages";
import { logProgress } from "../src/data/logs";
import { ValidationError } from "../src/data/util";
const db = env.DB;
const A = testCaller({ actor: "test" });
let n = 0;
const proj = () => createProject(db, { title: `Basis project ${++n}`, owner: "Owner" }, A);

describe("progress basis and effort", () => {
  it("basis reports done/total and weighted percent", async () => {
    const p = await proj();
    await upsertWorkpackage(db, p.id, { id: `b${n}-a`, title: "A", status: "done", weight: 3 }, A);
    await upsertWorkpackage(db, p.id, { id: `b${n}-b`, title: "B", weight: 1 }, A);
    await upsertWorkpackage(db, p.id, { id: `b${n}-c`, title: "C", status: "dropped", drop_reason: "no", weight: 5 }, A);
    const d = await getProjectDetail(db, p.id);
    expect(d.project.progress_basis).toEqual({ mode: "derived", done: 1, total: 2, weighted_percent: 75, reason: null });
    const m = await updateProject(
      db,
      p.id,
      { progress_mode: "manual", progress_manual: 40, progress_manual_reason: "estimate by lead" },
      A,
    );
    expect(m.progress_basis).toEqual({ mode: "manual", done: 1, total: 2, weighted_percent: 75, reason: "estimate by lead" });
  });

  it("manual mode without reason → 400", async () => {
    const p = await proj();
    await expect(updateProject(db, p.id, { progress_mode: "manual", progress_manual: 10 }, A)).rejects.toBeInstanceOf(ValidationError);
    await expect(
      updateProject(db, p.id, { progress_mode: "manual", progress_manual: 10, progress_manual_reason: "  " }, A),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createProject(db, { title: "Manual new", owner: "O", progress_mode: "manual", progress_manual: 5 }, A),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("legacy manual project without reason stays editable on unrelated fields", async () => {
    const p = await proj();
    await db.prepare("UPDATE project SET progress_mode = 'manual', progress_manual = 30 WHERE id = ?").bind(p.id).run();
    const u = await updateProject(db, p.id, { summary: "still fine" }, A);
    expect(u.summary).toBe("still fine");
    expect(u.progress_basis.reason).toBeNull();
    await expect(updateProject(db, p.id, { progress_manual: 50 }, A)).rejects.toBeInstanceOf(ValidationError);
    const ok = await updateProject(db, p.id, { progress_manual: 50, progress_manual_reason: "now documented" }, A);
    expect(ok.progress_manual).toBe(50);
  });

  it("log_progress effort_pd accumulates", async () => {
    const p = await proj();
    const wp = await upsertWorkpackage(db, p.id, { id: `e${n}-a`, title: "E", effort_planned_pd: 5 }, A);
    expect(wp.effort_planned_pd).toBe(5);
    expect(wp.effort_actual_pd).toBeNull();
    await logProgress(db, { project_id: p.id, workpackage_id: wp.id, summary: "day one", effort_pd: 1.5 }, A);
    const r = await logProgress(db, { project_id: p.id, workpackage_id: wp.id, summary: "day two", effort_pd: 0.5, progress: 20 }, A);
    expect(r.workpackage?.effort_actual_pd).toBe(2);
    expect(r.workpackage?.progress).toBe(20);
    await expect(logProgress(db, { project_id: p.id, workpackage_id: wp.id, summary: "x", effort_pd: -1 }, A)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(logProgress(db, { project_id: p.id, summary: "x", effort_pd: 1 }, A)).rejects.toBeInstanceOf(ValidationError);
  });

  it("progress 100 + status done in one WP write succeeds (mark complete path)", async () => {
    const p = await proj();
    const wp = await upsertWorkpackage(db, p.id, { id: `m${n}-a`, title: "M" }, A);
    const done = await upsertWorkpackage(db, p.id, { id: wp.id, progress: 100, status: "done" }, A);
    expect(done.status).toBe("done");
    expect(done.progress).toBe(100);
  });
});
