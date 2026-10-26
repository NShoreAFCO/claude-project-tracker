// F3 (release R1): status rules, closure, follow-up projects, auto-start.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { call, installTestKeys, testCaller, userJwt } from "./helpers";
import { createProject, getProjectDetail, listProjects, setBeforeCloseWriteForTesting, updateProject } from "../src/data/projects";
import { upsertWorkpackage } from "../src/data/workpackages";
import { listEvents, logProgress } from "../src/data/logs";
import { upsertMilestone, listMilestones } from "../src/data/milestones";
import { writeContext } from "../src/data/context-write";
import { linkBranch } from "../src/data/branches";
import { OPEN_WP_STATUSES, TransitionError, moveWorkpackages, parseBlockedBy, setBeforeMoveWriteForTesting } from "../src/data/rules";
import { ConflictError, ValidationError } from "../src/data/util";
import { mcpApiHandler } from "../src/mcp/server";
import { ensureUserPerson } from "../src/data/persons";
import type { Env, WorkpackageRow } from "../src/types";

const db = env.DB;
const A = testCaller({ actor: "test" });
let n = 0;
const uniq = (s: string) => `${s} ${++n}`;
const today = () => new Date().toISOString().slice(0, 10);
const owned = (title: string, extra: Record<string, unknown> = {}) =>
  createProject(db, { title: uniq(title), owner: "Owner", ...extra }, A);
const wpRow = (id: string) => db.prepare("SELECT * FROM workpackage WHERE id = ?").bind(id).first<WorkpackageRow>();
const CLOSURE = { closure_note_md: "Closed.", lessons_learned_md: "none" };

async function api(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await call(path, {
    method: init.method ?? "GET",
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    jwt: await userJwt(),
  });
  return { status: res.status, body: (await res.json()) as any };
}

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
  const json = text.startsWith("{")
    ? JSON.parse(text)
    : JSON.parse(
        text
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice(6),
      );
  return json.result as { isError?: boolean; content: Array<{ text: string }> };
}

beforeAll(async () => {
  await installTestKeys();
  // Closing a project needs the decider role (F11, R5); the REST/MCP login of this file closes projects.
  const me = await ensureUserPerson(db, "user@example.com");
  await db.prepare("UPDATE person SET access_role = 'decider' WHERE id = ?").bind(me.id).run();
});
afterEach(() => setBeforeCloseWriteForTesting(null));

describe("project closure", () => {
  it("closing with open WPs returns 409 listing them", async () => {
    const p = await owned("Close open");
    const a = await upsertWorkpackage(db, p.id, { title: "a", status: "doing" }, A);
    const b = await upsertWorkpackage(db, p.id, { title: "b", status: "waiting" }, A);
    await upsertWorkpackage(db, p.id, { title: "c", status: "done" }, A);
    await upsertWorkpackage(db, p.id, { title: "d", status: "dropped", drop_reason: "not needed" }, A);
    const err = await updateProject(db, p.id, { status: "done", ...CLOSURE }, A).catch((e) => e);
    expect(err).toBeInstanceOf(TransitionError);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(err.current.code).toBe("OPEN_WORKPACKAGES");
    expect(err.current.open_workpackages.map((w: { id: string }) => w.id).sort()).toEqual([a.id, b.id].sort());
    expect(err.current.open_workpackages[0]).toHaveProperty("title");
    expect(err.current.open_workpackages[0]).toHaveProperty("status");
    // REST: the same 409 with the machine-readable list
    const r = await api(`/api/projects/${p.id}`, { method: "PATCH", body: { status: "done", ...CLOSURE } });
    expect(r.status).toBe(409);
    expect(r.body.current.code).toBe("OPEN_WORKPACKAGES");
    expect(r.body.current.open_workpackages).toHaveLength(2);
    // MCP: tool error with the same details
    const m = await mcp("update_project", { id: p.id, patch: { status: "done", ...CLOSURE } });
    expect(m.isError).toBe(true);
    expect(JSON.parse(m.content[0].text).current.code).toBe("OPEN_WORKPACKAGES");
    expect((await getProjectDetail(db, p.id)).project.status).toBe("active");
    expect([...OPEN_WP_STATUSES]).toEqual(["todo", "doing", "blocked", "waiting"]);
  });

  it("close fails if an open WP appears between read and write", async () => {
    const p = await owned("Close race");
    await upsertWorkpackage(db, p.id, { title: "finished", status: "done" }, A);
    const before = (await listEvents(db, { project_id: p.id, limit: 200 })).length;
    let lateId = "";
    setBeforeCloseWriteForTesting(async () => {
      // a concurrent writer adds an open WP after the pre-read
      const w = await upsertWorkpackage(db, p.id, { title: "late arrival" }, A);
      lateId = w.id;
    });
    const err = await updateProject(db, p.id, { status: "done", ...CLOSURE }, A).catch((e) => e);
    expect(err).toBeInstanceOf(TransitionError);
    expect(err.current.code).toBe("OPEN_WORKPACKAGES");
    expect(err.current.open_workpackages.map((w: { id: string }) => w.id)).toEqual([lateId]);
    const events = await listEvents(db, { project_id: p.id, limit: 200 });
    // only the late WP's create event was added; no project update event
    expect(events.length).toBe(before + 1);
    expect(events.some((e) => e.entity === "project" && e.action === "update")).toBe(false);
    const detail = await getProjectDetail(db, p.id);
    expect(detail.project.status).toBe("active");
    expect(detail.project.closure_note_md).toBeNull();
  });

  it("a version change between read and write is still a plain version conflict", async () => {
    const p = await owned("Close version race");
    setBeforeCloseWriteForTesting(async () => {
      await db.prepare("UPDATE project SET version = version + 1 WHERE id = ?").bind(p.id).run();
    });
    const err = await updateProject(db, p.id, { status: "done", ...CLOSURE }, A).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err).not.toBeInstanceOf(TransitionError);
    expect(err.message).toBe("version conflict");
  });

  it("done requires closure_note_md and lessons_learned_md; abandoned requires closure_note_md", async () => {
    const p = await owned("Closure fields");
    const e1 = await updateProject(db, p.id, { status: "done" }, A).catch((e) => e);
    expect(e1).toBeInstanceOf(TransitionError);
    expect(e1.current.code).toBe("CLOSURE_FIELDS_MISSING");
    expect(e1.current.missing).toEqual(["closure_note_md", "lessons_learned_md"]);
    const e2 = await updateProject(db, p.id, { status: "done", closure_note_md: "Shipped.", lessons_learned_md: "  " }, A).catch((e) => e);
    expect(e2.current.missing).toEqual(["lessons_learned_md"]);
    const e3 = await updateProject(db, p.id, { status: "abandoned" }, A).catch((e) => e);
    expect(e3.current.missing).toEqual(["closure_note_md"]);
    // stored values count: set the note first, then abandon without repeating it
    await updateProject(db, p.id, { closure_note_md: "Customer cancelled." }, A);
    const ab = await updateProject(db, p.id, { status: "abandoned" }, A);
    expect(ab.status).toBe("abandoned");
    // clearing the note of a closed project is refused
    const e4 = await updateProject(db, p.id, { closure_note_md: null }, A).catch((e) => e);
    expect(e4.current?.code).toBe("CLOSURE_FIELDS_MISSING");
    // done with both fields in one write (REST)
    const q = await owned("Closure ok");
    const r = await api(`/api/projects/${q.id}`, { method: "PATCH", body: { status: "done", ...CLOSURE } });
    expect(r.status).toBe(200);
    expect([r.body.status, r.body.closure_note_md, r.body.lessons_learned_md]).toEqual(["done", "Closed.", "none"]);
    // creation as done needs them too (MCP)
    const bad = await mcp("create_project", { title: uniq("Born done"), status: "done" });
    expect(bad.isError).toBe(true);
    expect(JSON.parse(bad.content[0].text).current.missing).toEqual(["closure_note_md", "lessons_learned_md"]);
    const ok = await mcp("create_project", { title: uniq("Born done"), status: "done", ...CLOSURE });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(ok.content[0].text).lessons_learned_md).toBe("none");
    const upd = await mcp("update_project", { id: p.id, patch: { lessons_learned_md: "Ask earlier." } });
    expect(JSON.parse(upd.content[0].text).lessons_learned_md).toBe("Ask earlier.");
  });
});

describe("closed projects stay closed", () => {
  it("creating a WP in a done project is refused (PROJECT_CLOSED)", async () => {
    const p = await owned("Closed create");
    await updateProject(db, p.id, { status: "done", ...CLOSURE }, A);
    for (const status of [undefined, "done"]) {
      const err = await upsertWorkpackage(db, p.id, { title: "late", ...(status ? { status } : {}) }, A).catch((e) => e);
      expect(err).toBeInstanceOf(TransitionError);
      expect(err.current.code).toBe("PROJECT_CLOSED");
    }
    const r = await api("/api/workpackages", { method: "POST", body: { project_id: p.id, title: "late" } });
    expect(r.status).toBe(409);
    expect(r.body.current.code).toBe("PROJECT_CLOSED");
    expect((await getProjectDetail(db, p.id)).workpackages).toHaveLength(0);
  });

  it("reopening a WP in an abandoned project is refused", async () => {
    const p = await owned("Closed reopen");
    const done = await upsertWorkpackage(db, p.id, { title: "finished", status: "done" }, A);
    const dropped = await upsertWorkpackage(db, p.id, { title: "gone", status: "dropped", drop_reason: "no" }, A);
    await updateProject(db, p.id, { status: "abandoned", closure_note_md: "Stopped." }, A);
    for (const [id, status] of [
      [done.id, "doing"],
      [dropped.id, "todo"],
      [done.id, "blocked"],
      [dropped.id, "waiting"],
    ]) {
      const err = await upsertWorkpackage(db, p.id, { id, status }, A).catch((e) => e);
      expect(err).toBeInstanceOf(TransitionError);
      expect(err.current.code).toBe("PROJECT_CLOSED");
    }
    const m = await mcp("upsert_workpackage", { project_id: p.id, id: done.id, status: "todo" });
    expect(m.isError).toBe(true);
    expect(JSON.parse(m.content[0].text).current.code).toBe("PROJECT_CLOSED");
    expect((await wpRow(done.id))!.status).toBe("done");
    expect((await wpRow(dropped.id))!.status).toBe("dropped");
  });

  it("editing a done WP's title in a done project succeeds", async () => {
    const p = await owned("Closed edit");
    const w = await upsertWorkpackage(db, p.id, { title: "finished", status: "done" }, A);
    await updateProject(db, p.id, { status: "done", ...CLOSURE }, A);
    const edited = await upsertWorkpackage(db, p.id, { id: w.id, title: "finished (final)", description_md: "Report filed." }, A);
    expect([edited.title, edited.status]).toEqual(["finished (final)", "done"]);
    // log_progress on a closed project's WP stays allowed and cannot reopen it
    const r = await logProgress(db, { project_id: p.id, workpackage_id: w.id, summary: "archived the files" }, A);
    expect(r.workpackage!.status).toBe("done");
  });

  it("after reopening the project a WP can be added", async () => {
    const p = await owned("Closed then reopened");
    await updateProject(db, p.id, { status: "done", ...CLOSURE }, A);
    await updateProject(db, p.id, { status: "active" }, A);
    const w = await upsertWorkpackage(db, p.id, { title: "follow-up check" }, A);
    expect(w.status).toBe("todo");
  });
});

describe("work package rules", () => {
  it("dropping a WP requires drop_reason", async () => {
    const p = await owned("Drop");
    const w = await upsertWorkpackage(db, p.id, { title: "w" }, A);
    const err = await upsertWorkpackage(db, p.id, { id: w.id, status: "dropped" }, A).catch((e) => e);
    expect(err).toBeInstanceOf(TransitionError);
    expect(err.current).toEqual({ code: "DROP_REASON_MISSING", missing: ["drop_reason"] });
    const created = await upsertWorkpackage(db, p.id, { title: "born dropped", status: "dropped" }, A).catch((e) => e);
    expect(created).toBeInstanceOf(TransitionError);
    const ok = await upsertWorkpackage(db, p.id, { id: w.id, status: "dropped", drop_reason: "superseded" }, A);
    expect([ok.status, ok.drop_reason]).toEqual(["dropped", "superseded"]);
    // REST 409; MCP accepts drop_reason
    const v = await upsertWorkpackage(db, p.id, { title: "v" }, A);
    const r = await api(`/api/workpackages/${v.id}`, { method: "PATCH", body: { project_id: p.id, status: "dropped" } });
    expect(r.status).toBe(409);
    const m = await mcp("upsert_workpackage", { project_id: p.id, id: v.id, status: "dropped", drop_reason: "out of scope" });
    expect(JSON.parse(m.content[0].text).drop_reason).toBe("out of scope");
  });

  it("blocked_by accepts wp:/ms:/ext: refs and sets blocked_since", async () => {
    const p = await owned("Blocked");
    const dep = await upsertWorkpackage(db, p.id, { title: "dep" }, A);
    const ms = await upsertMilestone(db, p.id, { title: "gate" }, A);
    const w = await upsertWorkpackage(db, p.id, { title: "w", status: "blocked", blocked_by: `wp:${dep.id}` }, A);
    expect(w.blocked_since).toBe(today());
    expect(w.blocked_ref).toEqual({ kind: "wp", ref: dep.id });
    const w2 = await upsertWorkpackage(db, p.id, { id: w.id, blocked_by: `ms:${ms.id}`, blocked_since: "2026-10-01" }, A);
    expect([w2.blocked_since, w2.blocked_ref]).toEqual(["2026-10-01", { kind: "ms", ref: ms.id }]);
    const w3 = await upsertWorkpackage(db, p.id, { id: w.id, blocked_by: "ext:supplier delivery" }, A);
    expect(w3.blocked_ref).toEqual({ kind: "ext", ref: "supplier delivery" });
    expect(w3.blocked_since).toBe("2026-10-01");
    // unknown wp/ms refs are rejected
    const bad = await upsertWorkpackage(db, p.id, { id: w.id, blocked_by: "wp:does-not-exist" }, A).catch((e) => e);
    expect(bad).toBeInstanceOf(ValidationError);
    const bad2 = await upsertWorkpackage(db, p.id, { id: w.id, blocked_since: "01.10.2026" }, A).catch((e) => e);
    expect(bad2).toBeInstanceOf(ValidationError);
    // leaving blocked clears blocked_since; waiting keeps an optional reason, cleared when leaving waiting
    const doing = await upsertWorkpackage(db, p.id, { id: w.id, status: "doing" }, A);
    expect(doing.blocked_since).toBeNull();
    const waiting = await upsertWorkpackage(db, p.id, { id: w.id, status: "waiting", waiting_reason: "after the trade fair" }, A);
    expect(waiting.waiting_reason).toBe("after the trade fair");
    const back = await upsertWorkpackage(db, p.id, { id: w.id, status: "doing" }, A);
    expect(back.waiting_reason).toBeNull();
    // parseBlockedBy classifies
    expect(parseBlockedBy(null)).toBeNull();
    expect(parseBlockedBy("  ")).toBeNull();
    expect(parseBlockedBy("wp:x")).toEqual({ kind: "wp", ref: "x" });
    expect(parseBlockedBy("ms:y")).toEqual({ kind: "ms", ref: "y" });
    expect(parseBlockedBy("ext: lab capacity ")).toEqual({ kind: "ext", ref: "lab capacity" });
  });

  it("legacy blocked_by text is kept and readable", async () => {
    const p = await owned("Legacy blocked");
    const w = await upsertWorkpackage(db, p.id, { title: "w" }, A);
    // a row written by the previous version: status blocked, free text, no blocked_since
    await db.prepare("UPDATE workpackage SET status = 'blocked', blocked_by = ? WHERE id = ?").bind("waiting for the customer", w.id).run();
    const detail = await getProjectDetail(db, p.id);
    const node = detail.workpackages.find((x) => x.id === w.id)!;
    expect(node.blocked_by).toBe("waiting for the customer");
    expect(node.blocked_ref).toEqual({ kind: "text", ref: "waiting for the customer" });
    expect(parseBlockedBy("waiting for the customer")).toEqual({ kind: "text", ref: "waiting for the customer" });
    // other edits keep it; free text is still accepted on write
    const edited = await upsertWorkpackage(db, p.id, { id: w.id, title: "w renamed" }, A);
    expect(edited.blocked_by).toBe("waiting for the customer");
    const again = await upsertWorkpackage(db, p.id, { id: w.id, blocked_by: "parts on back order" }, A);
    expect(again.blocked_ref).toEqual({ kind: "text", ref: "parts on back order" });
    const card = (await listProjects(db)).find((c) => c.id === p.id)!;
    expect(card.blocked).toEqual(["parts on back order"]);
  });

  it("first log_progress on a todo WP sets doing unless status given", async () => {
    const p = await owned("Auto start log");
    const w = await upsertWorkpackage(db, p.id, { title: "w" }, A);
    const r = await logProgress(db, { project_id: p.id, workpackage_id: w.id, summary: "started reading" }, A);
    expect(r.workpackage!.status).toBe("doing");
    const ev = (await listEvents(db, { project_id: p.id })).find((e) => e.id === r.event_id)!;
    expect(JSON.parse(ev.diff_json!)).toEqual({ status: ["todo", "doing"] });
    // a WP that is not todo is left alone
    const b = await upsertWorkpackage(db, p.id, { title: "b", status: "waiting" }, A);
    const r2 = await logProgress(db, { project_id: p.id, workpackage_id: b.id, summary: "note" }, A);
    expect(r2.workpackage!.status).toBe("waiting");
    // with progress: todo → doing, ≥ 100 → done
    const c = await upsertWorkpackage(db, p.id, { title: "c" }, A);
    const r3 = await logProgress(db, { project_id: p.id, workpackage_id: c.id, summary: "half", progress: 50 }, A);
    expect([r3.workpackage!.status, r3.workpackage!.progress]).toEqual(["doing", 50]);
    // an explicit status in the same write wins over auto-start (upsert_workpackage)
    const d = await upsertWorkpackage(db, p.id, { title: "d" }, A);
    const kept = await upsertWorkpackage(db, p.id, { id: d.id, progress: 30, status: "todo" }, A);
    expect([kept.status, kept.progress]).toEqual(["todo", 30]);
    // MCP log_progress auto-starts as well
    const e = await upsertWorkpackage(db, p.id, { title: "e" }, A);
    const m = await mcp("log_progress", { project_id: p.id, workpackage_id: e.id, summary: "kicked off" });
    expect(JSON.parse(m.content[0].text).workpackage.status).toBe("doing");
  });

  it("manual progress > 0 on a todo WP sets doing", async () => {
    const p = await owned("Auto start manual");
    const w = await upsertWorkpackage(db, p.id, { title: "w" }, A);
    const zero = await upsertWorkpackage(db, p.id, { id: w.id, progress: 0 }, A);
    expect(zero.status).toBe("todo");
    const up = await upsertWorkpackage(db, p.id, { id: w.id, progress: 10 }, A);
    expect(up.status).toBe("doing");
    const born = await upsertWorkpackage(db, p.id, { title: "born with progress", progress: 20 }, A);
    expect(born.status).toBe("doing");
    // REST too
    const v = await upsertWorkpackage(db, p.id, { title: "v" }, A);
    const r = await api(`/api/workpackages/${v.id}`, { method: "PATCH", body: { project_id: p.id, progress: 5 } });
    expect(r.body.status).toBe("doing");
    // other statuses are untouched by a progress change
    const b = await upsertWorkpackage(db, p.id, { title: "b", status: "blocked", blocked_by: "ext:x" }, A);
    const b2 = await upsertWorkpackage(db, p.id, { id: b.id, progress: 40 }, A);
    expect(b2.status).toBe("blocked");
  });
});

describe("follow-up projects", () => {
  it("move_workpackages moves open WPs with children and links projects", async () => {
    const from = await owned("Old");
    const to = await owned("Follow-up");
    const stay = await upsertWorkpackage(db, from.id, { title: "stay" }, A);
    const top = await upsertWorkpackage(db, from.id, { title: "top", status: "doing", depends_on: [stay.id] }, A);
    const kidDone = await upsertWorkpackage(db, from.id, { title: "kid done", parent_id: top.id, status: "done" }, A);
    const kidOpen = await upsertWorkpackage(db, from.id, { title: "kid open", parent_id: top.id }, A);
    const subOnly = await upsertWorkpackage(db, from.id, { title: "sub only", parent_id: stay.id, status: "waiting" }, A);
    // A mutual dependency (stored before writes refused cycles) exercises removal in both directions.
    await db
      .prepare("UPDATE workpackage SET depends_on = ? WHERE id = ?")
      .bind(JSON.stringify([top.id]), stay.id)
      .run();
    const done = await upsertWorkpackage(db, from.id, { title: "finished", status: "done" }, A);
    const ms = await upsertMilestone(db, from.id, { title: "M", requires: [top.id, stay.id], unlocks: [kidOpen.id] }, A);
    const doc = await writeContext(db, { owner_kind: "workpackage", owner_id: kidOpen.id, title: "Notes", content_md: "x" }, A);
    const br = await linkBranch(db, from.id, { repo: "https://github.com/example/repo", name: uniq("feat/x"), workpackage_id: top.id }, A);

    // only open WPs may be moved
    const notOpen = await moveWorkpackages(db, from.id, to.id, [done.id], A).catch((e) => e);
    expect(notOpen).toBeInstanceOf(ValidationError);
    const foreign = await moveWorkpackages(db, to.id, from.id, [top.id], A).catch((e) => e);
    expect(foreign).toBeInstanceOf(ValidationError);

    const res = await moveWorkpackages(db, from.id, to.id, [top.id, subOnly.id], A);
    expect(res.moved.sort()).toEqual([top.id, kidDone.id, kidOpen.id, subOnly.id].sort());

    for (const id of res.moved) expect((await wpRow(id))!.project_id).toBe(to.id);
    expect((await wpRow(kidOpen.id))!.parent_id).toBe(top.id);
    expect((await wpRow(subOnly.id))!.parent_id).toBeNull(); // its parent stayed behind
    expect((await wpRow(stay.id))!.project_id).toBe(from.id);
    // cross-project dependencies removed in both directions
    expect((await wpRow(stay.id))!.depends_on).toBe("[]");
    expect((await wpRow(top.id))!.depends_on).toBe("[]");
    // milestone links of the old project to moved WPs removed; the staying one kept
    const m = (await listMilestones(db, from.id)).find((x) => x.id === ms.id)!;
    expect([m.requires, m.unlocks]).toEqual([[stay.id], []]);
    // context docs and branches follow
    const d = await db.prepare("SELECT project_id FROM context_doc WHERE id = ?").bind(doc.id).first<{ project_id: string }>();
    expect(d!.project_id).toBe(to.id);
    const b = await db.prepare("SELECT project_id FROM branch WHERE id = ?").bind(br.id).first<{ project_id: string }>();
    expect(b!.project_id).toBe(to.id);
    // projects are linked
    const newer = await getProjectDetail(db, to.id);
    const older = await getProjectDetail(db, from.id);
    expect([newer.project.follows, newer.project.followed_by]).toEqual([[from.id], []]);
    expect([older.project.follows, older.project.followed_by]).toEqual([[], [to.id]]);
    // one event per project
    const evFrom = (await listEvents(db, { project_id: from.id })).filter((e) => e.action === "move_workpackages");
    const evTo = (await listEvents(db, { project_id: to.id })).filter((e) => e.action === "move_workpackages");
    expect([evFrom.length, evTo.length]).toEqual([1, 1]);
    const diff = JSON.parse(evFrom[0].diff_json!);
    expect(diff.moved_workpackages[1].sort()).toEqual(res.moved.sort());
    expect(diff.removed_milestone_links[0].length).toBe(2);
    expect(diff.removed_dependencies[0].sort()).toEqual([`${stay.id}->${top.id}`, `${top.id}->${stay.id}`].sort());
    // the old project can now be closed: no open WPs left except "stay"
    await upsertWorkpackage(db, from.id, { id: stay.id, status: "done" }, A);
    const closed = await updateProject(db, from.id, { status: "done", ...CLOSURE }, A);
    expect(closed.status).toBe("done");
    // a closed project is no target
    const tgt = await moveWorkpackages(db, to.id, from.id, [kidOpen.id], A).catch((e) => e);
    expect(tgt).toBeInstanceOf(TransitionError);
    expect(tgt.current.code).toBe("TARGET_CLOSED");
  });

  it("a concurrent change to an affected WP makes the move a no-op (409)", async () => {
    const from = await owned("Old race");
    const to = await owned("New race");
    const stay = await upsertWorkpackage(db, from.id, { title: "stay" }, A);
    const go = await upsertWorkpackage(db, from.id, { title: "go", depends_on: [stay.id] }, A);
    const kid = await upsertWorkpackage(db, from.id, { title: "kid", parent_id: go.id }, A);
    const ms = await upsertMilestone(db, from.id, { title: "M", requires: [go.id] }, A);
    // a WP that would move is edited between the reads and the batch
    setBeforeMoveWriteForTesting(async () => {
      await upsertWorkpackage(db, from.id, { id: kid.id, title: "kid renamed" }, A);
    });
    try {
      const err = await moveWorkpackages(db, from.id, to.id, [go.id], A).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictError);
      expect(err).not.toBeInstanceOf(TransitionError);
    } finally {
      setBeforeMoveWriteForTesting(null);
    }
    for (const id of [go.id, kid.id, stay.id]) expect((await wpRow(id))!.project_id).toBe(from.id);
    expect((await wpRow(go.id))!.depends_on).toBe(JSON.stringify([stay.id]));
    expect((await listMilestones(db, from.id)).find((x) => x.id === ms.id)!.requires).toEqual([go.id]);
    expect((await getProjectDetail(db, to.id)).project.follows).toEqual([]);
    expect((await listEvents(db, { project_id: to.id })).some((e) => e.action === "move_workpackages")).toBe(false);
    expect((await listEvents(db, { project_id: from.id })).some((e) => e.action === "move_workpackages")).toBe(false);
  });

  it("move_workpackages via MCP and REST", async () => {
    const from = await owned("Old api");
    const to = await owned("New api");
    const w1 = await upsertWorkpackage(db, from.id, { title: "w1" }, A);
    const w2 = await upsertWorkpackage(db, from.id, { title: "w2", status: "blocked", blocked_by: "ext:x" }, A);
    const m = await mcp("move_workpackages", { project_id: from.id, to_project_id: to.id, ids: [w1.id] });
    expect(m.isError).toBeFalsy();
    expect(JSON.parse(m.content[0].text).moved).toEqual([w1.id]);
    const r = await api(`/api/projects/${from.id}/move-workpackages`, { method: "POST", body: { to_project_id: to.id, ids: [w2.id] } });
    expect(r.status).toBe(200);
    expect(r.body.moved).toEqual([w2.id]);
    expect((await wpRow(w2.id))!.project_id).toBe(to.id);
    const bad = await api(`/api/projects/${from.id}/move-workpackages`, { method: "POST", body: { to_project_id: to.id, ids: [] } });
    expect(bad.status).toBe(400);
  });
});

describe("derived flags and counts", () => {
  it("closure_due true at 100% derived with all WPs done", async () => {
    const p = await owned("Due");
    const a = await upsertWorkpackage(db, p.id, { title: "a", status: "done" }, A);
    const b = await upsertWorkpackage(db, p.id, { title: "b" }, A);
    const flags = async () => {
      const d = await getProjectDetail(db, p.id);
      const card = (await listProjects(db)).find((c) => c.id === p.id)!;
      expect([card.closure_due, card.stalled_blocked]).toEqual([d.project.closure_due, d.project.stalled_blocked]);
      return { closure_due: d.project.closure_due, stalled_blocked: d.project.stalled_blocked };
    };
    expect(await flags()).toEqual({ closure_due: false, stalled_blocked: false });
    await upsertWorkpackage(db, p.id, { id: b.id, status: "blocked", blocked_by: "ext:customer" }, A);
    expect(await flags()).toEqual({ closure_due: false, stalled_blocked: true });
    // a blocked sub-WP does not stall the project
    await upsertWorkpackage(db, p.id, { id: b.id, status: "dropped", drop_reason: "obsolete" }, A);
    const kid = await upsertWorkpackage(db, p.id, { title: "kid", parent_id: a.id, status: "blocked", blocked_by: "ext:y" }, A);
    expect((await flags()).stalled_blocked).toBe(false);
    await upsertWorkpackage(db, p.id, { id: kid.id, status: "done" }, A);
    expect(await flags()).toEqual({ closure_due: true, stalled_blocked: false });
    const res = await updateProject(db, p.id, { status: "done", ...CLOSURE }, A);
    expect(res.closure_due).toBe(false);
    // an empty project is never due
    const empty = await owned("Empty");
    expect((await getProjectDetail(db, empty.id)).project.closure_due).toBe(false);
  });

  it("card wp_counts split open, in progress, waiting+blocked, done (started kept as alias)", async () => {
    const p = await owned("Counts F3");
    await upsertWorkpackage(db, p.id, { title: "t" }, A);
    await upsertWorkpackage(db, p.id, { title: "d", status: "doing" }, A);
    await upsertWorkpackage(db, p.id, { title: "w", status: "waiting" }, A);
    await upsertWorkpackage(db, p.id, { title: "b", status: "blocked", blocked_by: "ext:x" }, A);
    await upsertWorkpackage(db, p.id, { title: "x", status: "done" }, A);
    await upsertWorkpackage(db, p.id, { title: "y", status: "dropped", drop_reason: "no" }, A);
    const card = (await listProjects(db)).find((c) => c.id === p.id)!;
    expect(card.wp_counts).toEqual({ open: 1, in_progress: 1, waiting_blocked: 2, done: 1, started: 1 });
    // card hints for the Blocked / Waiting chips
    expect(card.waiting_count).toBe(1);
    expect(card.blocked_since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
