import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { jwtVerify } from "jose";
import type { Env } from "../types";
import { INSTANCE } from "../generated/instance";
import { configured, isAllowedEmail, remoteJwks } from "./access";

/**
 * MCP client login (SPEC §3): /authorize → consent → Access for SaaS (OIDC, App C) → /callback.
 * Consent and upstream state use the provider's browser-bound, single-use helpers (docs/VERIFIED.md).
 */

const OIDC_SCOPE = "openid email profile";

interface UpstreamData {
  verifier: string;
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  if (!oidcConfigured(env)) return text("OIDC ist nicht konfiguriert.", 503);
  const helpers = env.OAUTH_PROVIDER;

  if (request.method === "GET") {
    let authReq: AuthRequest;
    try {
      authReq = await helpers.parseAuthRequest(request);
    } catch (e) {
      return text(`Invalid authorization request: ${(e as Error).message}`, 400);
    }
    if (await helpers.isConsentRemembered(request, authReq, { secret: env.COOKIE_ENCRYPTION_KEY })) {
      return redirectUpstream(request, env, authReq, new Headers());
    }
    const consent = await helpers.describeConsent(authReq);
    const tx = await helpers.beginConsent(authReq);
    const headers = new Headers(tx.headers);
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    headers.set("Cache-Control", "no-store");
    return new Response(consentPage(consent, tx.handle), { status: 200, headers });
  }

  if (request.method === "POST") {
    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    try {
      if (form.get("action") !== "approve") {
        const denied = await helpers.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await helpers.approveConsent(request, handle, {
        remember: { secret: env.COOKIE_ENCRYPTION_KEY },
      });
      return redirectUpstream(request, env, approved.request, new Headers(approved.headers));
    } catch (e) {
      return text(`Consent invalid or expired: ${(e as Error).message}`, 400);
    }
  }

  return text("Method Not Allowed", 405);
}

async function redirectUpstream(request: Request, env: Env, authReq: AuthRequest, headers: Headers): Promise<Response> {
  const verifier = randomToken(32);
  const challenge = await sha256Base64Url(verifier);
  const tx = await env.OAUTH_PROVIDER.beginUpstream(authReq, { data: { verifier } satisfies UpstreamData, headers });

  const url = new URL(env.ACCESS_AUTHORIZATION_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.ACCESS_CLIENT_ID);
  url.searchParams.set("redirect_uri", callbackUrl(request));
  url.searchParams.set("scope", OIDC_SCOPE);
  url.searchParams.set("state", tx.state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  const out = new Headers(tx.headers);
  out.set("Location", url.toString());
  out.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers: out });
}

export async function handleCallback(request: Request, env: Env): Promise<Response> {
  if (!oidcConfigured(env)) return text("OIDC ist nicht konfiguriert.", 503);
  const helpers = env.OAUTH_PROVIDER;

  let resumed: { request: AuthRequest; data: UpstreamData; headers: Headers };
  try {
    resumed = await helpers.finishUpstream<UpstreamData>(request);
  } catch (e) {
    return text(`Sign-in invalid or expired: ${(e as Error).message}`, 400);
  }

  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  if (!code) return text(`Anmeldung abgebrochen: ${params.get("error") ?? "kein Code"}`, 400);

  // Exchange the code at Access (App C).
  const tokenRes = await fetch(env.ACCESS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl(request),
      client_id: env.ACCESS_CLIENT_ID,
      client_secret: env.ACCESS_CLIENT_SECRET,
      code_verifier: resumed.data.verifier,
    }),
  });
  if (!tokenRes.ok) return text(`Token-Austausch fehlgeschlagen (${tokenRes.status}).`, 502);
  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token) return text("Kein id_token erhalten.", 502);

  const email = await verifyIdToken(tokens.id_token, env);
  if (!email) return text("Invalid id_token.", 401);
  if (!isAllowedEmail(env, email)) return text("Access denied.", 403); // no grant issued

  const client = await helpers.lookupClient(resumed.request.clientId);
  const clientName = client?.clientName || resumed.request.clientId;
  const { redirectTo } = await helpers.completeAuthorization({
    request: resumed.request,
    userId: email,
    metadata: { label: email, client: clientName },
    scope: resumed.request.scope,
    props: { email, clientName },
  });

  const headers = new Headers(resumed.headers);
  headers.set("Location", redirectTo);
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers });
}

/** Verify signature, iss, aud, exp of the Access OIDC id_token; return the lower-cased email. */
export async function verifyIdToken(idToken: string, env: Env): Promise<string | null> {
  // VERIFIED.md: the issuer is the OIDC endpoint prefix (token URL without /token), checked against the live
  // discovery document on 2026-10-22. The team domain (the Access JWT issuer) is not accepted here.
  const issuer = env.ACCESS_TOKEN_URL.replace(/\/token\/?$/, "");
  try {
    const { payload } = await jwtVerify(idToken, remoteJwks(env.ACCESS_JWKS_URL), {
      issuer,
      audience: env.ACCESS_CLIENT_ID,
      algorithms: ["RS256"],
    });
    return typeof payload.email === "string" && payload.email ? payload.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

function oidcConfigured(env: Env): boolean {
  return (
    [
      env.ACCESS_CLIENT_ID,
      env.ACCESS_CLIENT_SECRET,
      env.ACCESS_TOKEN_URL,
      env.ACCESS_AUTHORIZATION_URL,
      env.ACCESS_JWKS_URL,
      env.ACCESS_TEAM_DOMAIN,
    ].every(configured) && (env.COOKIE_ENCRYPTION_KEY ?? "").length >= 32
  );
}

function callbackUrl(request: Request): string {
  return new URL("/callback", request.url).toString();
}

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

function randomToken(bytes: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256Base64Url(input: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))));
}

function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function consentPage(
  c: { clientName: string; clientDomain?: string; redirectHost: string; redirectIsLoopback: boolean },
  handle: string,
): string {
  const app = esc(INSTANCE.app.name);
  const loopback = c.redirectIsLoopback
    ? `<p class="warn">The redirect goes to a local application. Any program on this computer could receive it.</p>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Allow access – ${app}</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1e293b;background:#fff;margin:0;padding:2rem 1rem;font-size:16px}
main{max-width:32rem;margin:0 auto;border-top:2px solid #0f4c5c;padding-top:1rem}
h1{font-weight:700;font-size:1.4rem}
.box{background:#f1f5f9;border-left:4px solid #0f4c5c;padding:.8rem 1rem;margin:1rem 0}
.warn{border-left:4px solid #9a3412;padding:.5rem 1rem;background:#f1f5f9}
button{font:inherit;font-weight:600;border-radius:6px;padding:.6rem 1.2rem;margin-right:.5rem;cursor:pointer}
.primary{background:#0f4c5c;color:#fff;border:2px solid #0f4c5c}.ghost{background:#fff;color:#0f4c5c;border:2px solid #0f4c5c}
</style></head><body><main>
<h1>Allow access?</h1>
<div class="box"><p><strong>${esc(c.clientName)}</strong>${c.clientDomain ? ` (${esc(c.clientDomain)})` : ""} wants to access ${app} (read and write projects).</p>
<p>Redirect to: <strong>${esc(c.redirectHost)}</strong></p></div>
${loopback}
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${esc(handle)}">
<button class="primary" name="action" value="approve" type="submit">Allow</button>
<button class="ghost" name="action" value="deny" type="submit">Deny</button>
</form></main></body></html>`;
}
