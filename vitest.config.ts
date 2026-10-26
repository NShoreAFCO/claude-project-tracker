import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";
// @ts-expect-error untyped JS module
import { buildSeed } from "./seed/build-seed.mjs";

/** The acceptance test seeds from the example seed, whatever instance/ is built: run the real seed generator on a temp root that holds only instance.example/seed.json. */
function exampleSeedSql(): string {
  const root = mkdtempSync(join(tmpdir(), "tracker-example-seed-"));
  try {
    mkdirSync(join(root, "seed"));
    mkdirSync(join(root, "instance.example"));
    cpSync("instance.example/seed.json", join(root, "instance.example", "seed.json"));
    buildSeed(root);
    return readFileSync(join(root, "seed", "seed.sql"), "utf8");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export default defineConfig({
  define: { __EXAMPLE_SEED_SQL__: JSON.stringify(exampleSeedSql()) },
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Test-only values; override the SETUP placeholders from wrangler.jsonc.
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("migrations"),
          PUBLIC_URL: "https://tracker.test",
          ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
          ACCESS_AUD: "test-aud-app-a",
          ALLOWED_EMAILS: "user@example.com",
          ALLOWED_SERVICE_TOKEN_IDS: "svc-hook.access",
          ACCESS_CLIENT_ID: "oidc-client",
          ACCESS_CLIENT_SECRET: "oidc-secret",
          ACCESS_TOKEN_URL: "https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/oidc-client/token",
          ACCESS_AUTHORIZATION_URL: "https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/oidc-client/authorization",
          ACCESS_JWKS_URL: "https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/oidc-client/jwks",
          COOKIE_ENCRYPTION_KEY: "test-cookie-key-0123456789abcdef0123456789abcdef",
          GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
          AUDIT_GITHUB_TOKEN: "test-audit-token",
          AUDIT_REPO: "example-org/tracker-audit",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
  },
});
