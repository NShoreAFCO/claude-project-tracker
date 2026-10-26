import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { testCaller } from "./helpers";
import { createProject, getProjectDetail, listProjects, updateProject } from "../src/data/projects";
import { upsertWorkpackage } from "../src/data/workpackages";
import { logProgress } from "../src/data/logs";
import { isStale, staleDaysFor, utcDayNumber } from "../src/data/activity";
import { POLICY } from "../src/policy";
import { appendContext } from "../src/data/context-write";
import { setAfterScheduleReadForTesting } from "../src/data/schedule";
import { CONTEXT_DOC_MAX_BYTES } from "../src/types";
import { ConflictError, TooLargeError } from "../src/data/util";
import { INSTANCE } from "../src/generated/instance";
const db = env.DB;
// testCaller defaults to channel "system"; activity tracking needs a real channel.
const U = testCaller({ actor: "user:user@example.com", channel: "dashboard" });
const SYS = testCaller({ actor: "system", channel: "system" });
let n = 0;
const OLD = "2000-01-01T00:00:00.000Z";
const proj = async (by = U) => createProject(db, { title: `Activity ${++n}`, owner: "Owner", status: "active" }, by);
const setOld = async (id: string) => {
  await db.prepare("UPDATE project SET last_progress_at = ?, last_changed_at = ? WHERE id = ?").bind(OLD, OLD, id).run();
  await db.prepare("UPDATE workpackage SET last_progress_at = ?, last_changed_at = ? WHERE project_id = ?").bind(OLD, OLD, id).run();
};
const row = (table: string, id: string) =>
  db
    .prepare(`SELECT last_progress_at, last_changed_at FROM ${table} WHERE id = ?`)
    .bind(id)
    .first<{ last_progress_at: string | null; last_changed_at: string | null }>();

describe("activity timestamps", () => {
  it("log_progress updates last_progress_at; title edit only last_changed_at", async () => {
    const p = await proj();
    const wp = await upsertWorkpackage(db, p.id, { id: `act${n}-a`, title: "A" }, U);
    await setOld(p.id);
    await updateProject(db, p.id, { title: "Renamed" }, U);
    let r = await row("project", p.id);
    expect(r!.last_progress_at).toBe(OLD);
    expect(r!.last_changed_at).not.toBe(OLD);
    await upsertWorkpackage(db, p.id, { id: wp.id, title: "A2" }, U);
    r = await row("workpackage", wp.id);
    expect(r!.last_progress_at).toBe(OLD);
    expect(r!.last_changed_at).not.toBe(OLD);
    await setOld(p.id);
    await logProgress(db, { project_id: p.id, summary: "did things", workpackage_id: wp.id, progress: 30 }, U);
    for (const [t, id] of [
      ["project", p.id],
      ["workpackage", wp.id],
    ] as const) {
      const x = await row(t, id);
      expect(x!.last_progress_at).not.toBe(OLD);
      expect(x!.last_changed_at).not.toBe(OLD);
    }
  });

  it("a WP status change moves the project's last_progress_at", async () => {
    const p = await proj();
    const wp = await upsertWorkpackage(db, p.id, { id: `act${n}-s`, title: "S" }, U);
    await setOld(p.id);
    await upsertWorkpackage(db, p.id, { id: wp.id, status: "doing" }, U);
    expect((await row("workpackage", wp.id))!.last_progress_at).not.toBe(OLD);
    expect((await row("project", p.id))!.last_progress_at).not.toBe(OLD);
  });

  it("system writes update neither", async () => {
    const p = await proj();
    const wp = await upsertWorkpackage(db, p.id, { id: `act${n}-y`, title: "Y" }, U);
    await setOld(p.id);
    await updateProject(db, p.id, { title: "By system", status: "on_hold" }, SYS);
    await upsertWorkpackage(db, p.id, { id: wp.id, title: "Y2", status: "doing" }, SYS);
    await logProgress(db, { project_id: p.id, summary: "migrated", workpackage_id: wp.id, progress: 50 }, SYS);
    for (const [t, id] of [
      ["project", p.id],
      ["workpackage", wp.id],
    ] as const) {
      expect(await row(t, id)).toEqual({ last_progress_at: OLD, last_changed_at: OLD });
    }
  });

  it("card last_activity is last_progress_at and carries stale", async () => {
    const p = await proj();
    await setOld(p.id);
    const card = (await listProjects(db)).find((c) => c.id === p.id)!;
    expect(card.last_activity).toBe(OLD);
    expect(card.stale).toBe(true);
    expect((await getProjectDetail(db, p.id)).project.stale).toBe(true);
    await logProgress(db, { project_id: p.id, summary: "fresh" }, U);
    expect((await listProjects(db)).find((c) => c.id === p.id)!.stale).toBe(false);
  });
});

describe("refused writes", () => {
  it("refused write (version conflict) leaves project timestamps unchanged", async () => {
    const p = await proj();
    const wp = await upsertWorkpackage(db, p.id, { id: `act${n}-r`, title: "R" }, U);
    await setOld(p.id);
    // A concurrent writer bumps the version between this write's reads and its batch.
    setAfterScheduleReadForTesting(async () => {
      await db.prepare("UPDATE workpackage SET version = version + 1 WHERE id = ?").bind(wp.id).run();
    });
    try {
      await expect(upsertWorkpackage(db, p.id, { id: wp.id, status: "doing" }, U)).rejects.toBeInstanceOf(ConflictError);
    } finally {
      setAfterScheduleReadForTesting(null);
    }
    expect(await row("project", p.id)).toEqual({ last_progress_at: OLD, last_changed_at: OLD });
    expect(await row("workpackage", wp.id)).toEqual({ last_progress_at: OLD, last_changed_at: OLD });
  });

  it("refused context append (too large) leaves project timestamps unchanged", async () => {
    const p = await proj();
    await appendContext(db, { owner_kind: "project", owner_id: p.id, slug: "notes", text: "first" }, U);
    await setOld(p.id);
    await db
      .prepare("UPDATE context_doc SET bytes = ? WHERE owner_id = ? AND slug = 'notes'")
      .bind(CONTEXT_DOC_MAX_BYTES - 1, p.id)
      .run();
    await expect(
      appendContext(db, { owner_kind: "project", owner_id: p.id, slug: "notes", text: "does not fit" }, U),
    ).rejects.toBeInstanceOf(TooLargeError);
    expect(await row("project", p.id)).toEqual({ last_progress_at: OLD, last_changed_at: OLD });
  });
});

describe("staleness", () => {
  it("malformed or SQLite-style timestamps never throw", () => {
    const now = new Date("2026-10-20T00:00:00Z");
    const base = { status: "active", created_at: "2026-10-01 08:30:00" };
    expect(isStale({ ...base, last_progress_at: null }, 14, now)).toBe(true); // space separator accepted, UTC
    expect(isStale({ ...base, last_progress_at: null }, 30, now)).toBe(false);
    expect(isStale({ ...base, last_progress_at: "garbage" }, 14, now)).toBe(true); // falls back to created_at
    expect(isStale({ status: "active", created_at: "garbage", last_progress_at: "also bad" }, 14, now)).toBe(false);
    expect(utcDayNumber("2026-10-01 23:30:00")).toBe(utcDayNumber("2026-10-01"));
  });
  const at = (iso: string) => new Date(iso);
  const p = { status: "active", last_progress_at: "2026-10-01T23:59:59.000Z", created_at: "2026-09-01T00:00:00.000Z" };
  it("stale flips exactly after stale_days (UTC date math)", () => {
    expect(isStale(p, 14, at("2026-10-15T23:59:59.999Z"))).toBe(false); // day D+14, end of day
    expect(isStale(p, 14, at("2026-10-16T00:00:00.000Z"))).toBe(true); // D+15 00:00 UTC
    expect(isStale({ ...p, last_progress_at: "2026-10-01" }, 14, at("2026-10-15T12:00:00Z"))).toBe(false); // date-only
    expect(isStale({ ...p, last_progress_at: "2026-10-01" }, 14, at("2026-10-16T00:00:00Z"))).toBe(true);
    expect(isStale({ ...p, last_progress_at: "2026-10-02T01:00:00+02:00" }, 14, at("2026-10-15T23:00:00Z"))).toBe(false); // = Oct 1 23:00 UTC
    expect(isStale({ ...p, status: "on_hold" }, 14, at("2027-01-01T00:00:00Z"))).toBe(false);
    expect(isStale({ ...p, last_progress_at: null }, 14, at("2026-09-15T00:00:00Z"))).toBe(false); // falls back to created_at
    expect(isStale({ ...p, last_progress_at: null }, 14, at("2026-09-16T00:00:00Z"))).toBe(true);
  });
  it("utcDayNumber rejects impossible dates", () => {
    expect(() => utcDayNumber("2026-02-30")).toThrow("invalid date");
    expect(utcDayNumber("1970-01-02")).toBe(1);
  });
  it("per-category stale_days override", async () => {
    expect(staleDaysFor("a", [{ key: "a", stale_days: 3 }, { key: "b" }], 14)).toBe(3);
    expect(staleDaysFor("b", [{ key: "a", stale_days: 3 }, { key: "b" }], 14)).toBe(14);
    expect(staleDaysFor(null, [{ key: "a", stale_days: 3 }], 14)).toBe(14);
    // through the cards: a 5-day-old project is stale in a category with stale_days 3, not under the policy default
    const cat = INSTANCE.categories.project[0] as { key: string; stale_days?: number };
    const saved = { cat: cat.stale_days, pol: POLICY.stale_days };
    try {
      POLICY.stale_days = 14;
      const x = await createProject(db, { title: `Cat ${++n}`, owner: "O", status: "active", category: cat.key }, U);
      const five = new Date(Date.now() - 5 * 86400000).toISOString();
      await db.prepare("UPDATE project SET last_progress_at = ? WHERE id = ?").bind(five, x.id).run();
      delete cat.stale_days;
      expect((await listProjects(db)).find((c) => c.id === x.id)!.stale).toBe(false);
      cat.stale_days = 3;
      expect((await listProjects(db)).find((c) => c.id === x.id)!.stale).toBe(true);
    } finally {
      POLICY.stale_days = saved.pol;
      if (saved.cat === undefined) delete cat.stale_days;
      else cat.stale_days = saved.cat;
    }
  });
});
