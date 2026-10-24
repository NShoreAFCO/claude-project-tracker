import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyIdToken } from "../src/auth/oidc";
import type { Env } from "../src/types";
import { INSTANCE } from "../src/generated/instance";
import { OIDC_ISS, TEAM, call, installTestKeys, serviceJwt, signJwt, userJwt } from "./helpers";

beforeAll(installTestKeys);

describe("Access JWT (App A) — fail closed", () => {
  it("GET / without JWT → 401", async () => {
    expect((await call("/")).status).toBe(401);
  });
  it("GET /api/whoami without JWT → 401", async () => {
    expect((await call("/api/whoami")).status).toBe(401);
  });
  it("forged JWT (untrusted key) → 401", async () => {
    expect((await call("/api/whoami", { jwt: await userJwt(undefined, { untrusted: true }) })).status).toBe(401);
  });
  it("garbage JWT → 401", async () => {
    expect((await call("/api/whoami", { jwt: "abc.def.ghi" })).status).toBe(401);
  });
  it("wrong audience → 401", async () => {
    expect((await call("/api/whoami", { jwt: await userJwt(undefined, { aud: "other-app" }) })).status).toBe(401);
  });
  it("wrong issuer → 401", async () => {
    expect((await call("/api/whoami", { jwt: await userJwt(undefined, { iss: "https://evil.cloudflareaccess.com" }) })).status).toBe(401);
  });
  it("expired → 401", async () => {
    expect((await call("/api/whoami", { jwt: await userJwt(undefined, { expSecondsFromNow: -60 }) })).status).toBe(401);
  });
  it("valid JWT, email not allow-listed → 401", async () => {
    expect((await call("/api/whoami", { jwt: await userJwt("colleague@example.com") })).status).toBe(401);
  });
  it("valid JWT, allow-listed email (case-insensitive) → 200 with identity", async () => {
    const res = await call("/api/whoami", { jwt: await userJwt("User@Example.com") });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ identity: { kind: "user", email: "user@example.com" } });
  });
  it("placeholder ACCESS_AUD config → 401 even with a matching token", async () => {
    const jwt = await userJwt(undefined, { aud: "REPLACE_WITH_APP_A_AUD_TAG" });
    expect((await call("/api/whoami", { jwt, envOverride: { ACCESS_AUD: "REPLACE_WITH_APP_A_AUD_TAG" } })).status).toBe(401);
  });
});

describe("service token", () => {
  it("valid service token on /api/projects → 403", async () => {
    expect((await call("/api/projects", { jwt: await serviceJwt() })).status).toBe(403);
  });
  it("valid service token on / → 403", async () => {
    expect((await call("/", { jwt: await serviceJwt() })).status).toBe(403);
  });
  it("valid service token on /api/hooks/claude-code → passes auth", async () => {
    const res = await call("/api/hooks/claude-code", { method: "POST", body: "{}", jwt: await serviceJwt() });
    expect([401, 403]).not.toContain(res.status);
  });
  it("unknown service token → 401", async () => {
    expect((await call("/api/hooks/claude-code", { method: "POST", body: "{}", jwt: await serviceJwt("other.access") })).status).toBe(401);
  });
});

describe("bypass paths authenticate themselves", () => {
  it("POST /mcp without bearer → 401", async () => {
    const res = await call("/mcp", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    expect(res.status).toBe(401);
  });
  it("POST /mcp with a bogus bearer → 401", async () => {
    const res = await call("/mcp", { method: "POST", body: "{}", headers: { Authorization: "Bearer x:y:z" } });
    expect(res.status).toBe(401);
  });
  it("POST /webhooks/github without signature → 401", async () => {
    expect((await call("/webhooks/github", { method: "POST", body: "{}" })).status).toBe(401);
  });
  it("/.well-known/oauth-protected-resource is public metadata", async () => {
    const res = await call("/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { resource: string }).resource).toBe("https://tracker.test/mcp");
  });
  it("unknown /.well-known path → 404, never data", async () => {
    expect((await call("/.well-known/whatever")).status).toBe(404);
  });
  it("/authorize without OAuth params → 400 (no data)", async () => {
    expect((await call("/authorize")).status).toBe(400);
  });
  it("/callback without upstream state → 400, no grant", async () => {
    expect((await call("/callback?code=x&state=y")).status).toBe(400);
  });
});

describe("DEV_AUTH_EMAIL", () => {
  const dev = { DEV_AUTH_EMAIL: "user@example.com" } satisfies Partial<Env>;
  it("ignored when host is not localhost", async () => {
    expect((await call("/api/whoami", { envOverride: dev })).status).toBe(401);
  });
  it("honoured on localhost", async () => {
    expect((await call("/api/whoami", { envOverride: dev, base: "http://localhost:8787" })).status).toBe(200);
  });
  it("honoured on 127.0.0.1", async () => {
    expect((await call("/api/whoami", { envOverride: dev, base: "http://127.0.0.1:8787" })).status).toBe(200);
  });
  it("not honoured for a non-allow-listed dev email", async () => {
    const res = await call("/api/whoami", { envOverride: { DEV_AUTH_EMAIL: "x@y.z" }, base: "http://localhost:8787" });
    expect(res.status).toBe(401);
  });
});

describe("OIDC id_token (App C)", () => {
  const e = env as Env;
  it("valid token → email", async () => {
    const t = await signJwt({ email: "User@example.com" }, { aud: "oidc-client", iss: OIDC_ISS });
    expect(await verifyIdToken(t, e)).toBe("user@example.com");
  });
  it("team-domain issuer (Access JWT form) → null", async () => {
    const t = await signJwt({ email: "user@example.com" }, { aud: "oidc-client", iss: TEAM });
    expect(await verifyIdToken(t, e)).toBeNull();
  });
  it("issuer of another OIDC app → null", async () => {
    const t = await signJwt({ email: "user@example.com" }, { aud: "oidc-client", iss: `${TEAM}/cdn-cgi/access/sso/oidc/other` });
    expect(await verifyIdToken(t, e)).toBeNull();
  });
  it("wrong audience → null", async () => {
    const t = await signJwt({ email: "user@example.com" }, { aud: "test-aud-app-a", iss: OIDC_ISS });
    expect(await verifyIdToken(t, e)).toBeNull();
  });
  it("untrusted key → null", async () => {
    const t = await signJwt({ email: "user@example.com" }, { aud: "oidc-client", iss: OIDC_ISS, untrusted: true });
    expect(await verifyIdToken(t, e)).toBeNull();
  });
});

describe("MCP client login: consent → Access OIDC redirect", () => {
  it("registered client gets a consent page; approve redirects to Access with PKCE; deny returns access_denied", async () => {
    const reg = await call("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "<b>Evil</b> Client",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(reg.status).toBe(201);
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
    const html = await page.text();
    expect(html).toContain("&lt;b&gt;Evil&lt;/b&gt; Client"); // client name escaped
    expect(html).toContain("claude.ai");
    // consent page: English, instance app name, no brand styling
    expect(html).toContain('<html lang="en">');
    expect(html).toContain(INSTANCE.app.name);
    expect(html).toContain("Allow access?");
    const handle = /name="handle" value="([^"]+)"/.exec(html)![1];
    const cookie = page.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    const approve = await call("/authorize", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: new URLSearchParams({ handle, action: "approve" }).toString(),
    });
    expect(approve.status).toBe(302);
    const loc = new URL(approve.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe("https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/oidc-client/authorization");
    expect(loc.searchParams.get("client_id")).toBe("oidc-client");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://tracker.test/callback");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("state")).toBeTruthy();

    // Handle is single use.
    const replay = await call("/authorize", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: new URLSearchParams({ handle, action: "approve" }).toString(),
    });
    expect(replay.status).toBe(400);

    // Without the browser-binding cookie the handle is rejected.
    const page2 = await call(`/authorize?${q}`);
    const handle2 = /name="handle" value="([^"]+)"/.exec(await page2.text())![1];
    const noCookie = await call("/authorize", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle: handle2, action: "approve" }).toString(),
    });
    expect(noCookie.status).toBe(400);
  });
});
