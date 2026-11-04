// Gate dialog info rendered with the real dom.js helpers (fake DOM), not mocks: lists, warning, submit, progress semantics.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeDom, type FEl } from "./fake-dom";

const mocks = vi.hoisted(() => ({ formDialog: vi.fn() }));

vi.mock("../public/js/api.js", () => ({ api: {} }));
vi.mock("../public/js/dom.js", async (orig) => ({ ...(await orig<Record<string, unknown>>()), formDialog: mocks.formDialog }));

// @ts-expect-error untyped JS module
const { gateLinksBlock, decisionDialog } = await import("../public/js/gates-ui.js");
// @ts-expect-error untyped JS module
const { setLocale } = await import("../public/js/i18n.js");
setLocale("en"); // expectations below are English; instances may default to another locale

const wp = (id: string, status: string, progress: number) => ({ id, code: id.toUpperCase(), title: `T-${id}`, status, progress });
const ms = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  title: "Go/No-go",
  reached: false,
  requires_status: [wp("a", "doing", 40), wp("b", "dropped", 0), wp("c", "done", 100)],
  unlocks_status: [wp("d", "todo", 0), wp("e", "dropped", 0)],
  ...over,
});

beforeEach(() => {
  installFakeDom();
  vi.clearAllMocks();
});

describe("gateLinksBlock (real helpers)", () => {
  it("lists required and opened work packages as separate lists", () => {
    const block = gateLinksBlock(ms()) as FEl;
    const lists = block.querySelectorAll("ul.gate-wps");
    expect(lists).toHaveLength(2);
    expect(lists[0].children.map((li) => li.querySelector(".gate-wp-name")!.textContent)).toEqual(["A T-a", "B T-b", "C T-c"]);
    expect(lists[1].children.map((li) => li.querySelector(".gate-wp-name")!.textContent)).toEqual(["D T-d", "E T-e"]);
  });

  it("progress bars expose aria-valuenow and the percent text; done counts as 100, dropped has none", () => {
    const [req] = (gateLinksBlock(ms()) as FEl).querySelectorAll("ul.gate-wps");
    const bars = req.querySelectorAll("[role=progressbar]");
    expect(bars.map((b) => b.getAttribute("aria-valuenow"))).toEqual(["40", "100"]);
    expect(bars[0].getAttribute("aria-label")).toBe("Progress of A T-a");
    const pct = req.children[0].querySelector(".pct")!.textContent;
    expect(pct).toBe("40 %");
    expect(req.children[1].querySelector("[role=progressbar]")).toBeNull();
  });

  it("marks dropped required and opened entries with the dropped class", () => {
    const [req, opens] = (gateLinksBlock(ms()) as FEl).querySelectorAll("ul.gate-wps");
    expect(req.children.map((li) => li.classes.has("dropped"))).toEqual([false, true, false]);
    expect(opens.children.map((li) => li.classes.has("dropped"))).toEqual([false, true]);
    expect(opens.children[1].querySelector(".st-dropped")).not.toBeNull();
  });

  it("warns (role=note) while the gate is not reached, naming the open work packages", () => {
    const warn = (gateLinksBlock(ms()) as FEl).querySelector(".callout.gate-warn")!;
    expect(warn.getAttribute("role")).toBe("note");
    expect(warn.textContent).toContain("A T-a");
    expect(warn.textContent).not.toContain("C T-c");
  });

  it("no warning when reached and everything required is closed", () => {
    const block = gateLinksBlock(ms({ reached: true, requires_status: [wp("c", "done", 100)] })) as FEl;
    expect(block.querySelector(".gate-warn")).toBeNull();
  });

  it("returns null for a gate without links that is reached", () => {
    expect(gateLinksBlock({ id: "m", reached: true })).toBeNull();
  });
});

describe("decisionDialog (real helpers)", () => {
  it("passes a rendered intro with the lists and warning, and leaves submit enabled", async () => {
    mocks.formDialog.mockResolvedValue(null);
    await decisionDialog({ project: { id: "p1" }, milestone: ms() });
    const opts = mocks.formDialog.mock.calls[0][0];
    const intro = opts.intro as FEl;
    expect(intro.querySelectorAll("ul.gate-wps")).toHaveLength(2);
    expect(intro.querySelector(".gate-warn")).not.toBeNull();
    expect(intro.querySelectorAll("[role=progressbar]").length).toBeGreaterThan(0);
    expect(opts.fields.some((f: { disabled?: boolean }) => f.disabled)).toBe(false);
    expect(opts.submitLabel).toBeTruthy();
    expect(opts.disabled).toBeFalsy();
  });
});
