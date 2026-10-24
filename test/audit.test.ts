import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_EVENTS_PER_RUN, buildSnapshot, runAuditExport } from "../src/audit/export";
import { upsertWorkpackage } from "../src/data/workpackages";
import { upsertMilestone } from "../src/data/milestones";
import { createProject } from "../src/data/projects";
import { deleteContext, writeContext } from "../src/data/context-write";
import { deleteEntity } from "../src/data/entities";
import { call, installTestKeys, userJwt } from "./helpers";

const REPO = "example-org/tracker-audit";
const API = `https://api.github.com/repos/${REPO}`;

/** In-memory GitHub: commits hold full file maps; trees are keyed by commit for simplicity. */
class FakeGitHub {
  commits = new Map<string, { files: Map<string, string>; message: string; parent: string | null }>();
  trees = new Map<string, Map<string, string>>();
  head = "c0";
  calls: Array<{ method: string; path: string; auth: string | null }> = [];
  failRefOnce = 0; // status for the first PATCH ref
  failTrees = 0; // status for every POST git/trees
  seq = 0;

  constructor() {
    const files = new Map([["README.md", "# audit\n"]]);
    this.commits.set("c0", { files, message: "init", parent: null });
    this.trees.set("t0", files);
  }
  files(): Map<string, string> {
    return this.commits.get(this.head)!.files;
  }
  commitCount(): number {
    return this.commits.size - 1;
  }
  treeOf(commit: string): string {
    return [...this.trees].find(([, f]) => f === this.commits.get(commit)!.files)![0];
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    this.calls.push({ method, path: url.pathname + url.search, auth: headers.get("Authorization") });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const p = url.pathname.replace(`/repos/${REPO}`, "");
    const ok = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    const err = (status: number) => new Response(JSON.stringify({ message: "x" }), { status });

    if (method === "GET" && p === "") return ok({ default_branch: "main" });
    if (method === "GET" && p === "/git/ref/heads/main") return ok({ object: { sha: this.head } });
    if (method === "GET" && p.startsWith("/git/commits/")) return ok({ tree: { sha: this.treeOf(p.split("/").pop()!) } });
    if (method === "GET" && p.startsWith("/git/trees/")) {
      const t = this.trees.get(p.split("/").pop()!)!;
      return ok({ truncated: false, tree: [...t.keys()].map((path) => ({ path, type: "blob" })) });
    }
    if (p.startsWith("/contents/")) {
      const path = p.slice("/contents/".length).split("/").map(decodeURIComponent).join("/");
      const ref = url.searchParams.get("ref") ?? "main";
      const files = this.commits.get(ref === "main" ? this.head : ref)!.files;
      if (method === "GET") {
        if (!files.has(path)) return err(404);
        if (headers.get("Accept")?.includes("raw")) return new Response(files.get(path)!, { status: 200 });
        return ok({ sha: `blob-${path}` });
      }
      const next = new Map(this.files());
      if (method === "PUT") {
        const bytes = Uint8Array.from(atob(body.content), (ch) => ch.charCodeAt(0));
        next.set(path, new TextDecoder().decode(bytes));
      } else if (method === "DELETE") next.delete(path);
      this.addCommit(next, body.message);
      return ok({});
    }
    if (method === "POST" && p === "/git/trees") {
      if (this.failTrees) return err(this.failTrees);
      const files = new Map(this.trees.get(body.base_tree)!);
      for (const e of body.tree) {
        if (e.sha === null) files.delete(e.path);
        else files.set(e.path, e.content);
      }
      const id = `t${++this.seq}`;
      this.trees.set(id, files);
      return ok({ sha: id }, 201);
    }
    if (method === "POST" && p === "/git/commits") {
      const id = `c${++this.seq}`;
      this.commits.set(id, { files: this.trees.get(body.tree)!, message: body.message, parent: body.parents[0] });
      return ok({ sha: id }, 201);
    }
    if (method === "PATCH" && p === "/git/refs/heads/main") {
      if (this.failRefOnce) {
        const s = this.failRefOnce;
        this.failRefOnce = 0;
        // Simulate a concurrent writer: head moves on, our commit is not a fast-forward.
        this.addCommit(new Map(this.files()).set("other.txt", "x"), "concurrent");
        return err(s);
      }
      if (this.commits.get(body.sha)!.parent !== this.head) return err(422);
      this.head = body.sha;
      return ok({ object: { sha: body.sha } });
    }
    return err(404);
  };

  private addCommit(files: Map<string, string>, message: string) {
    const c = `c${++this.seq}`;
    const t = `t${++this.seq}`;
    this.trees.set(t, files);
    this.commits.set(c, { files, message, parent: this.head });
    this.head = c;
  }
}

let gh: FakeGitHub;
const db = env.DB;
const actor = "user:user@example.com";

async function resetDb() {
  await db.batch([
    db.prepare("DELETE FROM project"),
    db.prepare("DELETE FROM event"),
    db.prepare("DELETE FROM meta"),
    db.prepare("DELETE FROM context_doc"),
  ]);
}
const meta = async (k: string) => (await db.prepare("SELECT value FROM meta WHERE key = ?").bind(k).first<{ value: string }>())?.value;
const jsonl = (month: string) =>
  (gh.files().get(`events/${month}.jsonl`) ?? "")
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const month = () => new Date().toISOString().slice(0, 7);

beforeEach(async () => {
  await resetDb();
  gh = new FakeGitHub();
  vi.spyOn(globalThis, "fetch").mockImplementation(gh.fetch);
});
afterEach(() => vi.restoreAllMocks());

describe("audit export (SPEC §8)", () => {
  it("does nothing when there are no new events", async () => {
    expect(await runAuditExport(env)).toEqual({ status: "noop", last_event_id: 0 });
    expect(gh.calls).toHaveLength(0);
  });

  it("commits snapshot, context files and events in one commit, then updates meta", async () => {
    await createProject(db, { id: "alpha", title: "Alpha" }, actor);
    const doc = await writeContext(
      db,
      { owner_kind: "project", owner_id: "alpha", title: "Notes", content_md: "secret-ish body\n" },
      actor,
    );

    const r = await runAuditExport(env);
    expect(r).toMatchObject({ status: "committed", via: "git-data", events: 2 });
    expect(gh.commitCount()).toBe(1);
    const c = gh.commits.get(gh.head)!;
    expect(c.message).toMatch(/^audit: 2 events \(\d+-\d+\)$/);

    const snap = JSON.parse(gh.files().get("snapshot/projects.json")!);
    expect(snap.projects.map((p: { id: string }) => p.id)).toEqual(["alpha"]);
    expect(snap.projects[0].context_docs[0]).toMatchObject({ slug: "notes", bytes: 16 });
    expect(JSON.stringify(snap)).not.toContain("secret-ish body"); // no context content in the snapshot

    const file = gh.files().get("context/alpha/project-alpha/notes.md")!;
    expect(file).toContain(`id: ${doc.id}`);
    expect(file.endsWith("---\n\nsecret-ish body\n")).toBe(true);

    const lines = jsonl(month());
    expect(lines.map((l) => l.entity)).toEqual(["project", "context_doc"]);
    expect(await meta("last_export_event_id")).toBe(String(lines[1].id));
    expect(await meta("last_export_commit")).toBe(gh.head);
    expect(gh.calls.every((x) => x.auth === "Bearer test-audit-token")).toBe(true);

    // Second run without new events: no GitHub traffic at all.
    gh.calls = [];
    expect((await runAuditExport(env)).status).toBe("noop");
    expect(gh.calls).toHaveLength(0);
  });

  it("updates changed docs, removes deleted and cascaded ones, appends events without duplicates", async () => {
    await createProject(db, { id: "alpha", title: "Alpha" }, actor);
    await createProject(db, { id: "beta", title: "Beta" }, actor);
    const a = await writeContext(db, { owner_kind: "project", owner_id: "alpha", title: "A", content_md: "v1" }, actor);
    await writeContext(db, { owner_kind: "project", owner_id: "alpha", title: "B", content_md: "b" }, actor);
    await writeContext(db, { owner_kind: "project", owner_id: "beta", title: "C", content_md: "c" }, actor);
    await runAuditExport(env);
    expect([...gh.files().keys()].filter((p) => p.startsWith("context/")).sort()).toEqual([
      "context/alpha/project-alpha/a.md",
      "context/alpha/project-alpha/b.md",
      "context/beta/project-beta/c.md",
    ]);
    const before = jsonl(month()).length;

    await writeContext(db, { owner_kind: "project", owner_id: "alpha", title: "A", slug: "a", content_md: "v2", replace: true }, actor);
    const b = await db.prepare("SELECT id FROM context_doc WHERE slug = 'b'").first<{ id: string }>();
    await deleteContext(db, b!.id, actor);
    await deleteEntity(db, "project", "beta", actor); // cascades doc c without a context_doc event
    await runAuditExport(env);

    expect(gh.files().get("context/alpha/project-alpha/a.md")).toContain("version: 2");
    expect(gh.files().get("context/alpha/project-alpha/a.md")!.endsWith("v2\n")).toBe(true);
    expect(gh.files().has("context/alpha/project-alpha/b.md")).toBe(false);
    expect(gh.files().has("context/beta/project-beta/c.md")).toBe(false);
    expect(a.id).toBeTruthy();

    const lines = jsonl(month());
    expect(lines.length).toBeGreaterThan(before);
    const ids = lines.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((x, y) => x - y)).toEqual(ids);

    // Meta lost after a successful commit: the re-run must not duplicate event lines.
    await db.prepare("DELETE FROM meta").run();
    await runAuditExport(env);
    const again = jsonl(month()).map((l) => l.id);
    expect(again).toEqual(ids);
  });

  it("re-fetches the head and retries once on 422", async () => {
    await createProject(db, { id: "alpha", title: "Alpha" }, actor);
    gh.failRefOnce = 422;
    const r = await runAuditExport(env);
    expect(r).toMatchObject({ status: "committed", via: "git-data" });
    expect(gh.files().get("other.txt")).toBe("x"); // the concurrent commit survives
    expect(gh.files().has("snapshot/projects.json")).toBe(true);
  });

  it("falls back to the Contents API when the Git Data API fails", async () => {
    await createProject(db, { id: "alpha", title: "Alpha" }, actor);
    await writeContext(db, { owner_kind: "project", owner_id: "alpha", title: "Ümlaut näme", content_md: "Grüße — ✓\n" }, actor);
    gh.failTrees = 500;
    const r = await runAuditExport(env);
    expect(r).toMatchObject({ status: "committed", via: "contents", files: 3 });
    expect(gh.files().get("context/alpha/project-alpha/uemlaut-naeme.md")!.endsWith("Grüße — ✓\n")).toBe(true);
    expect(jsonl(month())).toHaveLength(2);
  });

  it("leaves meta unchanged when GitHub rejects the token", async () => {
    await createProject(db, { id: "alpha", title: "Alpha" }, actor);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 401 }));
    await expect(runAuditExport(env)).rejects.toThrow(/401/);
    expect(await meta("last_export_event_id")).toBeUndefined();
  });

  it("exports at most MAX_EVENTS_PER_RUN events per run", async () => {
    await createProject(db, { id: "alpha", title: "Alpha" }, actor);
    const stmts = Array.from({ length: MAX_EVENTS_PER_RUN + 5 }, (_, i) =>
      db
        .prepare("INSERT INTO event (ts, actor, project_id, entity, entity_id, action) VALUES (?, ?, 'alpha', 'project', 'alpha', 'touch')")
        .bind(new Date().toISOString(), `t${i}`),
    );
    await db.batch(stmts);
    expect((await runAuditExport(env)) as { events: number }).toMatchObject({ events: MAX_EVENTS_PER_RUN });
    expect((await runAuditExport(env)) as { events: number }).toMatchObject({ events: 6 });
  });

  it("POST /api/audit/run runs the export for a logged-in user", async () => {
    await installTestKeys();
    await createProject(db, { id: "alpha", title: "Alpha" }, actor);
    const res = await call("/api/audit/run", { method: "POST", jwt: await userJwt() });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: "committed" });
  });
});

describe("snapshot", () => {
  it("includes milestones with their links", async () => {
    const p = await createProject(env.DB, { title: "Snap MS" }, "user:t@example.com");
    const w = await upsertWorkpackage(env.DB, p.id, { title: "w" }, "user:t@example.com");
    await upsertMilestone(env.DB, p.id, { title: "Snap M", requires: [w.id] }, "user:t@example.com");
    const snap = JSON.parse(await buildSnapshot(env.DB));
    const proj = snap.projects.find((x: { id: string }) => x.id === p.id);
    expect(proj.milestones).toMatchObject([{ title: "Snap M", requires: [w.id], unlocks: [] }]);
  });
});

describe("audit is optional", () => {
  it("audit: scheduled run is a no-op when not configured", async () => {
    const { createExecutionContext, createScheduledController, waitOnExecutionContext } = await import("cloudflare:test");
    const worker = (await import("../src/index")).default;
    await createProject(db, { title: "Audit pending" }, actor); // unexported events exist
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 404 }));
    const ctx = createExecutionContext();
    worker.scheduled(createScheduledController(), { ...env, AUDIT_REPO: "" }, ctx);
    await waitOnExecutionContext(ctx);
    expect(spy).not.toHaveBeenCalled();
  });

  it("audit: manual run returns 409 when not configured", async () => {
    await installTestKeys();
    const res = await call("/api/audit/run", { method: "POST", jwt: await userJwt(), envOverride: { AUDIT_GITHUB_TOKEN: "" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "conflict", message: "audit not configured" });
  });
});
