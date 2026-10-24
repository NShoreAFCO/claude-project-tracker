import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./types";
import { handleDefault } from "./router";
import { mcpApiHandler } from "./mcp/server";
import { isAuditConfigured, runAuditExport } from "./audit/export";

// The provider needs the public resource URL (RFC 9728), which comes from env → build lazily, once per value.
let provider: OAuthProvider<Env> | null = null;
let providerFor = "";

function getProvider(env: Env): OAuthProvider<Env> {
  const base = env.PUBLIC_URL.replace(/\/+$/, "");
  if (!provider || providerFor !== base) {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpApiHandler,
      defaultHandler: { fetch: (request, e, ctx) => handleDefault(request, e as Env, ctx) },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      resourceMetadata: { resource: `${base}/mcp`, resource_name: "Project Tracker" },
    });
    providerFor = base;
  }
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return getProvider(env).fetch(request, env, ctx);
  },
  // Hourly audit export (SPEC §8); errors are logged, meta stays unchanged, so the next run retries.
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    if (!isAuditConfigured(env)) {
      console.log("audit skipped: AUDIT_REPO or AUDIT_GITHUB_TOKEN not set");
      return;
    }
    ctx.waitUntil(
      runAuditExport(env).then(
        (r) => console.log("audit", JSON.stringify(r)),
        (e) => console.error("audit failed", e),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
