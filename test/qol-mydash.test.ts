// My-dashboard API (QoL D4/D5): prefs, mine filters, open WPs, open gates.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { call, installTestKeys, serviceJwt, testCaller, userJwt } from "./helpers";
import { createProject } from "../src/data/projects";
import { upsertWorkpackage } from "../src/data/workpackages";
import { upsertMilestone } from "../src/data/milestones";
import { deleteEntity } from "../src/data/entities";
import { ensureUserPerson } from "../src/data/persons";

const db = env.DB;
const SYS = testCaller();
let n = 0;
const uniq = (s: string) => `${s} ${Date.now()}-${++n}`;

async function api(path: string, init: { method?: string; body?: unknown; email?: string; svc?: boolean } = {}) {
  const res = await call(path, {
    method: init.method ?? "GET",
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    jwt: init.svc ? await serviceJwt() : await userJwt(init.email ?? "user@example.com"),
    envOverride: { ALLOWED_EMAILS: "user@example.com,other@example.com" },
  });
  return { status: res.status, body: (await res.json()) as any };
}

let me: string;
let other: string;
beforeAll(async () => {
  await installTestKeys();
  me = (await ensureUserPerson(db, "user@example.com")).id;
  other = (await ensureUserPerson(db, "other@example.com")).id;
});

const putPrefs = (prefs: unknown, email?: string) => api("/api/persons/me/dashboard", { method: "PUT", body: { prefs }, email });
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const storedPrefs = async () =>
  (await db.prepare("SELECT id, dashboard_prefs FROM person ORDER BY id").all<{ id: string; dashboard_prefs: string | null }>()).results;

/** Valid prefs whose JSON is exactly `size` UTF-8 bytes; two-byte characters, so bytes and characters differ. */
function prefsOfBytes(size: number) {
  const p = { version: 1, views: [], active_projects: [] as string[] };
  // each full id: 100 "ä" = 200 bytes, plus two quotes and a comma; leaves 110..312 bytes for the tail
  while (size - bytes(p) - 203 >= 110) p.active_projects.push("ä".repeat(100));
  // the tail: four ASCII ids (two quotes and a comma each) of 24..76 characters
  const chars = size - bytes(p) - 4 * 3;
  const each = Math.floor(chars / 4);
  p.active_projects.push("a".repeat(each), "b".repeat(each), "c".repeat(each), "d".repeat(chars - 3 * each));
  return p;
}

describe("dashboard prefs", () => {
  it("defaults, round-trips, isolates per person and keeps the body out of the event", async () => {
    const first = await api("/api/persons/me/dashboard", { email: "other@example.com" });
    expect(first.body).toEqual({ prefs: { version: 1, views: [], active_projects: [] }, version: 1 });
    const p = await createProject(db, { title: uniq("Pref project"), owner: "O" }, SYS);
    const prefs = {
      version: 1,
      views: [{ id: "v1", name: "Mine", kind: "my_tasks", project_id: null }],
      active_projects: [p.id, "unknown-id"],
    };
    const put = await putPrefs(prefs);
    expect(put.status).toBe(200);
    const got = await api("/api/persons/me/dashboard");
    expect(got.body.prefs.views).toEqual(prefs.views);
    expect(got.body.prefs.active_projects).toEqual([p.id]);
    expect((await api("/api/persons/me/dashboard", { email: "other@example.com" })).body.prefs.views).toEqual([]);
    const ev = await db
      .prepare("SELECT summary, diff_json FROM event WHERE entity = 'person' AND entity_id = ? ORDER BY id DESC LIMIT 1")
      .bind(me)
      .first<any>();
    expect(ev.summary).toContain("dashboard preferences");
    expect(ev.diff_json).toBeNull();
    expect(me).not.toBe(other);
  });

  it("each person writes only their own prefs; person fields in the body cannot redirect the write", async () => {
    const mine = { version: 1, views: [{ id: "a", name: "Mine A", kind: "my_tasks" }], active_projects: [] };
    const theirs = { version: 1, views: [{ id: "b", name: "Theirs B", kind: "all_decisions" }], active_projects: [] };
    expect((await putPrefs(mine)).status).toBe(200);
    expect((await putPrefs(theirs, "other@example.com")).status).toBe(200);
    expect((await api("/api/persons/me/dashboard")).body.prefs.views).toEqual(mine.views);
    expect((await api("/api/persons/me/dashboard", { email: "other@example.com" })).body.prefs.views).toEqual(theirs.views);

    // fields naming another person, inside and next to prefs, are ignored: the write lands on the caller
    const sneaky = { version: 1, views: [{ id: "c", name: "Sneaky", kind: "my_tasks" }], active_projects: [] };
    for (const target of [other, "other@example.com"]) {
      const r = await api("/api/persons/me/dashboard", {
        method: "PUT",
        body: { prefs: { ...sneaky, person_id: target, id: target, email: target }, person_id: target, id: target, email: target },
      });
      expect(r.status).toBe(200);
      expect(r.body.prefs).toEqual({ ...sneaky, active_projects: [] });
    }
    expect((await api("/api/persons/me/dashboard", { email: "other@example.com" })).body.prefs.views).toEqual(theirs.views);
    expect((await api("/api/persons/me/dashboard")).body.prefs.views).toEqual(sneaky.views);
    const stored = (await storedPrefs()).find((r) => r.id === me)!.dashboard_prefs!;
    expect(JSON.parse(stored)).toEqual(sneaky); // unknown fields are not stored
    // the person id route is not a way in either
    const viaId = await api(`/api/persons/${other}/dashboard`, { method: "PUT", body: { prefs: sneaky } });
    expect([404, 405]).toContain(viaId.status);
    expect((await api("/api/persons/me/dashboard", { email: "other@example.com" })).body.prefs.views).toEqual(theirs.views);
  });

  it("size limit: exactly 8192 UTF-8 bytes accepted, 8193 refused", async () => {
    const ok = prefsOfBytes(8192);
    const over = prefsOfBytes(8193);
    expect([bytes(ok), bytes(over)]).toEqual([8192, 8193]);
    expect(JSON.stringify(ok).length).toBeLessThan(8192); // bytes, not characters
    expect((await putPrefs(ok)).status).toBe(200);
    const before = await storedPrefs();
    const r = await putPrefs(over);
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("8192 bytes");
    expect(await storedPrefs()).toEqual(before);
  });

  it("refuses invalid prefs and service tokens (exactly 403, nothing stored)", async () => {
    const big = {
      version: 1,
      views: [{ id: "v", name: "x".repeat(80), kind: "my_tasks" }],
      active_projects: Array(100).fill("p".repeat(100)),
    };
    expect((await putPrefs(big)).status).toBe(400);
    expect((await putPrefs({ version: 1, views: [{ id: "v", name: "n", kind: "bogus" }], active_projects: [] })).status).toBe(400);
    const views = Array.from({ length: 21 }, (_, i) => ({ id: `v${i}`, name: "n", kind: "my_tasks" }));
    expect((await putPrefs({ version: 1, views, active_projects: [] })).status).toBe(400);
    expect((await putPrefs({ version: 2, views: [], active_projects: [] })).status).toBe(400);
    const before = await storedPrefs();
    const svcPut = await api("/api/persons/me/dashboard", {
      method: "PUT",
      body: { prefs: { version: 1, views: [], active_projects: [] } },
      svc: true,
    });
    expect(svcPut.status).toBe(403);
    expect(await storedPrefs()).toEqual(before);
    expect((await api("/api/persons/me/dashboard", { svc: true })).status).toBe(403);
    expect((await api("/api/gates/open", { svc: true })).status).toBe(403);
  });
});

describe("mine and open work packages", () => {
  it("filters mine by human_only and project_id; open lists all owners, leaves only, no closed ones", async () => {
    const p = await createProject(db, { title: uniq("Open project"), owner: "O" }, SYS);
    const q = await createProject(db, { title: uniq("Other project"), owner: "O" }, SYS);
    const mk = (pid: string, id: string, f: Record<string, unknown>) => upsertWorkpackage(db, pid, { id, title: id, ...f }, SYS);
    await mk(p.id, `${p.id}-h`, { owner: me, human: true, end_date: "2030-01-02" });
    await mk(p.id, `${p.id}-m`, { owner: me, human: false, end_date: "2030-01-01" });
    await mk(p.id, `${p.id}-o`, { owner: other, human: true, end_date: "2030-01-03" });
    await mk(p.id, `${p.id}-d`, { owner: other, status: "done" });
    await mk(p.id, `${p.id}-dr`, { owner: me, human: true, status: "dropped", drop_reason: "not needed" });
    await mk(p.id, `${p.id}-x`, { owner: other });
    await mk(p.id, `${p.id}-xc`, { parent_id: `${p.id}-x`, owner: other });
    await mk(p.id, `${p.id}-t`, { owner: other });
    await deleteEntity(db, "workpackage", `${p.id}-t`, SYS);
    await mk(q.id, `${q.id}-q`, { owner: me, human: true });

    const ids = (r: any) => r.body.map((w: any) => w.id);
    const human = await api(`/api/workpackages/mine?human_only=1&project_id=${p.id}`);
    expect(ids(human)).toEqual([`${p.id}-h`]); // the dropped human WP of mine is not listed
    expect(ids(await api(`/api/workpackages/mine?project_id=${p.id}`)).sort()).toEqual([`${p.id}-h`, `${p.id}-m`]);

    const open = await api(`/api/workpackages/open?project_id=${p.id}`);
    expect(ids(open)).toEqual([`${p.id}-m`, `${p.id}-h`, `${p.id}-o`, `${p.id}-xc`]);
    expect(open.body[2]).toHaveProperty("effective_owner");
    expect(ids(await api(`/api/workpackages/open?project_id=${p.id}&human_only=1&limit=1`))).toEqual([`${p.id}-h`]);
    expect((await api(`/api/workpackages/open?project_id=${p.id}&limit=2`)).body).toHaveLength(2);
    expect((await api("/api/workpackages/open", { svc: true })).status).toBe(403);
  });
});

describe("open gates", () => {
  it("scope me/all, done and abandoned projects excluded in both scopes", async () => {
    const mkp = async (dm: string, status?: string) => {
      const p = await createProject(db, { title: uniq("Gate project"), owner: "O", decision_maker: dm }, SYS);
      await upsertMilestone(db, p.id, { id: `${p.id}-g`, title: "Gate", gate: true, due_date: "2030-05-01" }, SYS);
      if (status) await db.prepare("UPDATE project SET status = ? WHERE id = ?").bind(status, p.id).run();
      return p;
    };
    const mine = await mkp("user@example.com");
    const theirs = await mkp("other@example.com");
    const done = await mkp("user@example.com", "done");
    const abandoned = await mkp("user@example.com", "abandoned");
    const me1 = await api("/api/gates/open?scope=me");
    const meIds = me1.body.map((g: any) => g.project_id);
    expect(meIds).toContain(mine.id);
    expect(meIds).not.toContain(theirs.id);
    expect(meIds).not.toContain(done.id);
    expect(meIds).not.toContain(abandoned.id);
    const all = (await api("/api/gates/open?scope=all")).body;
    expect(all.map((g: any) => g.project_id)).toEqual(expect.arrayContaining([mine.id, theirs.id]));
    expect(all.map((g: any) => g.project_id)).not.toContain(done.id);
    expect(all.map((g: any) => g.project_id)).not.toContain(abandoned.id);
    for (const scope of ["me", "all"])
      for (const closed of [done, abandoned])
        expect((await api(`/api/gates/open?scope=${scope}&project_id=${closed.id}`)).body, `${scope} ${closed.id}`).toEqual([]);
    const row = me1.body.find((g: any) => g.project_id === mine.id);
    expect(row).toMatchObject({
      milestone_id: `${mine.id}-g`,
      title: "Gate",
      due_date: "2030-05-01",
      reached: false,
      decision_state: null,
    });
    expect(row.decision_maker.person_id).toBe(me);
    expect((await api("/api/gates/open?scope=x")).status).toBe(400);
  });

  it("lists gates awaiting a go decision only: an early go (not reached) is left out, a hold stays (D5)", async () => {
    const p = await createProject(db, { title: uniq("Gate decided"), owner: "O", decision_maker: "user@example.com" }, SYS);
    for (const g of ["go", "hold"]) {
      await upsertMilestone(db, p.id, { id: `${p.id}-${g}`, title: g, gate: true }, SYS);
      await db
        .prepare(
          "INSERT INTO decision (id, project_id, milestone_id, decision, decided_by, decided_at, actor, created_at) VALUES (?, ?, ?, ?, ?, '2030-01-01T00:00:00Z', 'test', '2030-01-01T00:00:00Z')",
        )
        .bind(`${p.id}-d-${g}`, p.id, `${p.id}-${g}`, g, me)
        .run();
    }
    const listed = (await api(`/api/gates/open?scope=all&project_id=${p.id}`)).body;
    expect(listed.map((g: any) => g.milestone_id)).toEqual([`${p.id}-hold`]);
    expect(listed[0]).toMatchObject({ reached: false, decision_state: "hold" });
  });
});
