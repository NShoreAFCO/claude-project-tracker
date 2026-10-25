// The steps of `npm run setup`. Every step is safe to run again: Cloudflare resources are looked up by name,
// existing values in instance/ and secrets/ are reused. Secrets never go to the log or the command line.
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildInstance } from "../build-instance.mjs";
import { buildSeed } from "../../seed/build-seed.mjs";
import { createCf } from "./cf.mjs";
import { normaliseEmails, resolvePolicy } from "./instance.mjs";
import { putWorkerSecrets, readSecrets, scrubber, writeSecrets } from "./secrets.mjs";
import { runSteps } from "./steps.mjs";
import { runAccessChecks } from "./access-checks.mjs";

/** Names of every Cloudflare resource of one instance, derived from one base name. */
export function resourceNames(base) {
  return {
    base,
    worker: base,
    d1: `${base}-db`,
    kv: `${base}-oauth`,
    serviceToken: `${base}-hook`,
    policyAllow: `${base}-allow-users`,
    policyService: `${base}-hook-service-auth`,
    policyBypass: `${base}-bypass-machine-paths`,
    appA: base,
    appB: `${base}-machine-paths`,
    appC: `${base}-mcp-login`,
  };
}

export const BYPASS_PATHS = ["/mcp", "/mcp/*", "/oauth/*", "/.well-known/*", "/webhooks/github"];
export const WORKER_SECRETS = [
  "ACCESS_CLIENT_ID",
  "ACCESS_CLIENT_SECRET",
  "ACCESS_TOKEN_URL",
  "ACCESS_AUTHORIZATION_URL",
  "ACCESS_JWKS_URL",
  "COOKIE_ENCRYPTION_KEY",
  "GITHUB_WEBHOOK_SECRET",
];
const hex32 = () => randomBytes(32).toString("hex");
const configPath = (root) => join(root, "instance", "instance.config.json");

/**
 * @param {object} o
 * @param {string} o.root           repository root
 * @param {string} [o.prefix]       base name for all resources (e.g. "cpt-test"); default: the worker name
 * @param {object} o.io             { ask, askSecret, confirm, openUrl }
 * @param {typeof fetch} [o.cfFetch]
 * @param {Function} o.wrangler     (args, { input, env }) → { code, stdout, stderr }
 * @param {Function} o.gh           (args) → { code, stdout }
 * @param {typeof fetch} [o.checkFetch]
 * @param {number} [o.checkRetries]
 * @param {(line: string) => void} o.log
 */
export async function runSetup(o) {
  const { root, io, log } = o;
  const ctx = { secrets: readSecrets(root), names: null, cfg: null, cf: null };
  const save = () =>
    existsSync(join(root, "instance")) && ctx.cfg && writeFileSync(configPath(root), JSON.stringify(ctx.cfg, null, 2) + "\n");
  const putSecrets = (patch) => (ctx.secrets = writeSecrets(root, patch));
  const env = () => ({ CLOUDFLARE_API_TOKEN: ctx.secrets.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: ctx.cfg.deploy.accountId });
  const wrangler = async (args, opts = {}) => o.wrangler(args, { ...opts, env: env() });
  const mustWrangler = async (args, what, opts) => {
    const r = await wrangler(args, opts);
    if (r.code !== 0) throw new Error(`${what} failed: ${scrubber(ctx.secrets)(r.stderr || r.stdout).slice(-600)}`);
    return r;
  };
  ctx.afterStep = save;
  const d = () => ctx.cfg.deploy;
  const host = () => new URL(d().publicUrl).host;

  const steps = [
    {
      id: "prereqs",
      title: "Check tools",
      run: async () => {
        const major = Number(process.versions.node.split(".")[0]);
        if (major < 20) throw new Error(`Node.js ${process.versions.node} is too old. Install Node.js 20 or newer (see docs/INSTALL.md).`);
        return `Node.js ${process.versions.node}`;
      },
    },
    {
      id: "basics",
      title: "Instance settings",
      run: async () => {
        let note = "updated";
        if (!existsSync(join(root, "instance"))) {
          cpSync(join(root, "instance.example"), join(root, "instance"), { recursive: true });
          note = "created instance/ from instance.example/";
        }
        ctx.cfg = JSON.parse(readFileSync(configPath(root), "utf8"));
        ctx.cfg.upstream = false;
        ctx.cfg.checks = { ...(ctx.cfg.checks ?? {}), denylist: false };
        const c = ctx.cfg;
        c.app.name = await io.ask("Name shown in the dashboard header:", c.app.name);
        const locale = (await io.ask("Dashboard language (en or de):", c.app.locale)).toLowerCase();
        if (!["en", "de"].includes(locale)) throw new Error(`Language "${locale}" is not available. Use en or de.`);
        c.app.locale = locale;
        const emails = normaliseEmails(
          await io.ask("Email addresses allowed to use the tracker (comma-separated):", (c.deploy.allowedEmails ?? []).join(", ")),
        );
        if (!emails.length || emails.some((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))
          throw new Error("Enter at least one valid email address (for example jane@example.com).");
        c.deploy.allowedEmails = emails;
        // Admins (policy.admins) get the admin role on first login; everyone else gets policy.default_role.
        const currentAdmins = (c.policy?.admins ?? []).filter((e) => emails.includes(e));
        const admins = normaliseEmails(
          await io.ask(
            "Admin email(s), comma-separated (must be among the allowed addresses):",
            (currentAdmins.length ? currentAdmins : [emails[0]]).join(", "),
          ),
        );
        const notAllowed = admins.filter((e) => !emails.includes(e));
        if (!admins.length) throw new Error("Enter at least one admin email address.");
        if (notAllowed.length)
          throw new Error(`Admin ${notAllowed.join(", ")} is not among the allowed email addresses. Add it there first.`);
        c.policy = { ...resolvePolicy(c), ...(c.policy ?? {}), admins };
        const base =
          o.prefix ||
          (await io.ask(
            "Short name for the tracker (letters, digits, -; becomes part of the web address):",
            c.deploy.workerName || "project-tracker",
          ));
        if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(base))
          throw new Error(`"${base}" cannot be used as a name: use lower-case letters, digits and -.`);
        c.deploy.workerName = base;
        c.deploy.resourcePrefix = base;
        ctx.names = resourceNames(base);
        for (const [kind, label] of [
          ["project", "project types"],
          ["workpackage", "work types"],
        ]) {
          const list = c.categories[kind];
          const offNow = list.filter((x) => x.enabled === false).map((x) => x.key);
          const answer = await io.ask(
            `Switch off any ${label}? Available: ${list.map((x) => x.key).join(", ")}.\n  Type the keys to switch off (comma-separated), "none" to keep all, or Enter to keep the current choice:`,
            offNow.join(", "),
          );
          const off = answer.trim().toLowerCase() === "none" ? [] : answer.split(/[,;\s]+/).filter(Boolean);
          const unknown = off.filter((k) => !list.some((x) => x.key === k));
          if (unknown.length) throw new Error(`Unknown ${label}: ${unknown.join(", ")}.`);
          if (off.length >= list.length) throw new Error(`Keep at least one of the ${label}.`);
          for (const x of list) {
            if (off.includes(x.key)) x.enabled = false;
            else delete x.enabled;
          }
        }
        return note;
      },
    },
    {
      id: "cf-token",
      title: "Cloudflare API token",
      run: async () => {
        let note = "using the saved token";
        if (!ctx.secrets.CLOUDFLARE_API_TOKEN) {
          const t = await io.askSecret("Paste the Cloudflare API token (input is hidden) and press Enter: ");
          if (!t) throw new Error("No token entered. Create one as described in docs/INSTALL.md, step 'Cloudflare API token'.");
          putSecrets({ CLOUDFLARE_API_TOKEN: t });
          note = "saved to secrets/";
        }
        ctx.cf = createCf({ token: ctx.secrets.CLOUDFLARE_API_TOKEN, accountId: d().accountId || undefined, fetch: o.cfFetch });
        return note;
      },
    },
    {
      id: "account",
      title: "Cloudflare account, workers.dev address and Zero Trust team",
      run: async () => {
        const a = await ctx.cf.whoami();
        d().accountId = a.accountId;
        const sub = await ctx.cf.workersSubdomain();
        if (!sub)
          throw new Error(
            "This account has no workers.dev address yet. In the Cloudflare dashboard open 'Workers & Pages' once and choose a subdomain, then run setup again.",
          );
        const team = await ctx.cf.zeroTrustTeam();
        if (!team)
          throw new Error(
            "Zero Trust is not set up in this account. Open 'Zero Trust' in the Cloudflare dashboard, choose a team name and the Free plan, then run setup again.",
          );
        d().publicUrl = `https://${ctx.names.worker}.${sub}.workers.dev`;
        d().accessTeamDomain = team.teamDomain;
        return `${a.accountName}; ${d().publicUrl}; team ${team.teamDomain}`;
      },
    },
    {
      id: "d1",
      title: "Database (D1)",
      run: async () => {
        const r = await ctx.cf.ensureD1(ctx.names.d1);
        d().d1 = { name: ctx.names.d1, id: r.id };
        return `${ctx.names.d1} ${r.created ? "created" : "already there"}`;
      },
    },
    {
      id: "kv",
      title: "Login storage (KV)",
      run: async () => {
        const r = await ctx.cf.ensureKv(ctx.names.kv);
        d().kv = { id: r.id };
        return `${ctx.names.kv} ${r.created ? "created" : "already there"}`;
      },
    },
    {
      id: "access-otp",
      title: "Email code login (one-time PIN)",
      run: async () => ((await ctx.cf.ensureOtpIdp()).created ? "switched on" : "already on"),
    },
    {
      id: "service-token",
      title: "Service token for the Claude Code hook",
      run: async () => {
        const r = await ctx.cf.ensureServiceToken(ctx.names.serviceToken);
        ctx.serviceTokenId = r.id;
        let secret = r.clientSecret;
        let note = r.created ? "created" : "already there";
        if (!secret && !ctx.secrets.HOOK_CLIENT_SECRET) {
          secret = (await ctx.cf.rotateServiceToken(r.id)).clientSecret;
          note = "secret was not saved locally; issued a new one";
        }
        if (secret) putSecrets({ HOOK_CLIENT_ID: r.clientId, HOOK_CLIENT_SECRET: secret });
        d().allowedServiceTokenIds = [r.clientId];
        return note;
      },
    },
    {
      id: "policies",
      title: "Access policies",
      run: async () => {
        ctx.policy = {
          allow: (await ctx.cf.ensurePolicy({ name: ctx.names.policyAllow, decision: "allow", emails: d().allowedEmails })).id,
          service: (
            await ctx.cf.ensurePolicy({ name: ctx.names.policyService, decision: "non_identity", serviceTokenId: ctx.serviceTokenId })
          ).id,
          bypass: (await ctx.cf.ensurePolicy({ name: ctx.names.policyBypass, decision: "bypass", everyone: true })).id,
        };
        return `allowed: ${d().allowedEmails.join(", ")}`;
      },
    },
    {
      id: "app-a",
      title: "Access application: whole tracker",
      run: async () => {
        const r = await ctx.cf.ensureAccessApp({
          type: "self_hosted",
          name: ctx.names.appA,
          domain: host(),
          policies: [ctx.policy.allow, ctx.policy.service],
        });
        d().accessAud = r.aud;
        return r.created ? "created" : "already there";
      },
    },
    {
      id: "app-b",
      title: "Access application: machine paths (MCP, OAuth, webhook)",
      run: async () => {
        const r = await ctx.cf.ensureAccessApp({
          type: "self_hosted",
          name: ctx.names.appB,
          domain: host(),
          paths: BYPASS_PATHS,
          policies: [ctx.policy.bypass],
        });
        return r.created ? "created" : "already there";
      },
    },
    {
      id: "app-c",
      title: "Access application: login for Claude (OIDC)",
      run: async () => {
        const spec = {
          type: "saas_oidc",
          name: ctx.names.appC,
          redirectUris: [`${d().publicUrl}/callback`, "http://localhost:8788/callback"],
          policies: [ctx.policy.allow],
          teamDomain: d().accessTeamDomain,
        };
        let r = await ctx.cf.ensureAccessApp(spec);
        let note = r.created ? "created" : "already there";
        if (!r.created && !ctx.secrets.ACCESS_CLIENT_SECRET) {
          await ctx.cf.deleteResource("app", r.id);
          r = await ctx.cf.ensureAccessApp(spec);
          note = "client secret was not saved locally; recreated the application";
        }
        const patch = {
          ACCESS_CLIENT_ID: r.clientId,
          ACCESS_TOKEN_URL: r.tokenUrl,
          ACCESS_AUTHORIZATION_URL: r.authorizationUrl,
          ACCESS_JWKS_URL: r.jwksUrl,
        };
        if (r.clientSecret) patch.ACCESS_CLIENT_SECRET = r.clientSecret;
        putSecrets(patch);
        return note;
      },
    },
    {
      id: "generate-secrets",
      title: "Generate encryption and webhook secrets",
      run: async () => {
        const patch = {};
        if (!ctx.secrets.COOKIE_ENCRYPTION_KEY) patch.COOKIE_ENCRYPTION_KEY = hex32();
        if (!ctx.secrets.GITHUB_WEBHOOK_SECRET) patch.GITHUB_WEBHOOK_SECRET = hex32();
        putSecrets(patch);
        return Object.keys(patch).length ? `generated ${Object.keys(patch).join(", ")}` : "already there";
      },
    },
    {
      id: "audit",
      title: "Optional audit log (GitHub)",
      run: async () => {
        if (d().auditRepo && ctx.secrets.AUDIT_GITHUB_TOKEN) return `already set: ${d().auditRepo}`;
        if (!(await io.confirm("Set up the optional hourly audit log in a private GitHub repository?", false))) return "skipped";
        const who = await o.gh(["api", "user", "-q", ".login"]);
        if (who.code !== 0) throw new Error("The GitHub CLI is not logged in. Run `gh auth login`, then setup again.");
        const repo = await io.ask("Audit repository (owner/name):", `${who.stdout.trim()}/${ctx.names.base}-audit`);
        const made = await o.gh(["repo", "create", repo, "--private", "--add-readme"]);
        if (made.code !== 0 && !/already exists/i.test(made.stdout ?? ""))
          throw new Error(`Could not create ${repo}. Create it by hand (private, with a README) and run setup again.`);
        await io.openUrl("https://github.com/settings/personal-access-tokens/new");
        log(
          `    In the browser: fine-grained token, repository access "Only ${repo}", permission Contents: Read and write, expiry 1 year.`,
        );
        const pat = await io.askSecret("Paste the new GitHub token (input is hidden) and press Enter: ");
        if (!pat) throw new Error("No token entered.");
        putSecrets({ AUDIT_GITHUB_TOKEN: pat });
        d().auditRepo = repo;
        return repo;
      },
    },
    {
      id: "build",
      title: "Generate configuration files",
      run: async () => {
        save();
        buildInstance(root);
        buildSeed(root);
        return "wrangler.jsonc, dashboard config, seed";
      },
    },
    {
      id: "migrate",
      title: "Create database tables",
      run: async () => {
        await mustWrangler(["d1", "migrations", "apply", d().d1.name, "--remote"], "Applying the database migrations");
      },
    },
    {
      id: "deploy",
      title: "Deploy the Worker",
      run: async () => {
        await mustWrangler(["deploy"], "Deploying");
        return d().publicUrl;
      },
    },
    {
      id: "push-secrets",
      title: "Store secrets in Cloudflare",
      run: async () => {
        const names = [...WORKER_SECRETS, ...(ctx.secrets.AUDIT_GITHUB_TOKEN ? ["AUDIT_GITHUB_TOKEN"] : [])];
        await putWorkerSecrets(names, { secrets: ctx.secrets, wrangler });
        return `${names.length} secrets`;
      },
    },
    {
      id: "seed",
      title: "Demo data",
      run: async () => {
        const r = await mustWrangler(
          ["d1", "execute", d().d1.name, "--remote", "--json", "--command", "SELECT count(*) AS n FROM project"],
          "Reading the database",
        );
        const n = JSON.parse(r.stdout)?.[0]?.results?.[0]?.n;
        if (n !== 0) return "skipped (the database already has projects)";
        await mustWrangler(["d1", "execute", d().d1.name, "--remote", "--file", "seed/seed.sql"], "Loading the demo data");
        return "loaded";
      },
    },
    {
      id: "checks",
      title: "Check the access protection",
      run: async () => {
        const results = await runAccessChecks({ publicUrl: d().publicUrl, fetch: o.checkFetch, retries: o.checkRetries ?? 6 });
        const bad = results.filter((r) => !r.ok);
        if (bad.length)
          throw new Error(
            `Access is not set up correctly yet: ${bad.map((b) => `${b.name} (${b.detail})`).join("; ")}. Wait two minutes and run \`npm run setup:check\`.`,
          );
        return "all 4 checks passed";
      },
    },
    {
      id: "next-steps",
      title: "Done",
      run: async () => {
        log("");
        log(`  Dashboard:        ${d().publicUrl}  (sign in with an allowed email; a code arrives by email)`);
        log(`  claude.ai:        Settings → Connectors → Add custom connector → ${d().publicUrl}/mcp`);
        log(`  Claude Code:      claude mcp add --transport http tracker ${d().publicUrl}/mcp --scope user`);
        log(`  Session hook:     npm run hook:install`);
        log(`  Commit instance/: git add instance && git commit -m "Instance settings"`);
        log(`                    (any time now; it does not depend on the steps above. Commit again after each setup rerun.)`);
      },
    },
  ];

  log("Setting up the project tracker. Every step can be repeated safely.");
  return runSteps(steps, ctx, log, (s) => scrubber(ctx.secrets)(s));
}
