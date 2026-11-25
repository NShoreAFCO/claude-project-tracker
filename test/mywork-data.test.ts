// "My work" feed: GET /api/me/recent and recentForMe.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { call, installTestKeys, serviceJwt, testCaller, userJwt } from "./helpers";
import { createProject } from "../src/data/projects";
import { upsertWorkpackage } from "../src/data/workpackages";
import { upsertMilestone } from "../src/data/milestones";
import { deleteEntity } from "../src/data/entities";
import { ensureUserPerson } from "../src/data/persons";
import { recentForMe } from "../src/data/mywork";
import { logProgress } from "../src/data/logs";
import { ACTOR as HOOK_ACTOR } from "../src/api/hooks";

const db = env.DB;
const SYS = testCaller();
let n = 0;
const uniq = (s: string) => `${s} ${Date.now()}-${++n}`;

const EMAILS = "user@example.com,other@example.com,viewer@example.com";
async function api(path: string, init: { email?: string; svc?: boolean } = {}) {
  const res = await call(path, {
    jwt: init.svc ? await serviceJwt() : await userJwt(init.email ?? "user@example.com"),
    envOverride: { ALLOWED_EMAILS: EMAILS },
  });
  return { status: res.status, body: (await res.json()) as any };
}

let me: string;
let other: string;
let viewer: string;
let meCaller: ReturnType<typeof testCaller>;
let otherCaller: ReturnType<typeof testCaller>;
beforeAll(async () => {
  await installTestKeys();
  me = (await ensureUserPerson(db, "user@example.com")).id;
  other = (await ensureUserPerson(db, "other@example.com")).id;
  viewer = (await ensureUserPerson(db, "viewer@example.com")).id;
  await db.prepare("UPDATE person SET access_role = 'viewer' WHERE id = ?").bind(viewer).run();
  meCaller = testCaller({ actor: "dashboard:me", personId: me, channel: "dashboard" });
  otherCaller = testCaller({ actor: "dashboard:other", personId: other, channel: "dashboard" });
});

const mk = (pid: string, id: string, f: Record<string, unknown>, by = otherCaller) =>
  upsertWorkpackage(db, pid, { id, title: id, ...f }, by);
const recentIds = async (query = "", email?: string) =>
  (await api(`/api/me/recent${query}`, { email })).body.map((e: any) => e.entity_id);

describe("GET /api/me/recent", () => {
  it("includes a done WP of mine and leaves out my own events, other people's WPs, old events and trashed projects", async () => {
    const p = await createProject(db, { title: uniq("Recent project"), owner: "O" }, SYS);
    await mk(p.id, `${p.id}-mine`, { owner: me, status: "done", code: "W1" });
    await mk(p.id, `${p.id}-dropped`, { owner: me, status: "dropped", drop_reason: "not needed" });
    await mk(p.id, `${p.id}-ownact`, { owner: me }, meCaller);
    await mk(p.id, `${p.id}-theirs`, { owner: other });
    await mk(p.id, `${p.id}-old`, { owner: me });
    await db
      .prepare("UPDATE event SET ts = '2000-01-01T00:00:00.000Z' WHERE entity_id = ?")
      .bind(`${p.id}-old`)
      .run();
    const gone = await createProject(db, { title: uniq("Trashed project"), owner: "O" }, SYS);
    await mk(gone.id, `${gone.id}-w`, { owner: me });
    await deleteEntity(db, "project", gone.id, SYS);

    const ids = await recentIds();
    expect(ids).toContain(`${p.id}-mine`);
    expect(ids).toContain(`${p.id}-dropped`);
    expect(ids).not.toContain(`${p.id}-ownact`);
    expect(ids).not.toContain(`${p.id}-theirs`);
    expect(ids).not.toContain(`${p.id}-old`);
    expect(ids).not.toContain(`${gone.id}-w`);

    const row = (await api("/api/me/recent")).body.find((e: any) => e.entity_id === `${p.id}-mine`);
    expect(row.project_title).toBe(p.title);
    expect(row.wp_code).toBe("W1");
    expect(row.person_name).not.toBeUndefined();
  });

  it("assigned_only leaves out unassigned WPs of my projects; days and limit are bounded", async () => {
    const p = await createProject(db, { title: uniq("Scope project"), owner: "user@example.com" }, SYS);
    await mk(p.id, `${p.id}-un`, {});
    await mk(p.id, `${p.id}-as`, { owner: me });
    const all = await recentIds(`?project_id=${p.id}`);
    expect(all).toEqual(expect.arrayContaining([`${p.id}-un`, `${p.id}-as`]));
    const assigned = await recentIds(`?assigned_only=1&project_id=${p.id}`);
    expect(assigned).toContain(`${p.id}-as`);
    expect(assigned).not.toContain(`${p.id}-un`);
    expect((await api("/api/me/recent?limit=1")).body).toHaveLength(1);
    for (const bad of ["days=0", "days=31", "days=x", "limit=0", "limit=101", "limit=1.5"])
      expect((await api(`/api/me/recent?${bad}`)).status, bad).toBe(400);
  });

  it("counts milestones of projects where I am the decision maker", async () => {
    const mine = await createProject(db, { title: uniq("DM project"), owner: "O", decision_maker: "user@example.com" }, SYS);
    const theirs = await createProject(db, { title: uniq("Other DM"), owner: "O", decision_maker: "other@example.com" }, SYS);
    await upsertMilestone(db, mine.id, { id: `${mine.id}-g`, title: "Gate", gate: true }, otherCaller);
    await upsertMilestone(db, theirs.id, { id: `${theirs.id}-g`, title: "Gate", gate: true }, otherCaller);
    const ids = await recentIds();
    expect(ids).toContain(`${mine.id}-g`);
    expect(ids).not.toContain(`${theirs.id}-g`);
  });

  it("counts events on projects I own, not on projects someone else owns", async () => {
    const mine = await createProject(db, { title: uniq("Owned project"), owner: "user@example.com" }, otherCaller);
    const theirs = await createProject(db, { title: uniq("Their project"), owner: "other@example.com" }, otherCaller);
    expect(await recentIds(`?project_id=${mine.id}`)).toContain(mine.id);
    expect(await recentIds(`?project_id=${theirs.id}`)).not.toContain(theirs.id);
  });

  it("project_id keeps milestone and project events of that project only", async () => {
    const a = await createProject(db, { title: uniq("Filter A"), owner: "user@example.com", decision_maker: "user@example.com" }, otherCaller);
    const b = await createProject(db, { title: uniq("Filter B"), owner: "user@example.com", decision_maker: "user@example.com" }, otherCaller);
    await upsertMilestone(db, a.id, { id: `${a.id}-g`, title: "Gate", gate: true }, otherCaller);
    await upsertMilestone(db, b.id, { id: `${b.id}-g`, title: "Gate", gate: true }, otherCaller);
    const unfiltered = await recentIds("?limit=100");
    expect(unfiltered).toEqual(expect.arrayContaining([a.id, `${a.id}-g`, b.id, `${b.id}-g`]));
    const ids = await recentIds(`?project_id=${a.id}`);
    expect(ids).toEqual(expect.arrayContaining([a.id, `${a.id}-g`]));
    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(`${b.id}-g`);
  });

  it("leaves out session-hook rows on an owned project and still returns the real changes up to the limit", async () => {
    const hook = testCaller({ actor: HOOK_ACTOR });
    const p = await createProject(db, { title: uniq("Hook project"), owner: "user@example.com" }, otherCaller);
    await mk(p.id, `${p.id}-w`, { assignee: "user@example.com" });
    await logProgress(db, { project_id: p.id, summary: "Claude Code session ended (clear) on main" }, hook);
    expect(await recentIds(`?project_id=${p.id}`)).toContain(p.id);
    const before = await recentForMe(db, meCaller, { project_id: p.id });
    expect(before.some((e) => e.actor === HOOK_ACTOR)).toBe(false);
    expect(before.length).toBeGreaterThan(0);

    // more hook rows than the limit, all newer than the real changes
    for (let i = 0; i < 4; i++) await logProgress(db, { project_id: p.id, summary: `session ${i}` }, hook);
    const rows = await recentForMe(db, meCaller, { project_id: p.id, limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows.every((e) => e.actor !== HOOK_ACTOR)).toBe(true);
    const log = await db.prepare("SELECT COUNT(*) AS c FROM event WHERE project_id = ? AND actor = ?").bind(p.id, HOOK_ACTOR).first<{ c: number }>();
    expect(log!.c).toBeGreaterThanOrEqual(5);
  });

  it("reads events by the ts index, not by a full scan of event", async () => {
    // Run the same statement under EXPLAIN QUERY PLAN by prefixing whatever recentForMe prepares.
    const explain = { prepare: (sql: string) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`) } as unknown as D1Database;
    for (const opts of [{}, { assigned_only: true }]) {
      const rows = (await recentForMe(explain, meCaller, opts)) as unknown as { detail: string }[];
      const plan = rows.map((r) => r.detail).join("\n");
      expect(plan).toMatch(/SEARCH e USING INDEX event_ts \(ts>\?\)/);
      expect(plan).not.toMatch(/SCAN e\b/);
    }
  });

  it("gives viewers redacted fields and callers without a person a 403", async () => {
    const p = await createProject(db, { title: uniq("Viewer project"), owner: "O" }, SYS);
    await mk(p.id, `${p.id}-v`, { owner: viewer });
    await db
      .prepare("UPDATE event SET diff_json = ? WHERE entity_id = ?")
      .bind(JSON.stringify({ local_path: [null, "/secret/place"] }), `${p.id}-v`)
      .run();
    const asViewer = (await api("/api/me/recent", { email: "viewer@example.com" })).body.find((e: any) => e.entity_id === `${p.id}-v`);
    expect(asViewer).toBeTruthy();
    expect(asViewer.diff_json).not.toContain("secret");

    expect((await api("/api/me/recent", { svc: true })).status).toBe(403);
    await expect(recentForMe(db, SYS, {})).rejects.toThrow(/dashboard login/);
  });
});
