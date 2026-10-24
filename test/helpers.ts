import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import worker from "../src/index";
import { setJwksOverrideForTesting } from "../src/auth/access";
import type { Env } from "../src/types";

export const BASE = "https://tracker.test";
export const TEAM = "https://team.cloudflareaccess.com";
/** App C id_token issuer = ACCESS_TOKEN_URL without /token (verified against the live discovery doc, 2026-10-22). */
export const OIDC_ISS = `${TEAM}/cdn-cgi/access/sso/oidc/oidc-client`;

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let trusted: KeyPair;
let untrusted: KeyPair;

/** Generate a trusted and an untrusted RS256 key pair; the worker trusts only the first. */
export async function installTestKeys(): Promise<void> {
  trusted = await generateKeyPair("RS256", { extractable: true });
  untrusted = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(trusted.publicKey)), kid: "k1", alg: "RS256" };
  setJwksOverrideForTesting(createLocalJWKSet({ keys: [jwk] }));
}

export async function signJwt(
  claims: JWTPayload,
  opts: { untrusted?: boolean; iss?: string; aud?: string | string[]; expSecondsFromNow?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? TEAM)
    .setAudience(opts.aud ?? ["test-aud-app-a"])
    .setIssuedAt(now - 10)
    .setExpirationTime(now + (opts.expSecondsFromNow ?? 300))
    .sign((opts.untrusted ? untrusted : trusted).privateKey);
}

export const userJwt = (email = "user@example.com", o = {}) => signJwt({ email, type: "app" }, o);
export const serviceJwt = (commonName = "svc-hook.access", o = {}) => signJwt({ common_name: commonName, type: "app" }, o);

export async function call(
  path: string,
  init: RequestInit & { jwt?: string; base?: string; envOverride?: Partial<Env> } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.jwt) headers.set("Cf-Access-Jwt-Assertion", init.jwt);
  const request = new Request(`${init.base ?? BASE}${path}`, { ...init, headers });
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, { ...env, ...init.envOverride } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
