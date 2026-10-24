// In-memory stand-in for the Cloudflare REST API (the subset the setup scripts use). Test helper only.
let seq = 0;
const nextId = (p) => `${p}-${++seq}`;

/**
 * @param {object} [state] initial lists: d1, kv, apps, policies, tokens, idps; `fail` maps "METHOD /path" → { status, errors };
 *   `perPage` forces pagination; `subdomain`, `authDomain` override defaults (null = not set up).
 */
export function fakeCloudflare(state = {}) {
  const db = {
    accounts: state.accounts ?? [{ id: "acc1", name: "Example account" }],
    d1: [...(state.d1 ?? [])],
    kv: [...(state.kv ?? [])],
    apps: [...(state.apps ?? [])],
    policies: [...(state.policies ?? [])],
    tokens: [...(state.tokens ?? [])],
    idps: [...(state.idps ?? [])],
    scripts: [...(state.scripts ?? [])],
  };
  const subdomain = state.subdomain === undefined ? "example" : state.subdomain;
  const authDomain = state.authDomain === undefined ? "team.cloudflareaccess.com" : state.authDomain;
  const perPage = state.perPage ?? 50;
  const fail = { ...(state.fail ?? {}) };
  const calls = [];

  const ok = (result, extra = {}) => new Response(JSON.stringify({ success: true, errors: [], messages: [], result, ...extra }), { status: 200 });
  const err = (status, errors) => new Response(JSON.stringify({ success: false, errors, messages: [], result: null }), { status });
  const page = (list, url) => {
    const p = Number(url.searchParams.get("page") ?? 1);
    const per = Math.min(Number(url.searchParams.get("per_page") ?? perPage), perPage);
    return ok(list.slice((p - 1) * per, p * per), { result_info: { page: p, per_page: per, total_count: list.length, total_pages: Math.max(1, Math.ceil(list.length / per)) } });
  };

  async function fetch(input, init = {}) {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/client\/v4/, "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ method, path, body, headers });
    const key = `${method} ${path}`;
    if (fail[key]) {
      const f = fail[key];
      if (f.once) delete fail[key];
      return err(f.status, f.errors ?? [{ code: 1, message: "failed" }]);
    }
    const m = (re) => re.exec(path);
    let r;
    if (key === "GET /accounts") return page(db.accounts, url);
    if ((r = m(/^\/accounts\/[^/]+\/workers\/subdomain$/)) && method === "GET")
      return subdomain ? ok({ subdomain }) : err(404, [{ code: 10007, message: "This account does not have a subdomain" }]);
    if (m(/^\/accounts\/[^/]+\/access\/organizations$/) && method === "GET")
      return authDomain ? ok({ auth_domain: authDomain, name: "team" }) : err(404, [{ code: 12130, message: "access.api.error.not_found" }]);
    if (m(/^\/accounts\/[^/]+\/access\/identity_providers$/)) {
      if (method === "GET") return page(db.idps, url);
      const idp = { id: nextId("idp"), ...body };
      db.idps.push(idp);
      return ok(idp);
    }
    if (m(/^\/accounts\/[^/]+\/d1\/database$/)) {
      if (method === "GET") {
        const name = url.searchParams.get("name");
        return page(name ? db.d1.filter((d) => d.name.includes(name)) : db.d1, url);
      }
      const d = { uuid: nextId("d1"), name: body.name };
      db.d1.push(d);
      return ok(d);
    }
    if (m(/^\/accounts\/[^/]+\/storage\/kv\/namespaces$/)) {
      if (method === "GET") return page(db.kv, url);
      const k = { id: nextId("kv"), title: body.title };
      db.kv.push(k);
      return ok(k);
    }
    if (m(/^\/accounts\/[^/]+\/access\/service_tokens$/)) {
      if (method === "GET") return page(db.tokens.map(({ client_secret, ...t }) => t), url);
      const t = { id: nextId("st"), name: body.name, duration: body.duration, client_id: `${nextId("cid")}.access`, client_secret: nextId("csecret") };
      db.tokens.push(t);
      return ok(t);
    }
    if (m(/^\/accounts\/[^/]+\/access\/policies$/)) {
      if (method === "GET") return page(db.policies, url);
      const p = { id: nextId("pol"), ...body };
      db.policies.push(p);
      return ok(p);
    }
    if ((r = m(/^\/accounts\/[^/]+\/access\/policies\/([^/]+)$/)) && method === "PUT") {
      const p = db.policies.find((x) => x.id === r[1]);
      Object.assign(p, body);
      return ok(p);
    }
    if (m(/^\/accounts\/[^/]+\/access\/apps$/)) {
      if (method === "GET")
        return page(db.apps.map((a) => (a.saas_app ? { ...a, saas_app: { ...a.saas_app, client_secret: undefined } } : a)), url);
      const a = { id: nextId("app"), aud: nextId("aud"), ...body };
      if (body.type === "saas") a.saas_app = { ...body.saas_app, client_id: nextId("oidc"), client_secret: nextId("oidcsecret") };
      db.apps.push(a);
      return ok(a);
    }
    if ((r = m(/^\/accounts\/[^/]+\/(d1\/database|storage\/kv\/namespaces|access\/apps|access\/policies|access\/service_tokens|workers\/scripts)\/([^/]+)$/)) && method === "DELETE") {
      const list = { "d1/database": db.d1, "storage/kv/namespaces": db.kv, "access/apps": db.apps, "access/policies": db.policies, "access/service_tokens": db.tokens, "workers/scripts": db.scripts }[r[1]];
      const i = list.findIndex((x) => (x.uuid ?? x.id) === r[2]);
      if (i < 0) return err(404, [{ code: 7003, message: "not found" }]);
      list.splice(i, 1);
      return ok({ id: r[2] });
    }
    if (m(/^\/accounts\/[^/]+\/workers\/scripts$/) && method === "GET") return ok(db.scripts);
    return err(404, [{ code: 7000, message: `No route for ${key}` }]);
  }

  return { fetch, calls, db };
}
