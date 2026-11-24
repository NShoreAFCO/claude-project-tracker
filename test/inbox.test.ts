// Inbox triage: migration 0008, dismiss and restore, folder rules, rule matching in the session hook.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { call, installTestKeys, serviceJwt, testCaller, userJwt } from "./helpers";
import { createProject } from "../src/data/projects";
import { ensureUserPerson } from "../src/data/persons";
import { TOOL_ACTIONS } from "../src/auth/permissions";
import { mcpApiHandler } from "../src/mcp/server";
import type { Env, Role } from "../src/types";

const db = env.DB;
const SYS = testCaller();
const VIEWER = "inbox-viewer@example.com";
const EDITOR = "inbox-editor@example.com";
const envOverride = { ALLOWED_EMAILS: ["user@example.com", VIEWER, EDITOR].join(",") };

async function setRole(addr: string, role: Role): Promise<void> {
  const p = await ensureUserPerson(db, addr);
  await db.prepare("UPDATE person SET access_role = ? WHERE id = ?").bind(role, p.id).run();
}
const rest = async (addr: string, method: string, path: string, body?: unknown) => {
  const res = await call(path, {
    method,
    jwt: await userJwt(addr),
    envOverride,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: json, text };
};
const ed = (method: string, path: string, body?: unknown) => rest(EDITOR, method, path, body);
const hook = async (body: Record<string, unknown>) => {
  const res = await call("/api/hooks/claude-code", { method: "POST", jwt: await serviceJwt(), body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};

/** An unassigned event straight into the table (entity hook or webhook). */
async function seed(cwd: string, entity: "hook" | "webhook" = "hook", action = "unmatched"): Promise<number> {
  const diff = entity === "hook" ? { hook: [null, { session_id: "s", cwd, reason: "exit" }] } : { github: [null, { repo: "x/y" }] };
  const r = await db
    .prepare("INSERT INTO event (ts, actor, entity, entity_id, action, summary, diff_json) VALUES (?, 'svc', ?, 's', ?, ?, ?)")
    .bind(new Date().toISOString(), entity, action, `ended in ${cwd}`, JSON.stringify(diff))
    .run();
  return Number(r.meta.last_row_id);
}
const ev = (id: number) => db.prepare("SELECT * FROM event WHERE id = ?").bind(id).first<any>();
const count = async () => (await ed("GET", "/api/inbox/count")).body.open as number;

async function mcpTool(addr: string, name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> {
  const ctx = createExecutionContext() as ExecutionContext & { props?: unknown };
  ctx.props = { email: addr, clientName: "Claude" };
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
    { ...env, ...envOverride } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const raw = await res.text();
  const line = raw.startsWith("{") ? raw : raw.split("\n").find((l) => l.startsWith("data: "))!.slice(6);
  const result = JSON.parse(line).result as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: result.isError, text: result.content[0].text };
}

beforeAll(async () => {
  await installTestKeys();
  await setRole(VIEWER, "viewer");
  await setRole(EDITOR, "editor");
});

describe("migration 0008", () => {
  it("creates inbox_rule with its CHECKs and UNIQUE(path), and the inbox index", async () => {
    const t = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inbox_rule'").first<any>();
    expect(t?.sql).toMatch(/UNIQUE/);
    const idx = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'event_inbox'").first<any>();
    expect(idx?.name).toBe("event_inbox");
    const p = await createProject(db, { title: "Inbox schema", owner: "Owner" }, SYS);
    const ins = (id: string, kind: string, path: string, project: string | null) =>
      db
        .prepare("INSERT INTO inbox_rule (id, kind, path, project_id, created_at, created_by) VALUES (?, ?, ?, ?, '2026-01-01', 't')")
        .bind(id, kind, path, project)
        .run();
    await expect(ins("s1", "assign", "/schema/a", null)).rejects.toThrow();
    await expect(ins("s2", "ignore", "/schema/b", p.id)).rejects.toThrow();
    await expect(ins("s3", "other", "/schema/c", null)).rejects.toThrow();
    await ins("s4", "ignore", "/schema/d", null);
    await ins("s5", "assign", "/schema/e", p.id);
    await expect(ins("s6", "ignore", "/schema/d", null)).rejects.toThrow();
    await db.prepare("DELETE FROM inbox_rule WHERE id IN ('s4', 's5')").run();
  });
});

describe("dismiss and restore", () => {
  it("dismisses open events only, counts each once, and the count follows", async () => {
    const a = await seed("/dm/a");
    const b = await seed("/dm/b");
    const w = await seed("", "webhook");
    const p = await createProject(db, { title: "Inbox dm", owner: "Owner" }, SYS);
    const projEv = (await db.prepare("SELECT id FROM event WHERE project_id = ? LIMIT 1").bind(p.id).first<any>()).id;
    const before = await count();
    const r = await ed("POST", "/api/inbox/dismiss", { ids: [a, b, w, projEv, a] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ dismissed: 3 });
    expect(await count()).toBe(before - 3);
    expect((await ev(a)).action).toBe("dismissed");
    expect((await ev(projEv)).action).not.toBe("dismissed");
    expect((await ed("POST", "/api/inbox/dismiss", { ids: [a] })).body).toEqual({ dismissed: 0 });
    const audit = await db.prepare("SELECT * FROM event WHERE entity = 'inbox' AND action = 'dismiss' ORDER BY id DESC LIMIT 1").first<any>();
    expect(audit.project_id).toBeNull();
    expect(JSON.parse(audit.diff_json).ids[1]).toEqual([a, b, w].sort((x, y) => x - y));
    // Audit rows are never inbox rows.
    const open = (await ed("GET", "/api/inbox?limit=500")).body as any[];
    expect(open.some((e) => e.entity === "inbox")).toBe(false);
    expect(open.some((e) => e.id === a)).toBe(false);
  });

  it("refuses bad id lists and viewers", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => i + 1);
    expect((await ed("POST", "/api/inbox/dismiss", { ids })).status).toBe(400);
    expect((await ed("POST", "/api/inbox/dismiss", { ids: [] })).status).toBe(400);
    expect((await ed("POST", "/api/inbox/dismiss", { ids: ["1"] })).status).toBe(400);
    expect((await ed("POST", "/api/inbox/restore", { ids: [0] })).status).toBe(400);
    expect((await ed("POST", "/api/inbox/dismiss", {})).status).toBe(400);
    const a = await seed("/dm/viewer");
    expect((await rest(VIEWER, "POST", "/api/inbox/dismiss", { ids: [a] })).status).toBe(403);
    expect((await rest(VIEWER, "POST", "/api/inbox/restore", { ids: [a] })).status).toBe(403);
    expect((await ev(a)).action).toBe("unmatched");
    // Viewers read the list and the count.
    expect((await rest(VIEWER, "GET", "/api/inbox/count")).status).toBe(200);
    expect((await rest(VIEWER, "GET", "/api/inbox?state=dismissed")).status).toBe(200);
  });

  it("restores dismissed and ignored rows; state=dismissed lists both; limit and state are checked", async () => {
    const a = await seed("/rs/a");
    const c = await seed("/rs/c", "hook", "ignored");
    await ed("POST", "/api/inbox/dismiss", { ids: [a] });
    const dis = (await ed("GET", "/api/inbox?state=dismissed&limit=500")).body as any[];
    expect(dis.some((e) => e.id === a && e.action === "dismissed")).toBe(true);
    expect(dis.some((e) => e.id === c && e.action === "ignored")).toBe(true);
    const before = await count();
    const r = await ed("POST", "/api/inbox/restore", { ids: [a, c] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ restored: 2 });
    expect(await count()).toBe(before + 2);
    const open = (await ed("GET", "/api/inbox?limit=500")).body as any[];
    expect(open.some((e) => e.id === a) && open.some((e) => e.id === c)).toBe(true);
    expect((await ed("POST", "/api/inbox/restore", { ids: [a] })).body).toEqual({ restored: 0 });
    expect(((await ed("GET", "/api/inbox?limit=1")).body as any[]).length).toBe(1);
    expect((await ed("GET", "/api/inbox?state=bogus")).status).toBe(400);
  });
});

describe("folder rules", () => {
  it("viewers can neither list nor create rules", async () => {
    expect((await rest(VIEWER, "GET", "/api/inbox/rules")).status).toBe(403);
    expect((await rest(VIEWER, "POST", "/api/inbox/rules", { kind: "ignore", path: "/v/x" })).status).toBe(403);
    expect((await ed("GET", "/api/inbox/rules")).status).toBe(200);
  });

  it("an ignore rule applies to the folder and below, not to a sibling with a common prefix, nor to webhook rows", async () => {
    const inside = await seed("c:/a/b");
    const below = await seed("C:\\A\\B\\sub");
    const sibling = await seed("c:/a/bc");
    const web = await seed("", "webhook");
    const before = await count();
    const r = await ed("POST", "/api/inbox/rules", { kind: "ignore", path: "C:\\A\\B\\" });
    expect(r.status).toBe(201);
    expect(r.body.applied).toBe(2);
    expect(r.body.rule).toMatchObject({ kind: "ignore", path: "c:/a/b", project_id: null });
    expect((await ev(inside)).action).toBe("ignored");
    expect((await ev(below)).action).toBe("ignored");
    expect((await ev(sibling)).action).toBe("unmatched");
    expect((await ev(web)).action).toBe("unmatched");
    expect(await count()).toBe(before - 2);
    // Same folder in another spelling: 409 naming the existing rule.
    const dup = await ed("POST", "/api/inbox/rules", { kind: "ignore", path: "c:/A/b" });
    expect(dup.status).toBe(409);
    expect(dup.body.message).toContain(r.body.rule.id);
    // The audit row keeps the folder from viewers.
    const audit = await db.prepare("SELECT * FROM event WHERE entity = 'inbox' AND action = 'rule_create' AND entity_id = ?").bind(r.body.rule.id).first<any>();
    expect(audit.project_id).toBeNull();
    expect(await (await rest(VIEWER, "GET", "/api/events?limit=200")).text).not.toContain("c:/a/b");
  });

  it("refuses empty, relative and too broad paths, an unknown project and kind mismatches", async () => {
    for (const path of ["", "   ", "foo/bar", "./x", "c:", "c:\\", "/"]) expect((await ed("POST", "/api/inbox/rules", { kind: "ignore", path })).status).toBe(400);
    expect((await ed("POST", "/api/inbox/rules", { kind: "ignore", path: `/${"x".repeat(500)}` })).status).toBe(400);
    expect((await ed("POST", "/api/inbox/rules", { kind: "drop", path: "/k/x" })).status).toBe(400);
    expect((await ed("POST", "/api/inbox/rules", { kind: "assign", path: "/k/x" })).status).toBe(400);
    expect((await ed("POST", "/api/inbox/rules", { kind: "assign", path: "/k/x", project_id: "no-such-project" })).status).toBe(404);
    const p = await createProject(db, { title: "Inbox kind", owner: "Owner" }, SYS);
    expect((await ed("POST", "/api/inbox/rules", { kind: "ignore", path: "/k/x", project_id: p.id })).status).toBe(400);
    expect((await ed("POST", "/api/inbox/rules", { kind: "ignore", path: "/k/x", apply_existing: "yes" })).status).toBe(400);
  });

  it("an assign rule moves matching old hook events to the project; apply_existing false leaves them; list and delete", async () => {
    const p = await createProject(db, { title: "Inbox assign target", owner: "Owner" }, SYS);
    const old = await seed("/srv/proj/x");
    const r = await ed("POST", "/api/inbox/rules", { kind: "assign", path: "/srv/proj", project_id: p.id });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ applied: 1, rule: { kind: "assign", project_id: p.id, project_title: "Inbox assign target" } });
    expect(await ev(old)).toMatchObject({ project_id: p.id, action: "assigned" });

    const keep = await seed("/srv/keep/y");
    const r2 = await ed("POST", "/api/inbox/rules", { kind: "ignore", path: "/srv/keep", apply_existing: false });
    expect(r2.body.applied).toBe(0);
    expect((await ev(keep)).action).toBe("unmatched");

    const list = (await ed("GET", "/api/inbox/rules")).body as any[];
    expect(list.find((x) => x.id === r.body.rule.id)).toMatchObject({ path: "/srv/proj", project_title: "Inbox assign target" });
    expect(list.some((x) => x.id === r2.body.rule.id)).toBe(true);

    const del = await ed("DELETE", `/api/inbox/rules/${r2.body.rule.id}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });
    expect((await ed("DELETE", `/api/inbox/rules/${r2.body.rule.id}`)).status).toBe(404);
    expect(((await ed("GET", "/api/inbox/rules")).body as any[]).some((x) => x.id === r2.body.rule.id)).toBe(false);
    expect(await db.prepare("SELECT 1 FROM event WHERE entity = 'inbox' AND action = 'rule_delete' AND entity_id = ?").bind(r2.body.rule.id).first()).toBeTruthy();
  });
});

describe("rule matching in the session hook", () => {
  let assignTarget: string;
  let assignRule: string;
  beforeAll(async () => {
    assignTarget = (await createProject(db, { title: "Hook rule target", owner: "Owner" }, SYS)).id;
    await createProject(db, { title: "Hook real path", owner: "Owner", local_path: "D:/hk/real" }, SYS);
    await createProject(db, { title: "Hook real repo", owner: "Owner", repo_url: "https://github.com/example/hk-repo" }, SYS);
    expect((await ed("POST", "/api/inbox/rules", { kind: "ignore", path: "d:/hk" })).status).toBe(201);
    assignRule = (await ed("POST", "/api/inbox/rules", { kind: "assign", path: "d:/hk/assigned", project_id: assignTarget })).body.rule.id;
  });

  it("an ignore rule gives an ignored row (rule in the diff) and no badge count; Windows cwd matches", async () => {
    const before = await count();
    const r = await hook({ session_id: "hk-ign", cwd: "D:\\HK\\Ignored\\Sub", reason: "exit" });
    expect(r.body).toEqual({ ok: true, matched: null, ignored: true });
    expect(await count()).toBe(before);
    const row = await db.prepare("SELECT * FROM event WHERE entity = 'hook' AND entity_id = 'hk-ign'").first<any>();
    expect(row).toMatchObject({ action: "ignored", project_id: null });
    expect(row.summary).toBe("Claude Code session ended (exit) in D:\\HK\\Ignored\\Sub");
    const diff = JSON.parse(row.diff_json);
    expect(diff.hook[1]).toMatchObject({ session_id: "hk-ign", cwd: "D:\\HK\\Ignored\\Sub" });
    expect(diff.rule[0]).toBeNull();
    expect(typeof diff.rule[1]).toBe("string");
  });

  it("an assign rule (longest folder wins) logs a progress note on the project and links the branch", async () => {
    const r = await hook({ session_id: "hk-asg", cwd: "D:\\HK\\Assigned\\Deeper", branch: "feature-rule", reason: "exit" });
    expect(r.body).toMatchObject({ ok: true, matched: assignTarget, rule: assignRule });
    expect(r.body.branch_id).toBeTruthy();
    const d = (await ed("GET", `/api/projects/${assignTarget}`)).body;
    expect(d.branches.find((b: any) => b.name === "feature-rule")).toMatchObject({ kind: "branch" });
    expect(d.events.some((e: any) => /Claude Code session ended \(exit\) on feature-rule/.test(e.summary ?? ""))).toBe(true);
    expect(d.project.session_id).toBe("hk-asg");
    // worktree only from the body for rule matches
    const w = await hook({ session_id: "hk-asg2", cwd: "d:/hk/assigned/wt", branch: "wt-branch", worktree: true });
    expect(w.body.matched).toBe(assignTarget);
    const d2 = (await ed("GET", `/api/projects/${assignTarget}`)).body;
    expect(d2.branches.find((b: any) => b.name === "wt-branch")).toMatchObject({ kind: "worktree" });
  });

  it("a real repo_url or local_path match wins over a rule", async () => {
    const byPath = await hook({ session_id: "hk-real", cwd: "D:\\HK\\Real\\src" });
    expect(byPath.body.matched).toBeTruthy();
    expect(byPath.body.ignored).toBeUndefined();
    expect(byPath.body.rule).toBeUndefined();
    const byRepo = await hook({ session_id: "hk-repo", cwd: "d:/hk/assigned/x", repo_url: "git@github.com:example/hk-repo.git" });
    expect(byRepo.body.matched).not.toBe(assignTarget);
    expect(byRepo.body.matched).toBeTruthy();
    expect(byRepo.body.rule).toBeUndefined();
  });

  it("a rule to a trashed project falls through to unmatched", async () => {
    const p = await createProject(db, { title: "Hook trashed target", owner: "Owner" }, SYS);
    expect((await ed("POST", "/api/inbox/rules", { kind: "assign", path: "e:/hk2/trash", project_id: p.id })).status).toBe(201);
    await db.prepare("UPDATE project SET deleted_at = ? WHERE id = ?").bind(new Date().toISOString(), p.id).run();
    const before = await count();
    const r = await hook({ session_id: "hk-trash", cwd: "E:\\hk2\\trash" });
    expect(r.body).toEqual({ ok: true, matched: null });
    expect(await count()).toBe(before + 1);
    const row = await db.prepare("SELECT * FROM event WHERE entity = 'hook' AND entity_id = 'hk-trash'").first<any>();
    expect(row).toMatchObject({ action: "unmatched", project_id: null });
    expect(JSON.parse(row.diff_json).rule).toBeUndefined();
  });
});

describe("MCP unchanged", () => {
  it("has no inbox tool, and get_project shows no inbox audit rows", async () => {
    expect(Object.keys(TOOL_ACTIONS).filter((k) => /inbox|rule/.test(k))).toEqual([]);
    const p = await createProject(db, { title: "Inbox mcp", owner: "Owner" }, SYS);
    const old = await seed("/mcp/inbox/x");
    await ed("POST", "/api/inbox/rules", { kind: "assign", path: "/mcp/inbox", project_id: p.id });
    expect((await ev(old)).project_id).toBe(p.id);
    const r = await mcpTool(EDITOR, "get_project", { id: p.id, view: "full" });
    expect(r.isError).toBeFalsy();
    expect(r.text).not.toContain("rule_create");
  });
});
