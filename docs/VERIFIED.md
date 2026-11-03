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

CI runs on Node 24 (local development verified on v24.19.0, 2026-10-25).

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

Verified 2026-10-24 against the API reference (developers.cloudflare.com/api) and the official SDK `cloudflare/cloudflare-typescript` @ `6dbe1fc` (`src/resources/...`). Base URL `https://api.cloudflare.com/client/v4`; every response is the `{ success, errors, messages, result, result_info }` envelope; lists paginate with `page` / `per_page` and `result_info.total_pages`.

| Purpose | Call | Notes |
|---|---|---|
| Account | `GET /accounts` | Pick the only account, or the one named in the config. |
| workers.dev subdomain | `GET /accounts/{a}/workers/subdomain` | `result.subdomain`; missing until Workers is opened once in the dashboard. |
| Zero Trust team | `GET /accounts/{a}/access/organizations` | `result.auth_domain` = `<team>.cloudflareaccess.com`; absent until Zero Trust is set up. |
| One-time PIN login | `GET`/`POST /accounts/{a}/access/identity_providers` | Body `{ name, type: "onetimepin", config: {} }`. |
| D1 | `GET /accounts/{a}/d1/database?name=`, `POST` `{ name }`, `DELETE …/d1/database/{uuid}` | Id field `uuid`. |
| KV | `GET`/`POST /accounts/{a}/storage/kv/namespaces` `{ title }`, `DELETE …/{id}` | |
| Service token | `GET`/`POST /accounts/{a}/access/service_tokens` `{ name, duration }`, `DELETE …/{id}` | `duration` like `8760h` (default 1 year). `client_secret` is returned **only on create**. |
| Reusable policy | `GET`/`POST /accounts/{a}/access/policies` `{ name, decision, include }`, `DELETE …/{id}` | `decision`: `allow`, `deny`, `non_identity` (service auth), `bypass`. Rules: `{ email: { email } }`, `{ service_token: { token_id } }`, `{ everyone: {} }`. |
| Access application | `GET`/`POST /accounts/{a}/access/apps`, `DELETE …/{id}` | `policies`: array of reusable policy ids (inline and reusable policies are mutually exclusive). Response has `aud`. |
| — self-hosted | `{ type: "self_hosted", name, domain, destinations: [{ type: "public", uri }], policies, app_launcher_visible }` | A public `uri` covers its subpaths; a path wildcard `/x/*` does not cover `/x`, so list both. |
| — SaaS OIDC | `{ type: "saas", name, policies, saas_app: { auth_type: "oidc", redirect_uris, grant_types, scopes, refresh_token_options: { lifetime } } }` | `grant_types` include `authorization_code_with_pkce` and `refresh_tokens` (the Worker sends a PKCE challenge plus the client secret). `saas_app.client_secret` is returned **only on create**. Endpoints: `https://<team>/cdn-cgi/access/sso/oidc/<client_id>/{token,authorization,jwks}` (saas-mcp guide). |
| Worker | `DELETE /accounts/{a}/workers/scripts/{name}` | Deploys and secrets go through wrangler with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. |

**API token permissions** (account scope; the dashboard calls them "Edit"):
- Workers Scripts Edit
- D1 Edit
- Workers KV Storage Edit
- Access: Apps and Policies Edit
- Access: Service Tokens Edit
- Access: Organizations, Identity Providers, and Groups Edit
- Account Settings Read

## Secret input under the Claude Code `!` prefix

Checked 2026-10-24 with `! node scripts/lib/prompt.mjs --selftest` on Windows 11: commands run with `!` get no interactive terminal (stdin is not a TTY), so `askSecret` refuses with "Secret input needs an interactive terminal…" before reading anything. `npm run setup`, `teardown`, `secrets:rotate` and `hook:install` therefore cannot be run through `!`; they run in a separate terminal window only.

## Browser Rendering (server-side PDF reports)

Verified 2026-10-26 on developers.cloudflare.com.

- Binding: wrangler key `"browser": { "binding": "BROWSER" }` (https://developers.cloudflare.com/browser-rendering/workers-bindings/). No API token is needed for a binding.
- Chosen API: the **quick action** `env.BROWSER.quickAction("pdf", { html, addStyleTag, pdfOptions })` (https://developers.cloudflare.com/browser-run/quick-actions/pdf-endpoint/). It needs `compatibility_date` 2026-03-24 or later (this repo uses 2026-10-01) and **no new dependency**, so `@cloudflare/puppeteer` is not added. The docs say one of `url` or `html` is required; the binding example only shows `url`, and the call returns a `Response` (inferred from the handler type, not stated). The Worker therefore reads `response.arrayBuffer()` and checks `ok`.
- `pdfOptions` keys listed in the REST examples (https://developers.cloudflare.com/browser-rendering/rest-api/pdf-endpoint/): `format`, `landscape`, `printBackground`, `preferCSSPageSize`, `scale`, `displayHeaderFooter`, `headerTemplate`, `footerTemplate`, `margin`, `timeout`. The docs do not show them with the binding call; the binding is described as the same endpoint. **Unverified until a real render**: that the binding accepts `html` and `pdfOptions`.
- The report page is Access-protected, so the browser cannot fetch it by `url`; the Worker passes the report HTML and the print CSS (`addStyleTag`) inline.
- Local dev: `wrangler dev` has no local browser; a real one needs `"remote": true` on the binding (which uses a Cloudflare account). The template does not set it. Tests use a binding stub.
- Limits, Workers Free (https://developers.cloudflare.com/browser-rendering/limits/): 10 browser minutes per day, 3 concurrent browsers, new browser 1 per 20 s (Browser Sessions), **quick action requests 1 per 10 s**, browser timeout 60 s; exceeding returns HTTP 429 (daily cap until the next UTC day). The endpoint maps a 429 or any failure to 503.

## Logout path, host name and MCP instructions (v0.3.0)

Checked 2026-11-03.

- Logout: a link to the app's own `/cdn-cgi/access/logout` ends the current app session (https://developers.cloudflare.com/cloudflare-one/identity/users/session-management/). The team-domain path is for the App Launcher session. Not confirmed: whether other apps of the same team stay signed in. Logout does not block a new login while the identity provider session is valid.
- Host name: `os.hostname()` returns the OS host name; Node documents no length limit (https://nodejs.org/api/os.html). The package truncates to 64 characters on store. Per-OS limits are from memory and unverified. The host name can reveal a real name; the user's own tracker is the only recipient.
- MCP instructions: Claude Code is reported to truncate each server's instructions at 2,048 characters (secondary sources, not the official docs); the guide stays under 1,800 and is ASCII. claude.ai connector behaviour is not verified.
