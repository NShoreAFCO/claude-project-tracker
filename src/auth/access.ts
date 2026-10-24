import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env, Identity } from "../types";

/** Comma/whitespace separated list → lower-cased set. */
export function parseList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(/[\s,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAllowedEmail(env: Env, email: string | undefined | null): boolean {
  return !!email && parseList(env.ALLOWED_EMAILS).has(email.trim().toLowerCase());
}

export function isAllowedServiceToken(env: Env, clientId: string | undefined | null): boolean {
  return !!clientId && parseList(env.ALLOWED_SERVICE_TOKEN_IDS).has(clientId.trim().toLowerCase());
}

/** A config value that is missing or still a SETUP placeholder counts as unset (fail closed). */
export function configured(value: string | undefined): value is string {
  return !!value && !/REPLACE/i.test(value);
}

export function teamIssuer(env: Env): string {
  const domain = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${domain}`;
}

// JWKS sets are cached per URL for the isolate lifetime; jose handles key rotation/refetch.
const jwksCache = new Map<string, JWTVerifyGetKey>();
let jwksOverride: JWTVerifyGetKey | null = null;

/** Tests only: verify against a local key set instead of fetching remote JWKS. */
export function setJwksOverrideForTesting(getKey: JWTVerifyGetKey | null): void {
  jwksOverride = getKey;
}

export function remoteJwks(url: string): JWTVerifyGetKey {
  if (jwksOverride) return jwksOverride;
  let set = jwksCache.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, set);
  }
  return set;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * Resolve the caller identity for a request that passed Cloudflare Access (App A).
 * Returns null when there is no valid Access JWT → caller must answer 401.
 * Identity is only returned for allow-listed emails / service tokens.
 */
export async function getAccessIdentity(request: Request, env: Env): Promise<Identity | null> {
  // Local dev: wrangler dev has no Access in front. Only ever on localhost.
  const host = new URL(request.url).hostname;
  if (env.DEV_AUTH_EMAIL && LOCAL_HOSTS.has(host)) {
    return isAllowedEmail(env, env.DEV_AUTH_EMAIL) ? { kind: "user", email: env.DEV_AUTH_EMAIL.toLowerCase() } : null;
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !configured(env.ACCESS_TEAM_DOMAIN) || !configured(env.ACCESS_AUD)) return null;

  const issuer = teamIssuer(env);
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, remoteJwks(`${issuer}/cdn-cgi/access/certs`), {
      issuer,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
    }));
  } catch {
    return null;
  }

  const email = typeof payload.email === "string" ? payload.email : "";
  if (email) {
    return isAllowedEmail(env, email) ? { kind: "user", email: email.toLowerCase() } : null;
  }
  const commonName = typeof payload.common_name === "string" ? payload.common_name : "";
  if (commonName && isAllowedServiceToken(env, commonName)) {
    return { kind: "service", clientId: commonName };
  }
  return null;
}
