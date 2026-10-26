import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gateOverride: vi.fn(),
  workpackages: vi.fn(),
  formDialog: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../public/js/api.js", () => ({
  api: {
    gateOverride: mocks.gateOverride,
    workpackages: mocks.workpackages,
  },
}));

vi.mock("../public/js/dom.js", () => ({
  h: (...a: unknown[]) => ({ args: a }),
  formDialog: mocks.formDialog,
  toast: mocks.toast,
}));

function gateErr(endpoint?: string) {
  return {
    status: 409,
    code: "GATE_LOCKED",
    body: {
      current: {
        code: "GATE_LOCKED",
        gates: [{ milestone_id: "m1", title: "Go/No-go" }],
        ...(endpoint ? { override_endpoint: endpoint } : {}),
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  const g = globalThis as Record<string, unknown>;
  g.window = { dispatchEvent: vi.fn() };
  g.CustomEvent = class {
    type: string;
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail ?? null;
    }
  };
});

describe("guardedWrite", () => {
  it("overrides a gate lock, refreshes the version, and retries the write", async () => {
    mocks.formDialog.mockImplementation(async (opts) => opts.onSubmit({ reason: "Customer call moved" }));
    mocks.gateOverride.mockResolvedValue(undefined);
    mocks.workpackages.mockResolvedValue([{ id: "w1", version: 5 }]);

    const wp = { id: "w1", title: "Build", version: 4 };
    const error = gateErr("POST /api/workpackages/w1/gate-override");
    const run = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce({ ok: true });

    // @ts-expect-error untyped JS module
    const { guardedWrite } = await import("../public/js/gates-ui.js");

    const result = await guardedWrite(wp, run, "p1");

    expect(result).toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(2);
    expect(mocks.gateOverride).toHaveBeenCalledTimes(1);
    expect(mocks.gateOverride).toHaveBeenCalledWith("w1", "Customer call moved");
    expect(wp.version).toBe(5);
  });

  it("returns cancelled without retrying when the override dialog is cancelled", async () => {
    mocks.formDialog.mockResolvedValue(null);

    const wp = { id: "w1", title: "Build", version: 4 };
    const error = gateErr("POST /api/workpackages/w1/gate-override");
    const run = vi.fn().mockRejectedValueOnce(error);

    // @ts-expect-error untyped JS module
    const { guardedWrite } = await import("../public/js/gates-ui.js");

    await expect(guardedWrite(wp, run, "p1")).resolves.toEqual({
      cancelled: true,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(mocks.gateOverride).not.toHaveBeenCalled();
  });

  it("rethrows a gate lock without an override endpoint", async () => {
    const wp = { id: "w1", title: "Build", version: 4 };
    const error = gateErr();
    const run = vi.fn().mockRejectedValueOnce(error);

    // @ts-expect-error untyped JS module
    const { guardedWrite } = await import("../public/js/gates-ui.js");

    await expect(guardedWrite(wp, run, "p1")).rejects.toBe(error);
    expect(mocks.formDialog).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("overrides a locked parent and refreshes the child version", async () => {
    mocks.formDialog.mockImplementation(async (opts) => opts.onSubmit({ reason: "Customer call moved" }));
    mocks.gateOverride.mockResolvedValue(undefined);
    mocks.workpackages.mockResolvedValue([{ id: "child", version: 2 }]);

    const wp = { id: "child", title: "Child", version: 1 };
    const error = gateErr("POST /api/workpackages/parent/gate-override");
    const retryResult = { saved: true };
    const run = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(retryResult);

    // @ts-expect-error untyped JS module
    const { guardedWrite } = await import("../public/js/gates-ui.js");

    const result = await guardedWrite(wp, run, "p1");

    expect(result).toBe(retryResult);
    expect(run).toHaveBeenCalledTimes(2);
    expect(mocks.formDialog).toHaveBeenCalledTimes(1);
    expect(mocks.gateOverride).toHaveBeenCalledWith("parent", "Customer call moved");
    expect(wp.version).toBe(2);
  });

  it("retries once after a SCHEDULE_CONFLICT", async () => {
    const conflict = { code: "SCHEDULE_CONFLICT", status: 409 };
    const wp = { id: "w1", title: "Build", version: 4 };
    const run = vi.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce("ok");

    // @ts-expect-error untyped JS module
    const { guardedWrite } = await import("../public/js/gates-ui.js");

    await expect(guardedWrite(wp, run, "p1")).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(mocks.formDialog).not.toHaveBeenCalled();
  });

  it("rejects when the SCHEDULE_CONFLICT retry also fails", async () => {
    const firstConflict = { code: "SCHEDULE_CONFLICT", status: 409 };
    const secondConflict = { code: "SCHEDULE_CONFLICT", status: 409 };
    const wp = { id: "w1", title: "Build", version: 4 };
    const run = vi.fn().mockRejectedValueOnce(firstConflict).mockRejectedValueOnce(secondConflict);

    // @ts-expect-error untyped JS module
    const { guardedWrite } = await import("../public/js/gates-ui.js");

    await expect(guardedWrite(wp, run, "p1")).rejects.toBe(secondConflict);
    expect(run).toHaveBeenCalledTimes(2);
    expect(mocks.formDialog).not.toHaveBeenCalled();
  });

  it("rethrows a non-gate error without retrying", async () => {
    const error = { status: 500 };
    const wp = { id: "w1", title: "Build", version: 4 };
    const run = vi.fn().mockRejectedValueOnce(error);

    // @ts-expect-error untyped JS module
    const { guardedWrite } = await import("../public/js/gates-ui.js");

    await expect(guardedWrite(wp, run, "p1")).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
