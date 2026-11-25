import { applyD1Migrations, env } from "cloudflare:test";
import { vi } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Dashboard tests compare English text, so they must not depend on the instance the checkout is built for
// (public/instance/config.js is generated from instance/ when present). Pin the locale, the app name and the
// string overrides; everything else (categories, theme) stays. Tests that want German call setLocale("de").
vi.mock("../public/instance/config.js", async (importOriginal) => {
  const mod = await importOriginal<{ default: Record<string, any> }>();
  const { strings: _strings, ...rest } = mod.default;
  return { ...mod, default: { ...rest, app: { ...rest.app, name: "Project Tracker", locale: "en" } } };
});
