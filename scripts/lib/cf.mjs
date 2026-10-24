// Minimal Cloudflare REST client for the setup scripts (endpoints verified in docs/VERIFIED.md).
// Every ensure* call looks a resource up by exact name first and creates it only if it is missing,
// so setup can be re-run after a failure. The API token never appears in errors or logs.
const BASE = "https://api.cloudflare.com/client/v4";

export class CfError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "CfError";
    this.status = status;
  }
}

/** A plain-language explanation for common failures; the API's own message follows it. */
function explain(status, apiMessage, what) {
  if (status === 401 || status === 403)
    return `Cloudflare refused ${what} (${status}). Check that the API token is correct, not expired, and has the permissions listed in docs/INSTALL.md. Cloudflare said: ${apiMessage}`;
  if (status === 404) return `Cloudflare could not find ${what} (404). Cloudflare said: ${apiMessage}`;
  if (status === 429) return `Cloudflare is rate-limiting requests. Wait a minute and run the command again.`;
  if (status >= 500) return `Cloudflare had a temporary problem with ${what} (${status}). Run the command again in a few minutes.`;
  return `Cloudflare rejected ${what} (${status}). Cloudflare said: ${apiMessage}`;
}

/**
 * @param {{ token: string, accountId?: string, fetch?: typeof fetch }} opts
 */
export function createCf({ token, accountId, fetch: doFetch = globalThis.fetch }) {
  if (!token) throw new CfError(0, "No Cloudflare API token was given.");
  const scrub = (s) =>
    String(s ?? "")
      .split(token)
      .join("[token]");
  let account = accountId ?? null;

  async function req(method, path, body, what = `${method} ${path}`) {
    let res;
    try {
      res = await doFetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new CfError(0, `Could not reach Cloudflare (${scrub(e.message)}). Check the internet connection and try again.`);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON body */
    }
    if (!res.ok || !data?.success) {
      const apiMessage = scrub((data?.errors ?? []).map((e) => `${e.message} [${e.code}]`).join("; ") || res.statusText);
      throw new CfError(res.status, explain(res.status, apiMessage, what));
    }
    return data;
  }

  async function list(path, what) {
    const out = [];
    for (let page = 1; ; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const data = await req("GET", `${path}${sep}page=${page}&per_page=50`, undefined, what);
      out.push(...(data.result ?? []));
      const total = data.result_info?.total_pages ?? 1;
      if (page >= total || !(data.result ?? []).length) return out;
    }
  }

  const acc = () => {
    if (!account) throw new CfError(0, "No Cloudflare account selected (call whoami first).");
    return `/accounts/${account}`;
  };

  return {
    /** The account to work in: the configured one, or the only one the token can see. */
    async whoami() {
      const accounts = await list("/accounts", "the account list");
      if (account) {
        const a = accounts.find((x) => x.id === account);
        if (!a) throw new CfError(404, `The API token cannot see account ${account}. Create the token in that account.`);
        return { accountId: a.id, accountName: a.name };
      }
      if (accounts.length === 1) {
        account = accounts[0].id;
        return { accountId: accounts[0].id, accountName: accounts[0].name };
      }
      if (!accounts.length)
        throw new CfError(403, "The API token cannot see any Cloudflare account. Check its 'Account Resources' setting.");
      throw new CfError(
        0,
        `The API token can see several accounts (${accounts.map((a) => `${a.name} = ${a.id}`).join(", ")}). Limit the token to one account, or set deploy.accountId in the instance config.`,
      );
    },

    /** "<subdomain>" of <subdomain>.workers.dev, or null if Workers was never opened in this account. */
    async workersSubdomain() {
      try {
        return (await req("GET", `${acc()}/workers/subdomain`, undefined, "the workers.dev subdomain")).result?.subdomain ?? null;
      } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
    },

    /** Zero Trust team domain (<team>.cloudflareaccess.com), or null if Zero Trust is not set up. */
    async zeroTrustTeam() {
      try {
        const r = (await req("GET", `${acc()}/access/organizations`, undefined, "the Zero Trust organisation")).result;
        return r?.auth_domain ? { teamDomain: r.auth_domain } : null;
      } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
    },

    /** Make sure the one-time PIN login method exists (people sign in with a code sent by email). */
    async ensureOtpIdp() {
      const idps = await list(`${acc()}/access/identity_providers`, "the login methods");
      const found = idps.find((i) => i.type === "onetimepin");
      if (found) return { id: found.id, created: false };
      const r = await req(
        "POST",
        `${acc()}/access/identity_providers`,
        { name: "One-time PIN", type: "onetimepin", config: {} },
        "creating the one-time PIN login",
      );
      return { id: r.result.id, created: true };
    },

    async ensureD1(name) {
      const found = (await list(`${acc()}/d1/database?name=${encodeURIComponent(name)}`, "the D1 databases")).find((d) => d.name === name);
      if (found) return { id: found.uuid, created: false };
      const r = await req("POST", `${acc()}/d1/database`, { name }, `creating D1 database "${name}"`);
      return { id: r.result.uuid, created: true };
    },

    async ensureKv(title) {
      const found = (await list(`${acc()}/storage/kv/namespaces`, "the KV namespaces")).find((k) => k.title === title);
      if (found) return { id: found.id, created: false };
      const r = await req("POST", `${acc()}/storage/kv/namespaces`, { title }, `creating KV namespace "${title}"`);
      return { id: r.result.id, created: true };
    },

    /** clientSecret is only known when the token is created now; otherwise null. */
    async ensureServiceToken(name, duration = "8760h") {
      const found = (await list(`${acc()}/access/service_tokens`, "the service tokens")).find((t) => t.name === name);
      if (found) return { id: found.id, clientId: found.client_id, clientSecret: null, created: false };
      const r = (await req("POST", `${acc()}/access/service_tokens`, { name, duration }, `creating service token "${name}"`)).result;
      return { id: r.id, clientId: r.client_id, clientSecret: r.client_secret, created: true };
    },

    /** New client secret for an existing service token (the old one stops working). */
    async rotateServiceToken(id) {
      const r = (await req("POST", `${acc()}/access/service_tokens/${id}/rotate`, {}, "rotating the service token secret")).result;
      return { id: r.id, clientId: r.client_id, clientSecret: r.client_secret };
    },

    /** Reusable Access policy; an existing one with the same name gets its decision and rules updated. */
    async ensurePolicy({ name, decision, emails, serviceTokenId, everyone }) {
      const include = [
        ...(emails ?? []).map((email) => ({ email: { email } })),
        ...(serviceTokenId ? [{ service_token: { token_id: serviceTokenId } }] : []),
        ...(everyone ? [{ everyone: {} }] : []),
      ];
      if (!include.length) throw new CfError(0, `Access policy "${name}" needs at least one rule (emails, service token or everyone).`);
      const body = { name, decision, include };
      const found = (await list(`${acc()}/access/policies`, "the Access policies")).find((p) => p.name === name);
      if (found) {
        await req("PUT", `${acc()}/access/policies/${found.id}`, body, `updating Access policy "${name}"`);
        return { id: found.id, created: false };
      }
      const r = await req("POST", `${acc()}/access/policies`, body, `creating Access policy "${name}"`);
      return { id: r.result.id, created: true };
    },

    /**
     * spec.type "self_hosted": { name, domain, paths?: string[], policies: string[] } — paths become public destinations.
     * spec.type "saas_oidc": { name, redirectUris, policies, teamDomain } — returns OIDC client values and endpoints.
     */
    async ensureAccessApp(spec) {
      const found = (await list(`${acc()}/access/apps`, "the Access applications")).find((a) => a.name === spec.name);
      let app = found;
      if (!found) {
        let body;
        if (spec.type === "self_hosted") {
          const uris = spec.paths?.length ? spec.paths.map((p) => spec.domain + p) : [spec.domain];
          body = {
            type: "self_hosted",
            name: spec.name,
            domain: uris[0],
            destinations: uris.map((uri) => ({ type: "public", uri })),
            policies: spec.policies,
            app_launcher_visible: false,
          };
        } else if (spec.type === "saas_oidc") {
          body = {
            type: "saas",
            name: spec.name,
            policies: spec.policies,
            saas_app: {
              auth_type: "oidc",
              redirect_uris: spec.redirectUris,
              grant_types: ["authorization_code_with_pkce", "refresh_tokens"],
              scopes: ["openid", "email", "profile"],
              refresh_token_options: { lifetime: "90d" },
            },
          };
        } else throw new CfError(0, `Unknown Access application type "${spec.type}".`);
        app = (await req("POST", `${acc()}/access/apps`, body, `creating Access application "${spec.name}"`)).result;
      }
      const out = { id: app.id, aud: app.aud, created: !found };
      if (spec.type === "saas_oidc") {
        const clientId = app.saas_app?.client_id;
        const base = `https://${spec.teamDomain}/cdn-cgi/access/sso/oidc/${clientId}`;
        Object.assign(out, {
          clientId,
          clientSecret: found ? null : (app.saas_app?.client_secret ?? null),
          tokenUrl: `${base}/token`,
          authorizationUrl: `${base}/authorization`,
          jwksUrl: `${base}/jwks`,
        });
      }
      return out;
    },

    /** Everything whose name starts with prefix: { d1, kv, apps, policies, serviceTokens } as [{ id, name }]. */
    async listByPrefix(prefix) {
      const pick = (items, idKey, nameKey) =>
        items.filter((x) => String(x[nameKey] ?? "").startsWith(prefix)).map((x) => ({ id: x[idKey], name: x[nameKey] }));
      return {
        d1: pick(await list(`${acc()}/d1/database`, "the D1 databases"), "uuid", "name"),
        kv: pick(await list(`${acc()}/storage/kv/namespaces`, "the KV namespaces"), "id", "title"),
        apps: pick(await list(`${acc()}/access/apps`, "the Access applications"), "id", "name"),
        policies: pick(await list(`${acc()}/access/policies`, "the Access policies"), "id", "name"),
        serviceTokens: pick(await list(`${acc()}/access/service_tokens`, "the service tokens"), "id", "name"),
      };
    },

    /** kind: d1 | kv | app | policy | serviceToken | worker (id = script name for worker). */
    async deleteResource(kind, id) {
      const seg = {
        d1: "d1/database",
        kv: "storage/kv/namespaces",
        app: "access/apps",
        policy: "access/policies",
        serviceToken: "access/service_tokens",
        worker: "workers/scripts",
      }[kind];
      if (!seg) throw new CfError(0, `Unknown resource kind "${kind}".`);
      await req("DELETE", `${acc()}/${seg}/${encodeURIComponent(id)}`, undefined, `deleting ${kind} ${id}`);
    },
  };
}
