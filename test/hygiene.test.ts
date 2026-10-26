// F12 upstream (release R5): target date rule on activation, internal fields hidden from viewers,
// worker-rendered OAuth pages localised server-side (spec §4.4).
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { call, installTestKeys, testCaller, userJwt } from "./helpers";
import { createProject, getProjectDetail, listProjects, updateProject } from "../src/data/projects";
import { ensureUserPerson } from "../src/data/persons";
import { mcpApiHandler } from "../src/mcp/server";
import { POLICY } from "../src/policy";
import { PROJECT_CATEGORIES } from "../src/data/categories";
import { ValidationError } from "../src/data/util";
import type { Env, Role } from "../src/types";

const db = env.DB;
const SYS = testCaller();
const VIEWER = "r52-viewer@example.com";
const EDITOR = "r52-editor@example.com";
const envOverride = { ALLOWED_EMAILS: ["user@example.com", VIEWER, EDITOR].join(",") };
const REQUIRED = () => POLICY.target_date_required_categories[0];
const INTERNAL = ["local_path", "session_id", "repo_url"] as const;
let n = 0;

async function setRole(addr: string, role: Role): Promise<void> {
  const p = await ensureUserPerson(db, addr);
  await db.prepare("UPDATE person SET access_role = ? WHERE id = ?").bind(role, p.id).run();
}

const rest = async (addr: string, method: string, path: string, body?: unknown) =>
  call(path, {
    method,
    jwt: await userJwt(addr),
    envOverride,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function mcpTool(addr: string, name: string, args: Record<string, unknown>): Promise<any> {
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
      body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }),
    }),
    { ...env, ...envOverride } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  const line = text.startsWith("{")
    ? text
    : text
        .split("\n")
        .find((l) => l.startsWith("data: "))!
        .slice(6);
  const result = JSON.parse(line).result as { isError?: boolean; content: Array<{ text: string }> };
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

beforeAll(async () => {
  await installTestKeys();
  await setRole(VIEWER, "viewer");
  await setRole(EDITOR, "editor");
});

describe("F12 target date rule (policy.target_date_required_categories)", () => {
  it("active in a required category without target date → 400; with warnings path on create per F1 compat", async () => {
    const cat = REQUIRED();
    expect(cat).toBeTruthy();
    // Explicit status active at creation fails.
    await expect(createProject(db, { title: "R52 explicit", owner: "Owner", category: cat, status: "active" }, SYS)).rejects.toThrow(
      ValidationError,
    );
    await expect(createProject(db, { title: "R52 explicit", owner: "Owner", category: cat, status: "active" }, SYS)).rejects.toThrow(
      /target_date/,
    );
    // Without a status: created as idea with a warning naming target_date (F1 creation compatibility).
    const idea = await createProject(db, { title: "R52 implicit", owner: "Owner", category: cat }, SYS);
    expect(idea.status).toBe("idea");
    expect(idea.warnings[0].code).toBe("ACTIVE_PRECONDITIONS_MISSING");
    expect(idea.warnings[0].fields).toEqual(["target_date"]);
    // Activation without a target date → 400 over REST.
    const res = await rest(EDITOR, "PATCH", `/api/projects/${idea.id}`, { status: "active" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/target_date/);
    // With the date (same patch) activation works.
    const ok = await updateProject(db, idea.id, { status: "active", target_date: "2027-03-31" }, SYS);
    expect(ok.status).toBe("active");
    // With a date at creation it starts active.
    const dated = await createProject(db, { title: "R52 dated", owner: "Owner", category: cat, target_date: "2027-01-31" }, SYS);
    expect(dated.status).toBe("active");
    expect(dated.warnings).toEqual([]);
  });

  it("bites only on activation: legacy active projects stay editable; other categories need no date", async () => {
    const cat = REQUIRED();
    const p = await createProject(db, { title: "R52 legacy", owner: "Owner", category: cat, target_date: "2027-01-31" }, SYS);
    await db.prepare("UPDATE project SET target_date = NULL WHERE id = ?").bind(p.id).run();
    const edited = await updateProject(db, p.id, { summary: "still editable" }, SYS);
    expect(edited.summary).toBe("still editable");
    const free = await createProject(db, { title: "R52 uncategorised", owner: "Owner" }, SYS);
    expect(free.status).toBe("active");
    const other = PROJECT_CATEGORIES.find((k) => !POLICY.target_date_required_categories.includes(k));
    if (other) {
      const o = await createProject(db, { title: "R52 other", owner: "Owner", category: other, status: "active" }, SYS);
      expect(o.status).toBe("active");
    }
  });

  it("project language is validated against policy.locales", async () => {
    await expect(createProject(db, { title: "R52 lang", owner: "Owner", language: "xx" }, SYS)).rejects.toThrow(/language/);
    const p = await createProject(db, { title: "R52 lang ok", owner: "Owner", language: POLICY.locales[0] }, SYS);
    expect(p.language).toBe(POLICY.locales[0]);
  });
});

describe("F12 internal fields", () => {
  it("viewer reads omit internal fields", async () => {
    const p = await createProject(
      db,
      {
        title: "R52 internal",
        owner: "Owner",
        repo_url: "https://git.example.com/r52/zz-repo",
        local_path: "C:/work/zz-local-dir",
        session_id: "sess-r52",
      },
      SYS,
    );

    // REST list and detail: absent for viewers, present for editors.
    const vList = (await (await rest(VIEWER, "GET", "/api/projects")).json()) as Array<Record<string, unknown>>;
    const vCard = vList.find((c) => c.id === p.id)!;
    expect(vCard).toBeTruthy();
    for (const f of INTERNAL) expect(vCard).not.toHaveProperty(f);
    const eList = (await (await rest(EDITOR, "GET", "/api/projects")).json()) as Array<Record<string, unknown>>;
    expect(eList.find((c) => c.id === p.id)!.local_path).toBe("C:/work/zz-local-dir");

    const vDetail = (await (await rest(VIEWER, "GET", `/api/projects/${p.id}`)).json()) as any;
    for (const f of INTERNAL) expect(vDetail.project).not.toHaveProperty(f);
    const raw = JSON.stringify(vDetail);
    expect(raw).not.toContain("zz-local-dir");
    expect(raw).not.toContain("sess-r52");
    const eDetail = (await (await rest(EDITOR, "GET", `/api/projects/${p.id}`)).json()) as any;
    expect(eDetail.project.repo_url).toBe("https://git.example.com/r52/zz-repo");

    // Event history (diffs) carries no internal values for viewers.
    const vEvents = await (await rest(VIEWER, "GET", `/api/events?project_id=${p.id}`)).text();
    expect(vEvents).not.toContain("zz-local-dir");
    expect(vEvents).not.toContain("sess-r52");
    expect(await (await rest(EDITOR, "GET", `/api/events?project_id=${p.id}`)).text()).toContain("zz-local-dir");

    // MCP get_project: same rule.
    const vMcp = await mcpTool(VIEWER, "get_project", { id: p.id });
    for (const f of INTERNAL) expect(vMcp.project).not.toHaveProperty(f);
    expect(JSON.stringify(vMcp)).not.toContain("zz-local-dir");
    const eMcp = await mcpTool(EDITOR, "get_project", { id: p.id });
    expect(eMcp.project.local_path).toBe("C:/work/zz-local-dir");

    // Data layer: an explicit viewer caller gets the filtered shape too.
    const viewer = testCaller({ role: "viewer", channel: "dashboard" });
    const d = await getProjectDetail(db, p.id, viewer);
    for (const f of INTERNAL) expect(d.project).not.toHaveProperty(f);
    const cards = await listProjects(db, {}, viewer);
    for (const f of INTERNAL) expect(cards.find((c) => c.id === p.id)).not.toHaveProperty(f);
  });

  it("viewer inbox: unmatched hook events lose session, path and repo (diff and summary)", async () => {
    const hook = {
      session_id: "sess-zz-hook",
      cwd: "C:/work/zz-hook-dir",
      repo_url: "https://git.example.com/r52/zz-hook-repo",
      branch: "feature-x",
      reason: "exit",
    };
    await db
      .prepare(
        "INSERT INTO event (ts, actor, entity, entity_id, action, summary, diff_json) VALUES (?, 'svc', 'hook', ?, 'unmatched', ?, ?)",
      )
      .bind(
        new Date().toISOString(),
        hook.session_id,
        `Claude Code session ended (exit) in ${hook.cwd} · ${hook.repo_url}`,
        JSON.stringify({ hook: [null, hook] }),
      )
      .run();
    const viewerInbox = await (await rest(VIEWER, "GET", "/api/inbox")).text();
    expect(viewerInbox).toContain("Claude Code session ended (exit)");
    expect(viewerInbox).toContain("feature-x");
    for (const v of ["zz-hook-dir", "zz-hook-repo", "sess-zz-hook"]) expect(viewerInbox).not.toContain(v);
    expect(JSON.parse(viewerInbox).some((e: { diff_json: string }) => e.diff_json?.includes("sess-zz-hook"))).toBe(false);
    expect(await (await rest(EDITOR, "GET", "/api/inbox")).text()).toContain("zz-hook-dir");
  });
});

describe("F12 server-side localisation of OAuth pages", () => {
  const saved = [...POLICY.locales];
  afterEach(() => {
    POLICY.locales.splice(0, POLICY.locales.length, ...saved);
  });

  async function consentHtml(clientName: string): Promise<string> {
    const reg = await call("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    const { client_id } = (await reg.json()) as { client_id: string };
    const q = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      state: "s1",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    });
    const page = await call(`/authorize?${q}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    );
    return page.text();
  }

  it("consent page renders in instance default locale", async () => {
    POLICY.locales.splice(0, POLICY.locales.length, "de", "en");
    const html = await consentHtml("<i>Client</i> {app}");
    expect(html).toContain('<html lang="de">');
    expect(html).toContain("Zugriff erlauben?");
    expect(html).toContain("&lt;i&gt;Client&lt;/i&gt; {app}"); // escaped, and not interpolated twice
    expect(html).toContain('name="action" value="approve"');
    expect(html).toContain('<form method="post" action="/authorize">');
    expect(html).not.toContain("Allow access?");

    POLICY.locales.splice(0, POLICY.locales.length, "en", "de");
    const en = await consentHtml("Plain Client");
    expect(en).toContain('<html lang="en">');
    expect(en).toContain("Allow access?");
  });

  it("OAuth error pages use the instance default locale", async () => {
    POLICY.locales.splice(0, POLICY.locales.length, "de", "en");
    const res = await call("/callback?state=bogus&code=x");
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Anmeldung ungültig oder abgelaufen/);
    POLICY.locales.splice(0, POLICY.locales.length, "en", "de");
    const en = await call("/callback?state=bogus&code=x");
    expect(await en.text()).toMatch(/Sign-in invalid or expired/);
  });
});
