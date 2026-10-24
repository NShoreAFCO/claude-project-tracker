import type { Env } from "./types";
import { getAccessIdentity } from "./auth/access";
import { handleAuthorize, handleCallback } from "./auth/oidc";
import { handleApi, handleHooks, json } from "./api/rest";
import { handleGithubWebhook } from "./webhook/github";

/**
 * Default handler behind OAuthProvider. The provider itself answers /mcp (bearer token),
 * /oauth/token, /oauth/register and /.well-known/oauth-* before this runs.
 *
 * Access model (SPEC §3), fail closed:
 *  - /webhooks/github         self-authenticating (HMAC-SHA256 over the raw body)
 *  - /authorize, /callback    self-authenticating (consent + Access OIDC + email allowlist);
 *                             normally also behind App A, and may be moved to the bypass app.
 *  - everything else          requires a valid Access JWT (App A); service tokens only on /api/hooks/*
 */
export async function handleDefault(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (path === "/webhooks/github") return handleGithubWebhook(request, env);
  if (path === "/authorize") return handleAuthorize(request, env);
  if (path === "/callback") return handleCallback(request, env);
  // Bypass-app paths the provider did not claim: never fall through to data routes.
  if (path.startsWith("/.well-known/") || path.startsWith("/oauth/") || path === "/mcp" || path.startsWith("/mcp/")) {
    return json({ error: "not_found" }, 404);
  }

  const identity = await getAccessIdentity(request, env);
  if (!identity) return json({ error: "unauthorized" }, 401);

  if (path.startsWith("/api/hooks/")) return handleHooks(request, env);
  if (identity.kind !== "user") return json({ error: "forbidden" }, 403);
  if (path.startsWith("/api/")) return handleApi(request, env, identity);
  return withSecurityHeaders(await env.ASSETS.fetch(request));
}

// Dashboard: same-origin scripts only (no inline script), Google Fonts for web fonts a theme may import, no framing.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.set("Content-Security-Policy", CSP);
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Referrer-Policy", "no-referrer");
  out.headers.set("Cache-Control", "no-cache");
  return out;
}
