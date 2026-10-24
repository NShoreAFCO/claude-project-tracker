import { test } from "node:test";
import assert from "node:assert/strict";
import { CfError, createCf } from "../lib/cf.mjs";
import { fakeCloudflare } from "./fake-cf.mjs";

const TOKEN = "tok-SECRET-0123456789";

test("whoami picks the only account", async () => {
  const cf = createCf({ token: TOKEN, fetch: fakeCloudflare().fetch });
  assert.deepEqual(await cf.whoami(), { accountId: "acc1", accountName: "Example account" });
});

test("ensureD1 reuses existing by name", async () => {
  const fake = fakeCloudflare({ d1: [{ uuid: "d1-old", name: "tracker-db" }] });
  const cf = createCf({ token: TOKEN, accountId: "acc1", fetch: fake.fetch });
  assert.deepEqual(await cf.ensureD1("tracker-db"), { id: "d1-old", created: false });
  assert.equal(fake.calls.filter((c) => c.method === "POST").length, 0);
});

test("ensureD1 creates when missing", async () => {
  const fake = fakeCloudflare();
  const cf = createCf({ token: TOKEN, accountId: "acc1", fetch: fake.fetch });
  const r = await cf.ensureD1("tracker-db");
  assert.equal(r.created, true);
  assert.deepEqual(fake.calls.find((c) => c.method === "POST").body, { name: "tracker-db" });
});

test("ensureKv reuses by title across pages", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `kv${i}`, title: `ns-${i}` }));
  const fake = fakeCloudflare({ kv: [...many, { id: "kv-target", title: "tracker-oauth" }], perPage: 20 });
  const cf = createCf({ token: TOKEN, accountId: "acc1", fetch: fake.fetch });
  assert.deepEqual(await cf.ensureKv("tracker-oauth"), { id: "kv-target", created: false });
});

test("ensureAccessApp self_hosted with bypass destinations", async () => {
  const fake = fakeCloudflare();
  const cf = createCf({ token: TOKEN, accountId: "acc1", fetch: fake.fetch });
  const host = "tracker.example.workers.dev";
  const paths = ["/mcp", "/mcp/*", "/oauth/*", "/.well-known/*", "/webhooks/github"];
  const r = await cf.ensureAccessApp({ type: "self_hosted", name: "tracker-bypass", domain: host, paths, policies: ["pol-bypass"] });
  const body = fake.calls.find((c) => c.method === "POST" && c.path.endsWith("/access/apps")).body;
  assert.equal(body.type, "self_hosted");
  assert.deepEqual(body.destinations.map((d) => d.uri), paths.map((p) => host + p));
  assert.ok(body.destinations.every((d) => d.type === "public"));
  assert.deepEqual(body.policies, ["pol-bypass"]);
  assert.ok(r.aud);
});

test("ensureAccessApp saas_oidc returns client secret and endpoints on create only", async () => {
  const fake = fakeCloudflare();
  const cf = createCf({ token: TOKEN, accountId: "acc1", fetch: fake.fetch });
  const spec = { type: "saas_oidc", name: "tracker-mcp", redirectUris: ["https://t.example/callback"], policies: ["pol-allow"], teamDomain: "team.cloudflareaccess.com" };
  const first = await cf.ensureAccessApp(spec);
  assert.ok(first.clientSecret);
  assert.equal(first.tokenUrl, `https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/${first.clientId}/token`);
  assert.equal(first.authorizationUrl, `https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/${first.clientId}/authorization`);
  assert.equal(first.jwksUrl, `https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/${first.clientId}/jwks`);
  const body = fake.calls.find((c) => c.method === "POST" && c.path.endsWith("/access/apps")).body;
  assert.equal(body.type, "saas");
  assert.equal(body.saas_app.auth_type, "oidc");
  assert.ok(body.saas_app.grant_types.includes("authorization_code_with_pkce"));
  const again = await cf.ensureAccessApp(spec);
  assert.equal(again.created, false);
  assert.equal(again.clientSecret, null);
  assert.equal(again.clientId, first.clientId);
});

test("ensureServiceToken returns secret only on create", async () => {
  const fake = fakeCloudflare();
  const cf = createCf({ token: TOKEN, accountId: "acc1", fetch: fake.fetch });
  const a = await cf.ensureServiceToken("tracker-hook");
  assert.ok(a.clientSecret && a.clientId && a.id);
  const b = await cf.ensureServiceToken("tracker-hook");
  assert.deepEqual([b.created, b.clientSecret, b.clientId], [false, null, a.clientId]);
});

test("ensurePolicy builds rules for emails, service token and everyone", async () => {
  const fake = fakeCloudflare();
  const cf = createCf({ token: TOKEN, accountId: "acc1", fetch: fake.fetch });
  await cf.ensurePolicy({ name: "allow", decision: "allow", emails: ["a@example.com"] });
  await cf.ensurePolicy({ name: "svc", decision: "non_identity", serviceTokenId: "st1" });
  await cf.ensurePolicy({ name: "bypass", decision: "bypass", everyone: true });
  const bodies = fake.calls.filter((c) => c.method === "POST").map((c) => c.body);
  assert.deepEqual(bodies[0].include, [{ email: { email: "a@example.com" } }]);
  assert.deepEqual(bodies[1].include, [{ service_token: { token_id: "st1" } }]);
  assert.deepEqual(bodies[2].include, [{ everyone: {} }]);
});

test("ensurePolicy updates the include list of an existing policy", async () => {
  const fake = fakeCloudflare({ policies: [{ id: "p1", name: "allow", decision: "allow", include: [] }] });
  const cf = createCf({ token: TOKEN, accountId: "acc1", fetch: fake.fetch });
  const r = await cf.ensurePolicy({ name: "allow", decision: "allow", emails: ["b@example.com"] });
  assert.equal(r.id, "p1");
  const put = fake.calls.find((c) => c.method === "PUT");
  assert.deepEqual(put.body.include, [{ email: { email: "b@example.com" } }]);
});

test("listByPrefix finds resources named with the prefix", async () => {
  const fake = fakeCloudflare({ d1: [{ uuid: "x", name: "cpt-test-db" }, { uuid: "y", name: "other-db" }], kv: [{ id: "k", title: "cpt-test-oauth" }] });
  const cf = createCf({ token: TOKEN, accountId: "acc1", fetch: fake.fetch });
  const r = await cf.listByPrefix("cpt-test");
  assert.deepEqual(r.d1.map((x) => x.name), ["cpt-test-db"]);
  assert.deepEqual(r.kv.map((x) => x.name), ["cpt-test-oauth"]);
});

test("errors are plain language", async () => {
  const fake = fakeCloudflare({ fail: { "GET /accounts": { status: 403, errors: [{ code: 10000, message: "Authentication error" }] } } });
  const cf = createCf({ token: TOKEN, fetch: fake.fetch });
  await assert.rejects(cf.whoami(), (e) => e instanceof CfError && e.status === 403 && /API token/.test(e.message) && /permission/i.test(e.message));
});

test("token never appears in thrown messages", async () => {
  const fake = fakeCloudflare({ fail: { "GET /accounts": { status: 400, errors: [{ code: 1, message: `bad header ${TOKEN}` }] } } });
  const cf = createCf({ token: TOKEN, fetch: fake.fetch });
  await assert.rejects(cf.whoami(), (e) => !String(e.message).includes(TOKEN) && !String(e.stack).includes(TOKEN));
});

test("sends the bearer token and JSON", async () => {
  const fake = fakeCloudflare();
  const cf = createCf({ token: TOKEN, accountId: "acc1", fetch: fake.fetch });
  await cf.ensureD1("x");
  assert.ok(fake.calls.every((c) => c.headers.authorization === `Bearer ${TOKEN}`));
});
