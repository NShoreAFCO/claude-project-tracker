// End-to-end acceptance (SPEC §13) through the real Worker entry point: seed → OAuth client registration →
// consent → Access OIDC callback (token endpoint mocked) → token → /mcp with a bearer token.
import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import seedSql from "../seed/seed.sql?raw";
import { OIDC_ISS, call, installTestKeys, signJwt } from "./helpers";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "acceptance-test-code-verifier-0123456789-abcdefghijklmnop";
let CHALLENGE = ""; // S256(VERIFIER), computed in beforeAll
const SEED_IDS = ["example-website-relaunch"];

/** seed.sql → statements (one INSERT per statement; doc contents span lines). */
function seedStatements(sql: string): string[] {
  return sql
    .split(/;\n(?=INSERT INTO [a-z_]+ \(|-- |\s*$)/)
    .map((s) => s.replace(/^(--[^\n]*\n|\s*\n)+/, "").trim())
    .filter((s) => s.startsWith("INSERT INTO"));
}

const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
const joinCookies = (...parts: string[]) => parts.filter(Boolean).join("; ");

/** Runs register → consent → approve → callback for `email`; returns the callback response. */
async function login(email: string): Promise<{ callback: Response; clientId: string }> {
  const reg = await call("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "claude.ai", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  });
  const { client_id: clientId } = (await reg.json()) as { client_id: string };
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: "claude-state",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
  });
  const page = await call(`/authorize?${q}`);
  const handle = /name="handle" value="([^"]+)"/.exec(await page.text())![1];
  const c1 = cookiesOf(page);
  const approve = await call("/authorize", {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: c1 },
    body: new URLSearchParams({ handle, action: "approve" }).toString(),
  });
  const upstream = new URL(approve.headers.get("Location")!);
  const state = upstream.searchParams.get("state")!;

  // Access (App C) token endpoint: returns an id_token for `email`, signed by the trusted test key.
  const idToken = await signJwt({ email }, { aud: "oidc-client", iss: OIDC_ISS });
  const realFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input instanceof Request ? input.url : input) === env.ACCESS_TOKEN_URL) {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("code")).toBe("upstream-code");
      expect(body.get("code_verifier")).toBeTruthy(); // PKCE towards Access
      return new Response(JSON.stringify({ id_token: idToken, token_type: "Bearer" }), { headers: { "Content-Type": "application/json" } });
    }
    return realFetch(input, init);
  });
  const callback = await call(`/callback?code=upstream-code&state=${encodeURIComponent(state)}`, {
    redirect: "manual",
    headers: { Cookie: joinCookies(c1, cookiesOf(approve)) },
  });
  spy.mockRestore();
  return { callback, clientId };
}

async function mcp(token: string, method: string, params: Record<string, unknown> = {}) {
  const res = await call("/mcp", {
    method: "POST",
    headers: {
      Host: "tracker.test",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const json = text.startsWith("{")
    ? JSON.parse(text)
    : JSON.parse(
        text
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice(6),
      );
  return { status: res.status, ...json };
}

beforeAll(async () => {
  await installTestKeys();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(VERIFIER)));
  CHALLENGE = btoa(String.fromCharCode(...digest))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const stmts = seedStatements(seedSql);
  expect(stmts.length).toBeGreaterThan(10);
  // the seed is written for an empty database; make it re-runnable within the shared test storage
  await env.DB.batch(SEED_IDS.map((id) => env.DB.prepare("DELETE FROM project WHERE id = ?").bind(id)));
  await env.DB.batch(stmts.map((s) => env.DB.prepare(s)));
});
afterEach(() => vi.restoreAllMocks());

describe("acceptance (SPEC §13)", () => {
  it("seed: demo project with WPs (one nested), a milestone and a pinned background doc", async () => {
    const counts = await env.DB.prepare(
      "SELECT (SELECT count(*) FROM workpackage WHERE project_id = ?1) AS wps, (SELECT count(*) FROM workpackage WHERE project_id = ?1 AND parent_id IS NOT NULL) AS nested, (SELECT count(*) FROM milestone WHERE project_id = ?1) AS ms, (SELECT count(*) FROM milestone_link l JOIN milestone m ON m.id = l.milestone_id WHERE m.project_id = ?1) AS links",
    )
      .bind(SEED_IDS[0])
      .first<{ wps: number; nested: number; ms: number; links: number }>();
    expect(counts).toEqual({ wps: 6, nested: 1, ms: 1, links: 2 });
    const { results } = await env.DB.prepare(
      "SELECT p.id, p.target_date, (SELECT count(*) FROM context_doc c WHERE c.project_id = p.id AND c.slug = 'background' AND c.pinned = 1) AS bg FROM project p WHERE p.id IN (" +
        SEED_IDS.map(() => "?").join(",") +
        ")",
    )
      .bind(...SEED_IDS)
      .all<{ id: string; target_date: string | null; bg: number }>();
    expect(results.map((r) => r.id).sort()).toEqual(SEED_IDS);
    expect(results.every((r) => r.bg === 1 && r.target_date === null)).toBe(true);
  });

  it("OIDC login as an allowed email → grant → bearer token → list_projects returns the seeded projects", async () => {
    const { callback, clientId } = await login("User@example.com");
    expect(callback.status).toBe(302);
    const back = new URL(callback.headers.get("Location")!);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("claude-state");
    const code = back.searchParams.get("code")!;

    const tokenRes = await call("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: VERIFIER,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    expect(access_token).toBeTruthy();

    const init = await mcp(access_token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "acceptance", version: "1" },
    });
    expect(init.result.instructions).toContain("get_context_bundle");

    const list = await mcp(access_token, "tools/call", { name: "list_projects", arguments: {} });
    const ids = JSON.parse(list.result.content[0].text).map((p: { id: string }) => p.id);
    for (const id of SEED_IDS) expect(ids).toContain(id);

    // a write through MCP is attributed to the registered client name
    const created = await mcp(access_token, "tools/call", { name: "create_project", arguments: { title: "Acceptance via MCP" } });
    expect(created.result.isError).toBeFalsy();
    const ev = await env.DB.prepare("SELECT actor FROM event WHERE entity = 'project' AND summary = 'Acceptance via MCP'").first<{
      actor: string;
    }>();
    expect(ev?.actor).toBe("mcp:claude.ai");

    // the same token does not open the dashboard API (Access-only)
    expect((await call("/api/projects", { headers: { Authorization: `Bearer ${access_token}` } })).status).toBe(401);
  });

  it("OIDC login as an email not in ALLOWED_EMAILS → 403 and no grant", async () => {
    const before = await env.OAUTH_KV.list({ prefix: "grant:" });
    const { callback } = await login("colleague@example.com");
    expect(callback.status).toBe(403);
    expect(callback.headers.get("Location")).toBeNull();
    const after = await env.OAUTH_KV.list({ prefix: "grant:" });
    expect(after.keys.length).toBe(before.keys.length);
  });

  it("an invalid bearer token never reaches the MCP tools", async () => {
    const r = await call("/mcp", {
      method: "POST",
      headers: { Host: "tracker.test", Authorization: "Bearer x:y:z", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(401);
  });
});
