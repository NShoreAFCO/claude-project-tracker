import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { call, installTestKeys, serviceJwt, userJwt } from "./helpers";

let jwt: string;
beforeAll(async () => {
  await installTestKeys();
  jwt = await userJwt();
});

const api = async (path: string, init: RequestInit = {}) => {
  const res = await call(path, { ...init, jwt, headers: { "Content-Type": "application/json", ...(init.headers as object) } });
  const ct = res.headers.get("Content-Type") ?? "";
  return { status: res.status, headers: res.headers, body: ct.includes("json") ? ((await res.json()) as any) : await res.text() };
};
const post = (path: string, body: unknown, method = "POST") => api(path, { method, body: JSON.stringify(body) });

async function hmac(body: string, secret = "test-webhook-secret"): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...sig].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
const gh = async (event: string, payload: unknown, sig?: string) => {
  const body = JSON.stringify(payload);
  return call("/webhooks/github", {
    method: "POST",
    body,
    headers: { "X-GitHub-Event": event, "X-Hub-Signature-256": sig ?? (await hmac(body)), "Content-Type": "application/json" },
  });
};

describe("REST CRUD", () => {
  it("project create / list / detail / patch with conflict", async () => {
    const c = await post("/api/projects", { title: "REST Projekt", tags: ["x"] });
    expect(c.status).toBe(201);
    expect(c.body.id).toBe("rest-projekt");
    expect((await api("/api/projects")).body.some((p: any) => p.id === "rest-projekt")).toBe(true);
    const p1 = await post("/api/projects/rest-projekt", { summary: "eins", expected_version: 1 }, "PATCH");
    expect(p1.status).toBe(200);
    const stale = await post("/api/projects/rest-projekt", { summary: "zwei", expected_version: 1 }, "PATCH");
    expect(stale.status).toBe(409);
    expect(stale.body.current.summary).toBe("eins");
    const d = await api("/api/projects/rest-projekt");
    expect(d.body.project.version).toBe(2);
  });
  it("milestones: create, list, patch with conflict, delete", async () => {
    await post("/api/projects", { title: "REST MS" });
    const w = await post("/api/workpackages", { project_id: "rest-ms", title: "W" });
    const c = await post("/api/milestones", { project_id: "rest-ms", title: "M", requires: [w.body.id] });
    expect(c.status).toBe(201);
    expect(c.body.requires).toEqual([w.body.id]);
    expect((await api("/api/milestones?project_id=rest-ms")).body.map((m: any) => m.id)).toEqual([c.body.id]);
    const p1 = await post(`/api/milestones/${c.body.id}`, { project_id: "rest-ms", due_date: "2027-03-01", expected_version: 1 }, "PATCH");
    expect([p1.status, p1.body.due_date]).toEqual([200, "2027-03-01"]);
    const stale = await post(`/api/milestones/${c.body.id}`, { project_id: "rest-ms", title: "x", expected_version: 1 }, "PATCH");
    expect(stale.status).toBe(409);
    expect((await api(`/api/milestones/${c.body.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await api("/api/projects/rest-ms")).body.milestones).toEqual([]);
  });

  it("invalid input → 400, unknown → 404, wrong method → 405", async () => {
    expect((await post("/api/projects", { title: "" })).status).toBe(400);
    expect((await api("/api/projects/nope")).status).toBe(404);
    expect((await api("/api/projects/rest-projekt", { method: "PUT", body: "{}" })).status).toBe(405);
    expect((await api("/api/projects", { method: "POST", body: "[1,2]" })).status).toBe(400);
  });
  it("workpackages: create, sub-WP, patch", async () => {
    const parent = await post("/api/workpackages", { project_id: "rest-projekt", title: "Haupt" });
    expect(parent.status).toBe(201);
    const sub = await post("/api/workpackages", { project_id: "rest-projekt", title: "Unter", parent_id: parent.body.id });
    expect(sub.body.parent_id).toBe(parent.body.id);
    const patched = await post(
      `/api/workpackages/${sub.body.id}`,
      { project_id: "rest-projekt", progress: 40, expected_version: 1 },
      "PATCH",
    );
    expect(patched.body.progress).toBe(40);
  });
});

describe("context via REST", () => {
  let wp: string;
  beforeAll(async () => {
    await post("/api/projects", { title: "Ctx Projekt" });
    wp = (await post("/api/workpackages", { project_id: "ctx-projekt", title: "Sub" })).body.id;
  });

  const upload = (files: Array<[string, string | Uint8Array]>, extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set("owner_kind", "workpackage");
    fd.set("owner_id", wp);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    for (const [name, content] of files) fd.append("files", new File([content], name));
    return call("/api/context/upload", { method: "POST", body: fd, jwt }).then(async (r) => ({
      status: r.status,
      body: (await r.json()) as any,
    }));
  };

  it("uploads 3 .md files at once; rejects other types and invalid UTF-8 per file", async () => {
    const r = await upload([
      ["a.md", "# A"],
      ["b.markdown", "# B"],
      ["c.txt", "C"],
      ["evil.exe", "MZ"],
      ["bad.md", new Uint8Array([0xff, 0xfe, 0x00])],
    ]);
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: any) => x.ok)).toEqual([true, true, true, false, false]);
    expect(r.body.results[0].doc).toMatchObject({ slug: "a", source: "upload", filename: "a.md" });
  });
  it("same filename → -2 suffix; replace=true overwrites", async () => {
    const again = await upload([["a.md", "# A2"]]);
    expect(again.body.results[0].doc.slug).toBe("a-2");
    const rep = await upload([["a.md", "# A3"]], { replace: "true" });
    expect(rep.body.results[0].doc).toMatchObject({ slug: "a", version: 2 });
  });
  it("paste, then bundle as markdown download", async () => {
    const p = await post("/api/context", { owner_kind: "workpackage", owner_id: wp, title: "Notiz", content_md: "Eingefügter Text" });
    expect(p.status).toBe(201);
    expect(p.body.source).toBe("paste");
    const b = await api(`/api/context/bundle?project_id=ctx-projekt&workpackage_id=${wp}&format=md`);
    expect(b.headers.get("Content-Type")).toContain("text/markdown");
    expect(b.headers.get("Content-Disposition")).toContain("attachment");
    expect(b.body).toContain("Eingefügter Text");
    expect(b.body).toContain("# A3");
  });
  it("edit with version check, revisions and restore", async () => {
    const list = (await api(`/api/context?owner_kind=workpackage&owner_id=${wp}`)).body;
    const doc = list.find((d: any) => d.slug === "notiz");
    expect((await post(`/api/context/${doc.id}`, { content_md: "neu", expected_version: 1 }, "PUT")).status).toBe(200);
    expect((await post(`/api/context/${doc.id}`, { content_md: "zu alt", expected_version: 1 }, "PUT")).status).toBe(409);
    const revs = (await api(`/api/context/${doc.id}/revisions`)).body;
    expect(revs).toHaveLength(1);
    expect((await api(`/api/context/revisions/${revs[0].id}`)).body.content_md).toBe("Eingefügter Text");
    const r = await post(`/api/context/${doc.id}/restore`, { revision_id: revs[0].id, expected_version: 2 });
    expect(r.body.content_md).toBe("Eingefügter Text");
    const ap = await post(`/api/context/${doc.id}/append`, { text: "Nachtrag", heading: "Update" });
    expect(ap.body.content_md).toContain("Nachtrag");
    const pin = await post(`/api/context/${doc.id}`, { pinned: true }, "PATCH");
    expect(pin.body.pinned).toBe(1);
  });
});

describe("GitHub webhook", () => {
  beforeAll(async () => {
    await post("/api/projects", { id: "webapp-test", title: "Web App Test", repo_url: "https://github.com/example-org/web-app" });
  });
  const repo = { full_name: "example-org/web-app", html_url: "https://github.com/example-org/web-app", default_branch: "main" };

  it("bad signature → 401 before parsing (even with invalid JSON)", async () => {
    const res = await call("/webhooks/github", {
      method: "POST",
      body: "{not json",
      headers: { "X-GitHub-Event": "push", "X-Hub-Signature-256": "sha256=" + "0".repeat(64) },
    });
    expect(res.status).toBe(401);
    const wrongSecret = await gh("ping", { zen: "x" }, await hmac(JSON.stringify({ zen: "x" }), "other-secret"));
    expect(wrongSecret.status).toBe(401);
    const malformed = await gh("ping", {}, "sha256=xyz");
    expect(malformed.status).toBe(401);
  });
  it("ping → 200", async () => {
    expect((await gh("ping", { zen: "hi", repository: repo })).status).toBe(200);
  });
  it("push to a feature branch creates/updates the branch; PR merged sets status", async () => {
    await gh("push", {
      ref: "refs/heads/fix/x",
      repository: repo,
      head_commit: { id: "abcdef1234", message: "Fix X\n\nbody", timestamp: "2026-10-20T10:00:00Z" },
    });
    await gh("pull_request", {
      action: "opened",
      repository: repo,
      pull_request: {
        number: 6,
        html_url: "https://github.com/example-org/web-app/pull/6",
        merged: false,
        head: { ref: "fix/x" },
        base: { ref: "main" },
      },
    });
    await gh("pull_request", {
      action: "closed",
      repository: repo,
      pull_request: { number: 6, merged: true, head: { ref: "fix/x" }, base: { ref: "main" } },
    });
    await gh("delete", { ref: "fix/x", ref_type: "branch", repository: repo });
    const d = (await api("/api/projects/webapp-test")).body;
    const b = d.branches.find((x: any) => x.name === "fix/x");
    expect(b).toMatchObject({ repo: "example-org/web-app", status: "merged", pr_number: 6, last_commit: "abcdef1 Fix X", base: "main" });
  });
  it("push stores last_activity as UTC even when GitHub sends a local offset", async () => {
    await gh("push", {
      ref: "refs/heads/fix/tz",
      repository: repo,
      head_commit: { id: "aaaaaaa1", message: "tz", timestamp: "2026-10-22T11:29:03+02:00" },
    });
    await gh("push", {
      ref: "refs/heads/fix/tz-bad",
      repository: repo,
      head_commit: { id: "aaaaaaa2", message: "x", timestamp: "garbage" },
    });
    const d = (await api("/api/projects/webapp-test")).body;
    expect(d.branches.find((x: any) => x.name === "fix/tz").last_activity).toBe("2026-10-22T09:29:03.000Z");
    expect(d.branches.find((x: any) => x.name === "fix/tz-bad").last_activity).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
  it("push to the default branch logs an event but creates no branch row", async () => {
    await gh("push", { ref: "refs/heads/main", repository: repo, head_commit: { id: "1234567", message: "merge" } });
    const d = (await api("/api/projects/webapp-test")).body;
    expect(d.branches.some((x: any) => x.name === "main")).toBe(false);
    expect(d.events.some((e: any) => e.action === "push")).toBe(true);
  });
  it("unmatched repo goes to the inbox and can be assigned", async () => {
    const r = await gh("create", {
      ref: "x",
      ref_type: "branch",
      repository: { full_name: "someone/else", html_url: "https://github.com/someone/else" },
    });
    expect(((await r.json()) as any).matched).toBeNull();
    const inbox = (await api("/api/inbox")).body;
    const item = inbox.find((e: any) => e.entity_id === "someone/else");
    expect(item).toBeTruthy();
    expect((await post(`/api/inbox/${item.id}/assign`, { project_id: "webapp-test" })).status).toBe(200);
    expect((await api("/api/inbox")).body.some((e: any) => e.id === item.id)).toBe(false);
  });
});

describe("Claude Code hook", () => {
  beforeAll(async () => {
    await post("/api/projects", {
      id: "hook-repo",
      title: "Hook Repo",
      repo_url: "https://github.com/example-org/admin-tool",
      local_path: "C:\\Users\\jane\\Documents\\Devel\\admin-tool",
    });
    await post("/api/projects", {
      id: "hook-local",
      title: "Hook Local",
      local_path: "C:\\Users\\jane\\Documents\\Devel\\animation",
    });
  });
  const hook = async (body: unknown, token?: string) => {
    const res = await call("/api/hooks/claude-code", { method: "POST", body: JSON.stringify(body), jwt: token ?? (await serviceJwt()) });
    return { status: res.status, body: (await res.json()) as any };
  };

  it("matches by repo_url (ssh form, .git); nested path → worktree; syncs session.md", async () => {
    const r = await hook({
      session_id: "s-1",
      cwd: "C:\\Users\\jane\\Documents\\Devel\\admin-tool\\feature\\export",
      repo_url: "git@github.com:example-org/admin-tool.git",
      branch: "feature/export",
      last_commit: "Add export",
      reason: "prompt_input_exit",
      context_file: { name: "session.md", content: "# Session\nstate" },
    });
    expect(r.status).toBe(200);
    expect(r.body.matched).toBe("hook-repo");
    const d = (await api("/api/projects/hook-repo")).body;
    expect(d.project.session_id).toBe("s-1");
    expect(d.branches[0]).toMatchObject({
      repo: "example-org/admin-tool",
      name: "feature/export",
      kind: "worktree",
      last_commit: "Add export",
    });
    expect(d.context_index.find((c: any) => c.slug === "session-md")).toMatchObject({ source: "sync", version: 1 });
  });
  it("unchanged session.md does not create a new version; worktree flag overrides the path heuristic", async () => {
    const r = await hook({
      session_id: "s-2",
      cwd: "c:/users/jane/documents/devel/admin-tool/src",
      repo_url: "https://github.com/example-org/admin-tool",
      branch: "develop",
      worktree: false,
      context_file: { name: "session.md", content: "# Session\nstate" },
    });
    expect(r.body.context_file).toBe("unchanged");
    const d = (await api("/api/projects/hook-repo")).body;
    expect(d.branches.find((b: any) => b.name === "develop").kind).toBe("branch");
  });
  it("creates no branch row for the default branch (like the webhook), but still logs the session", async () => {
    const r1 = await hook({
      session_id: "s-5",
      cwd: "C:/Users/jane/Documents/Devel/admin-tool",
      repo_url: "https://github.com/example-org/admin-tool",
      branch: "trunk",
      default_branch: "trunk",
    });
    expect(r1.body.matched).toBe("hook-repo");
    expect(r1.body.branch_id).toBeUndefined();
    // no origin/HEAD known: main and master count as default
    const r2 = await hook({ session_id: "s-6", cwd: "C:/Users/jane/Documents/Devel/animation", branch: "master" });
    expect(r2.body.matched).toBe("hook-local");
    expect(r2.body.branch_id).toBeUndefined();
    // a worktree is always tracked, even on a branch named main
    const r3 = await hook({
      session_id: "s-7",
      cwd: "C:/Users/jane/Documents/Devel/admin-tool/wt",
      repo_url: "https://github.com/example-org/admin-tool",
      branch: "main",
      worktree: true,
    });
    expect(r3.body.branch_id).toBeTruthy();
    const d = (await api("/api/projects/hook-repo")).body;
    expect(d.project.session_id).toBe("s-7");
    expect(d.branches.some((b: any) => b.name === "trunk")).toBe(false);
  });
  it("matches by local_path (case-insensitive, slashes normalised) when there is no remote", async () => {
    const r = await hook({
      session_id: "s-3",
      cwd: "c:/USERS/jane/Documents/Devel/animation",
      branch: "v2-visual-overhaul",
    });
    expect(r.body.matched).toBe("hook-local");
    const d = (await api("/api/projects/hook-local")).body;
    expect(d.branches[0]).toMatchObject({ repo: "local:animation", kind: "branch" });
  });
  it("unmatched → inbox; service token can not read other APIs", async () => {
    const r = await hook({ session_id: "s-4", cwd: "D:\\elsewhere", reason: "other" });
    expect(r.body.matched).toBeNull();
    expect((await api("/api/inbox")).body.some((e: any) => e.entity_id === "s-4")).toBe(true);
    const svc = await call("/api/inbox", { jwt: await serviceJwt() });
    expect(svc.status).toBe(403);
  });
});
