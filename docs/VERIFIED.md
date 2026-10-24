# Verified APIs and pinned versions

Sources: the listed docs plus the installed `.d.ts` files. Where docs and types disagree, the installed types win.

## Pinned versions (`package.json`, exact)

| Package | Version | Note |
|---|---|---|
| `agents` | 0.28.1 | peer-requires `@modelcontextprotocol/server` **2.3.1** exactly |
| `@modelcontextprotocol/server` | 2.3.1 | MCP SDK v2 |
| `@cloudflare/workers-oauth-provider` | 1.2.3 | |
| `zod` | 4.6.7 | `agents` peer `^4` |
| `jose` | 6.2.13 | JWT/JWKS verification (Access JWT + OIDC id_token) |
| `wrangler` | 4.151.3 | |
| `@cloudflare/vitest-plugin` | 1.4.6 | **renamed** from `@cloudflare/vitest-pool-workers` (0.23.0 deprecated); peer `vitest ^4.1 \|\| ^5` |
| `vitest` | 5.0.5 | |
| `typescript` | 5.9.3 | 7.x (Go port) deliberately not used |
| `@cloudflare/workers-types` | 5.20261019.1 | |

npm 11 blocks install scripts. `allowScripts` in `package.json` approves `esbuild` and `workerd`.

## MCP transport — `agents/mcp/server`
Docs: <https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/>, <https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/>
- `McpAgent` is deprecated and feature-frozen (confirmed). Use `createMcpHandler` (alias of `createStatelessMcpHandler`) and `getMcpAuthContext` from `agents/mcp/server`.
- `createMcpHandler(factory, options?)`:
  - Takes a **factory** `(ctx: McpRequestContext) => McpServer`, which is called per request. Pass the factory, never a shared instance.
  - Returns a callable `(request, env, ctx) => Promise<Response>`.
  - Options: `route` (default `/mcp`, exact match), `corsOptions`, `allowedHostnames`, `allowedOriginHostnames`, `authContext`, `legacy` (`"stateless"` default \| `"reject"`), `responseMode`.
- `getMcpAuthContext()` → `{ props } | undefined`. Default props = execution-context props, which `OAuthProvider` sets to the grant's `props`.
- Tool callbacks: `(args, ctx: ServerContext)`. `ctx.http.authInfo` holds the verified token. The client name comes from the per-request envelope (modern era) or `server.server.getClientVersion()` (legacy). **Decision:** store the OAuth client's registered `clientName` in grant `props` at `completeAuthorization`, and use it as the stable fallback for actor `mcp:<name>`.
- **Host check:** the stateless handler rejects requests without a `Host` header (403 "Missing Host header", a DNS-rebinding guard). Real Worker requests always carry it. `allowedHostnames` is set to the `PUBLIC_URL` host plus localhost.
- Verified in tests with protocol version `2025-06-18` (legacy era, stateless): `initialize`, `tools/list`, `tools/call`.
- `McpServer`:
  - `new McpServer({name, version}, { instructions })`.
  - `registerTool(name, {title, description, inputSchema: z.object({...}), annotations}, cb)`. The raw-shape form is deprecated, so wrap schemas in `z.object`.
  - `registerResource(name, new ResourceTemplate('tracker://context/{doc_id}', …), meta, cb)` is supported.
- The Cloudflare template `cloudflare/ai/demos/remote-mcp-cf-access` is a reference for the Access-OIDC flow only; its MCP transport code is not used.

## OAuth provider — `@cloudflare/workers-oauth-provider` 1.2.3
Docs: <https://github.com/cloudflare/workers-oauth-provider> (+ `docs/authorization-server.md`)
- `new OAuthProvider({ apiRoute, apiHandler, defaultHandler, authorizeEndpoint, tokenEndpoint, clientRegistrationEndpoint, scopesSupported?, accessTokenTTL?, refreshTokenTTL? })`.
  - `apiHandler` may be a plain `{ fetch }` object.
  - Requests under `apiRoute` reach it with `ctx.props` (grant props) and `ctx.auth`.
- KV binding must be named `OAUTH_KV`. Helpers sit on `env.OAUTH_PROVIDER: OAuthHelpers`:
  - `parseAuthRequest(req)`, `lookupClient(id)`.
  - `completeAuthorization({request, userId, metadata, scope, props}) → {redirectTo}`. `userId` must not contain `:`.
  - **Built-in consent/upstream helpers (these replace hand-rolled cookies and CSRF):**
    - `describeConsent(authReq)`: clientName, redirectHost, redirectIsLoopback. All strings must be escaped.
    - `beginConsent(authReq) → {handle, headers}`; `approveConsent(req, handle, {remember:{secret, subject?}})`; `denyConsent`; `isConsentRemembered(req, authReq, {secret})`.
    - `beginUpstream(authReq, {data}) → {state, headers}` and `finishUpstream(req) → {request, data, headers}`. These are browser-bound, single use, and carry the PKCE verifier as `data`.
- **Design:**
  - `/authorize` GET: parse, then either use remembered consent or show the consent page (client name + redirect host). POST approves.
  - Then `beginUpstream` → redirect to the Access SaaS authorization URL with PKCE S256.
  - `/callback`: `finishUpstream`, exchange the code, verify the `id_token`, check the email allowlist, then `completeAuthorization`.
  - `COOKIE_ENCRYPTION_KEY` (≥ 32 chars) is the `remember.secret`.
- **`resourceMetadata` is required** in 1.2.3: `{ resource: "<PUBLIC_URL>/mcp" }` (an HTTPS URL, RFC 9728), served at `/.well-known/oauth-protected-resource/mcp`. It comes from the var `PUBLIC_URL`, so the provider is built lazily from `env`.
- Consent/upstream cookies default to the `__Host-oauth-` prefix (Secure, host-only).
- **`/authorize` and `/callback` are self-authenticating in the Worker.** They don't require the Access JWT: the consent handle is browser-bound and single use, and the id_token plus allowlist decide. So moving them into the bypass app (the SPEC §3 fallback) needs no code change. While App A covers them, Access also gates them.
- **Reference template** `cloudflare/ai/demos/remote-mcp-cf-access/src/access-handler.ts` verifies only the signature and `exp` (no `iss`/`aud`) and refetches JWKS on every call. The tracker verifies `iss` + `aud` + `exp` with `jose`.

## Access for SaaS (OIDC) — App C
Docs: <https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/saas-mcp/>
- Endpoints (copy from the dashboard): `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<CLIENT_ID>/{authorization,token,jwks}`. Redirect URL `/callback`.
- The docs don't state the `id_token` `iss`. Verified against App C's live discovery document (`<issuer>/.well-known/openid-configuration`): `issuer` = `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>`, i.e. `ACCESS_TOKEN_URL` without `/token`; `token_endpoint` and `jwks_uri` share that prefix; RS256 only. **Decision:** `aud` must equal `ACCESS_CLIENT_ID`; `iss` must equal exactly that prefix (the team-domain form is not accepted).

## Access JWT on App A requests
Docs: <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/>, <https://developers.cloudflare.com/workers/configuration/cloudflare-access/>
- Header `Cf-Access-Jwt-Assertion`. JWKS `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. `iss` = `https://<team>.cloudflareaccess.com`. `aud` contains `ACCESS_AUD`.
- `ctx.access.getIdentity()` exists for Workers, but `ctx.access` is undefined when Access did not authenticate. **Decision:** always verify the JWT manually with `jose` (`createRemoteJWKSet` + `jwtVerify`). This is fail closed and independent of the runtime integration.
- Service-token JWT: the docs page doesn't name the claim. Per Access behaviour, user tokens carry `email` and service tokens carry `common_name` (= Client ID) with an empty `email`. Implemented exactly that; confirm on the first real hook call.

## D1 limits
Docs: <https://developers.cloudflare.com/d1/platform/limits/>
- Max row / string / BLOB: **2 MB**. The caps in SPEC §4.1 (256 KB per doc, 2 MB per owner as an aggregate) fit.
- Max SQL statement length 100 KB (statement text, not bound params). Seed statements use literals, so each must stay < 100 KB.
- Max 100 bound params per query. 1,000 queries per invocation on Paid, **50 on Free**: the audit cron must batch.
- 30 s max query/batch duration.

## GitHub Git Data API (audit export)
Docs: <https://docs.github.com/en/rest/git/trees>
- `POST /repos/{o}/{r}/git/trees` `{base_tree, tree:[{path, mode:"100644", type:"blob", content}]}`. Inline `content` is allowed (`sha` XOR `content`).
- Then `POST git/commits {message, tree, parents:[head]}` and `PATCH git/refs/heads/main {sha}`. Fallback: Contents API `PUT /repos/{o}/{r}/contents/{path}` with `sha`.
- Fine-grained PAT: Contents read/write on the audit repo covers git data + contents.

## Claude Code SessionEnd hook
Docs: <https://code.claude.com/docs/en/hooks>
- stdin: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `reason` (`clear` \| `resume` \| `logout` \| `prompt_input_exit` \| `other`).
- SessionEnd hooks share a **1.5 s** budget (raised up to 60 s if a hook sets a larger `timeout`). Cannot block; stderr is shown to the user only.
- Config: `{"hooks":{"SessionEnd":[{"hooks":[{"type":"command","command":"node \"<home>/.claude/hooks/tracker-session-end.mjs\""}]}]}}`.

## Cloudflare API (setup scripts)
To be verified in the setup task.
