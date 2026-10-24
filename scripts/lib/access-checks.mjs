// Checks that a deployed tracker is protected the way docs/SPEC.md §3 describes.

const CHECKS = [
  {
    name: "Dashboard redirects to the Cloudflare Access login",
    path: "/",
    init: { method: "GET" },
    ok: (r) => [301, 302, 303].includes(r.status) && /cloudflareaccess\.com/.test(r.headers.get("location") ?? ""),
    want: "302 to <team>.cloudflareaccess.com",
  },
  {
    name: "API is not reachable without a login",
    path: "/api/projects",
    init: { method: "GET" },
    ok: (r) => r.status !== 200,
    want: "anything but 200",
  },
  { name: "MCP endpoint demands a token", path: "/mcp", init: { method: "POST" }, ok: (r) => r.status === 401, want: "401" },
  {
    name: "GitHub webhook demands a signature",
    path: "/webhooks/github",
    init: { method: "POST" },
    ok: (r) => r.status === 401,
    want: "401",
  },
];

/**
 * Runs the four access checks; retries while Access settings propagate.
 * @returns {Promise<Array<{ name: string, ok: boolean, detail: string }>>}
 */
export async function runAccessChecks({ publicUrl, fetch: doFetch = globalThis.fetch, retries = 6, delayMs = 10_000 }) {
  let results = [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    results = [];
    for (const c of CHECKS) {
      try {
        const r = await doFetch(new URL(c.path, publicUrl).toString(), {
          ...c.init,
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
        results.push({ name: c.name, ok: c.ok(r), detail: `got ${r.status}, want ${c.want}` });
      } catch (e) {
        results.push({ name: c.name, ok: false, detail: `no answer (${e.message})` });
      }
    }
    if (results.every((r) => r.ok) || attempt === retries) return results;
    await new Promise((res) => setTimeout(res, delayMs));
  }
  return results;
}
