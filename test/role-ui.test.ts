import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error untyped JS module
import { can, loadMe, role, MIN_ROLE, ROLES, roleTip } from "../public/js/access.js";
// @ts-expect-error untyped JS module
import { setLocale, t, LOCALE, AVAILABLE, storedLocale, rememberLocale, fmtDate } from "../public/js/i18n.js";
import { MIN_ROLE as SERVER_MIN_ROLE, ACTIONS } from "../src/auth/permissions";
// @ts-expect-error untyped JS module
import config from "../public/instance/config.js";

describe("R5.3 role-based UI helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    setLocale("en");
  });

  it("keeps client permissions exactly aligned with server permissions", () => {
    expect(MIN_ROLE).toEqual(SERVER_MIN_ROLE);
    expect(Object.keys(MIN_ROLE).sort()).toEqual([...ACTIONS].sort());
  });

  const expectedByRole = {
    viewer: ["read"],
    editor: ["read", "write"],
    decider: ["read", "write", "decide", "close", "verify_sign_off"],
    admin: ["read", "write", "decide", "close", "verify_sign_off", "manage_roles", "purge"],
  } as const;

  for (const accessRole of ROLES) {
    it(`enforces the full action matrix for ${accessRole}`, async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({
            identity: "x",
            person: {
              id: "p1",
              name: "N",
              access_role: accessRole,
            },
          }),
        ),
      );

      await loadMe();

      expect(role()).toBe(accessRole);

      for (const action of ACTIONS) {
        expect(can(action), `${accessRole} / ${action}`).toBe(
          expectedByRole[accessRole as keyof typeof expectedByRole].includes(action as never),
        );
      }
    });
  }

  it("clears the cached role when whoami fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("network failure"))),
    );

    expect(await loadMe()).toBeNull();
    expect(role()).toBeNull();
    expect(can("read")).toBe(false);
  });

  it("has no role when whoami returns a null person", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          identity: "x",
          person: null,
        }),
      ),
    );

    expect(await loadMe()).toBeNull();
    expect(role()).toBeNull();
    expect(can("read")).toBe(false);
  });

  it("rejects unknown and inherited action names even for admin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          identity: "x",
          person: {
            id: "p1",
            name: "N",
            access_role: "admin",
          },
        }),
      ),
    );

    await loadMe();

    expect(can("constructor")).toBe(false);
    expect(can("toString")).toBe(false);
    expect(can("nope")).toBe(false);
  });

  it("switches locales at runtime and tolerates unavailable localStorage", () => {
    expect(AVAILABLE).toContain("en");
    expect(AVAILABLE).toContain("de");
    expect(storedLocale()).toBeNull();

    expect(setLocale("de")).toBe(true);
    expect(LOCALE).toBe("de");
    expect(t("navProjects")).toBe("Projekte");
    const germanDate = fmtDate("2026-03-05");

    expect(setLocale("xx")).toBe(false);
    expect(LOCALE).toBe("de");
    expect(t("navProjects")).toBe("Projekte");

    expect(setLocale("en")).toBe(true);
    expect(LOCALE).toBe("en");
    expect(t("navProjects")).toBe("Projects");
    const englishDate = fmtDate("2026-03-05");

    expect(englishDate).not.toBe(germanDate);
    expect(() => rememberLocale("de")).not.toThrow();
  });

  it("provides role-gated strings in both locales", () => {
    expect(setLocale("en")).toBe(true);
    expect(t("needsRole", { role: "X" })).toContain("X");
    expect(roleTip("purge")).toContain("Admin");

    expect(setLocale("de")).toBe(true);
    expect(t("needsRole", { role: "X" })).toContain("X");

    expect(setLocale("en")).toBe(true);
  });

  it("exposes only the expected public policy configuration", () => {
    expect(config.policy.locales).toContain("en");
    expect(["hide", "collapse"]).toContain(config.policy.hide_empty_categories);
    expect(Object.keys(config.policy).sort()).toEqual(["hide_empty_categories", "locales", "target_date_required_categories"].sort());
  });
});
