import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error untyped JS module
import { can, loadMe, role, MIN_ROLE, ROLES, roleTip } from "../public/js/access.js";
// @ts-expect-error untyped JS module
import { projectStatusOptions, wpStatusOptions, wpVerificationOptions } from "../public/js/forms.js";
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

describe("R5.3 role-gated form options", () => {
  const WP_STATUSES = ["todo", "doing", "blocked", "waiting", "done", "dropped"];
  const METHODS = ["none", "review", "test", "demo", "sign_off"];
  type Opt = [string, string, { disabled?: boolean; title?: string }?];
  const disabled = (opts: Opt[]) => opts.filter((o) => o[2]?.disabled).map((o) => o[0]);

  async function actAs(accessRole: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ identity: "x", person: { id: "p1", name: "N", access_role: accessRole } })),
    );
    await loadMe();
  }
  afterEach(() => vi.unstubAllGlobals());

  it("Done is gated by the selected verification, not by the stored one (editor)", async () => {
    await actAs("editor");
    // stored sign_off, open WP
    expect(disabled(wpStatusOptions({ verification: "sign_off", status: "doing" }, WP_STATUSES))).toEqual(["done"]);
    // stored none, but the form currently has sign_off selected
    expect(disabled(wpStatusOptions({ verification: "none", status: "doing" }, WP_STATUSES, "sign_off"))).toEqual(["done"]);
    expect(disabled(wpStatusOptions(null, WP_STATUSES, "sign_off"))).toEqual(["done"]);
    // stored sign_off but the form lowered it? (selection review) Done is allowed by this helper
    expect(disabled(wpStatusOptions({ verification: "sign_off", status: "doing" }, WP_STATUSES, "review"))).toEqual([]);
    // other methods and an already done WP stay selectable
    expect(disabled(wpStatusOptions({ verification: "review", status: "doing" }, WP_STATUSES))).toEqual([]);
    expect(disabled(wpStatusOptions({ verification: "sign_off", status: "done" }, WP_STATUSES))).toEqual([]);
    const done = wpStatusOptions({ verification: "sign_off", status: "doing" }, WP_STATUSES).find((o: Opt) => o[0] === "done");
    expect(done?.[2]?.title).toBe(roleTip("verify_sign_off"));
  });

  it("deciders and admins may complete a sign_off WP", async () => {
    for (const r of ["decider", "admin"]) {
      await actAs(r);
      expect(disabled(wpStatusOptions({ verification: "sign_off", status: "doing" }, WP_STATUSES, "sign_off"))).toEqual([]);
    }
  });

  it("sign_off stays selectable for editors; lowering it from sign_off is gated", async () => {
    await actAs("editor");
    expect(disabled(wpVerificationOptions({ verification: "review" }, METHODS))).toEqual([]);
    expect(disabled(wpVerificationOptions(null, METHODS))).toEqual([]);
    expect(disabled(wpVerificationOptions({ verification: "sign_off" }, METHODS))).toEqual(["none", "review", "test", "demo"]);
    await actAs("decider");
    expect(disabled(wpVerificationOptions({ verification: "sign_off" }, METHODS))).toEqual([]);
  });

  it("closing and reopening a project needs a decider", async () => {
    await actAs("editor");
    expect(projectStatusOptions(null, false, "").map((o: Opt) => o[0])).toEqual(["idea", "active", "on_hold"]);
    expect(disabled(projectStatusOptions({ status: "active" }, false, ""))).toEqual(["done", "abandoned"]);
    expect(disabled(projectStatusOptions({ status: "done" }, false, ""))).toEqual(["idea", "active", "on_hold", "abandoned"]);
    await actAs("decider");
    expect(disabled(projectStatusOptions({ status: "done" }, false, ""))).toEqual([]);
    expect(disabled(projectStatusOptions({ status: "active" }, true, "open WPs"))).toEqual(["done"]);
  });
});
