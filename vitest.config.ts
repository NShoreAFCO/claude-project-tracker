import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
