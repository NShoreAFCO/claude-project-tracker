// Inbox triage UI: tabs, selection, bulk dismiss, rule dialog, viewer view (fake DOM, real dom.js helpers).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch, installFakeDom, type FDoc, type FEl } from "./fake-dom";

const mocks = vi.hoisted(() => ({
  inbox: vi.fn(),
  inboxCount: vi.fn(),
  inboxRules: vi.fn(),
  dismissInbox: vi.fn(),
  restoreInbox: vi.fn(),
  createInboxRule: vi.fn(),
  deleteInboxRule: vi.fn(),
  assignInbox: vi.fn(),
  can: vi.fn(),
  changed: vi.fn(),
  openModal: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../public/js/api.js", () => ({
  api: {
    inbox: mocks.inbox,
    inboxCount: mocks.inboxCount,
    inboxRules: mocks.inboxRules,
    dismissInbox: mocks.dismissInbox,
    restoreInbox: mocks.restoreInbox,
    createInboxRule: mocks.createInboxRule,
    deleteInboxRule: mocks.deleteInboxRule,
    assignInbox: mocks.assignInbox,
  },
}));
vi.mock("../public/js/access.js", () => ({ can: mocks.can }));
vi.mock("../public/js/forms.js", () => ({ changed: mocks.changed }));
vi.mock("../public/js/i18n.js", () => ({
  t: (k: string, v?: unknown) => k + (v ? JSON.stringify(v) : ""),
  fmtDateTime: (d: string) => d,
  fmtPct: (n: number) => String(n),
}));
vi.mock("../public/js/dom.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  openModal: mocks.openModal,
  toast: mocks.toast,
  toastError: vi.fn(),
  confirmDialog: vi.fn(async () => true),
}));

const hookEvent = (id: number, cwd: string) => ({
  id,
  ts: "2026-01-01T00:00:00Z",
  actor: "hook:claude-code",
  entity: "hook",
  action: "unmatched",
  summary: `session in ${cwd}`,
  diff_json: JSON.stringify({ hook: [null, { cwd, reason: "other" }] }),
});
const webhookEvent = (id: number) => ({
  id,
  ts: "2026-01-01T00:00:00Z",
  actor: "github",
  entity: "github",
  action: "unmatched",
  summary: "push",
  diff_json: JSON.stringify({ github: [null, { repo: "x/y" }] }),
});

const events = [hookEvent(3, "C:/work/demo/app"), hookEvent(2, "C:/work/demo/lib"), webhookEvent(1)];
const state = { projects: [{ id: "p1", title: "Alpha" }] };

let doc: FDoc;
let main: FEl;
const rowBoxes = () => main.querySelectorAll("input[type=checkbox]").filter((i) => (i.getAttribute("aria-label") || "").startsWith("inboxSelectRow"));
const flush = () => new Promise((r) => setTimeout(r, 0));
const buttons = (root: FEl, label: string) => root.querySelectorAll("button").filter((b) => b.textContent === label);

async function render(hash = "") {
  (globalThis as any).location = { hash };
  // @ts-expect-error plain browser module without types
  const { renderInbox } = await import("../public/js/inbox.js");
  await renderInbox(main, state);
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  doc = installFakeDom();
  main = doc.createElement("main");
  doc.body.append(main);
  mocks.can.mockReturnValue(true);
  mocks.inbox.mockResolvedValue(events);
  mocks.inboxCount.mockResolvedValue({ open: 83 });
  mocks.inboxRules.mockResolvedValue([]);
  mocks.dismissInbox.mockResolvedValue({ dismissed: 3 });
  vi.stubGlobal("window", { dispatchEvent: () => {} });
  // openModal gives plain fake elements the test can inspect
  mocks.openModal.mockImplementation(() => ({
    body: doc.createElement("div"),
    foot: doc.createElement("div"),
    close: vi.fn(),
  }));
});

describe("inbox tabs", () => {
  it("renders To review with the uncapped count and a Dismissed tab", async () => {
    await render();
    const tabs = main.querySelectorAll("button").filter((b) => b.getAttribute("role") === "tab");
    expect(tabs.map((b) => b.textContent)).toEqual(['inboxTabOpen{"n":83}', "inboxTabDismissed"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(mocks.inbox).toHaveBeenCalledWith({ state: "open", limit: 500 });
  });

  it("takes the tab from the URL and offers Restore there", async () => {
    mocks.inbox.mockResolvedValue([{ ...hookEvent(5, "C:/a/b"), action: "ignored" }]);
    await render("#/inbox?state=dismissed");
    expect(mocks.inbox).toHaveBeenCalledWith({ state: "dismissed", limit: 500 });
    expect(buttons(main, "inboxRestore")).toHaveLength(1);
    expect(main.textContent).toContain("inboxIgnoredByRule");
    expect(buttons(main, "inboxRuleBtn")).toHaveLength(0);
  });
});

describe("selection and bulk dismiss", () => {
  it("select-all checks every row and the bar count follows", async () => {
    await render();
    const all = main.querySelector("input[aria-label=inboxSelectAll]")!;
    expect(all).toBeTruthy();
    all.checked = true;
    dispatch(doc, all, "change");
    const rows = rowBoxes();
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.checked)).toBe(true);
    expect(main.textContent).toContain('inboxSelectedCount{"n":3}');
    expect(buttons(main, 'inboxDismissSelected{"n":3}')).toHaveLength(1);

    rows[0].checked = false;
    dispatch(doc, rows[0], "change");
    expect(main.textContent).toContain('inboxSelectedCount{"n":2}');
    expect((all as any).indeterminate).toBe(true);
    expect(all.checked).toBe(false);
  });

  it("keeps an always-rendered status region outside the hidden bar and names each row checkbox", async () => {
    await render();
    const bar = main.querySelector(".inbox-bar")!;
    expect(bar.getAttribute("role")).toBeNull();
    expect(bar.getAttribute("aria-live")).toBeNull();
    const status = main.querySelector("[role=status]")!;
    expect(status).toBeTruthy();
    expect(status.textContent).toBe("");
    const rows = rowBoxes();
    rows[0].checked = true;
    dispatch(doc, rows[0], "change");
    expect(main.querySelector("[role=status]")!.textContent).toBe('inboxSelectedCount{"n":1}');
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
      'inboxSelectRow{"what":"session in C:/work/demo/app"}',
      'inboxSelectRow{"what":"session in C:/work/demo/lib"}',
      'inboxSelectRow{"what":"push"}',
    ]);
  });

  it("bulk dismiss sends the checked ids and reloads", async () => {
    await render();
    const rows = rowBoxes();
    for (const r of [rows[0], rows[2]]) {
      r.checked = true;
      dispatch(doc, r, "change");
    }
    const btn = buttons(main, 'inboxDismissSelected{"n":2}')[0];
    dispatch(doc, btn, "click");
    await flush();
    expect(mocks.dismissInbox).toHaveBeenCalledWith([3, 1]);
    expect(mocks.changed).toHaveBeenCalled();
  });
});

describe("rule dialog", () => {
  it("offers the cwd and its parents, deepest first, and counts events in the folder", async () => {
    await render();
    const [ruleBtn] = buttons(main, "inboxRuleBtn");
    dispatch(doc, ruleBtn, "click");
    const { body } = mocks.openModal.mock.results[0].value;
    const select = body.querySelector("select[name=folder]")!;
    expect(select.querySelectorAll("option").map((o: FEl) => o.getAttribute("value"))).toEqual(["C:/work/demo/app", "C:/work/demo", "C:/work"]);
    expect(body.textContent).toContain('inboxRuleApply{"n":1}');
    select.value = "C:/work/demo";
    dispatch(doc, select, "change");
    expect(body.textContent).toContain('inboxRuleApply{"n":2}');
  });

  it("toasts the more-variant when the server stopped at its cap", async () => {
    mocks.createInboxRule.mockResolvedValue({ applied: 200, more: true });
    await render();
    dispatch(doc, buttons(main, "inboxRuleBtn")[0], "click");
    const { foot } = mocks.openModal.mock.results[0].value;
    dispatch(doc, buttons(foot, "save")[0], "click");
    await flush();
    expect(mocks.toast).toHaveBeenCalledWith('inboxRuleSavedMore{"n":200}');
  });

  it("toasts the plain message without more", async () => {
    mocks.createInboxRule.mockResolvedValue({ applied: 2 });
    await render();
    dispatch(doc, buttons(main, "inboxRuleBtn")[0], "click");
    const { foot } = mocks.openModal.mock.results[0].value;
    dispatch(doc, buttons(foot, "save")[0], "click");
    await flush();
    expect(mocks.toast).toHaveBeenCalledWith('inboxRuleSaved{"n":2}');
  });

  it("webhook rows have no Rule button", async () => {
    await render();
    expect(buttons(main, "inboxRuleBtn")).toHaveLength(2);
  });

  it("marks the apply count as a minimum when the list was capped", async () => {
    mocks.inbox.mockResolvedValue(Array.from({ length: 500 }, (_, i) => hookEvent(i + 1, "C:/work/demo/app")));
    await render();
    dispatch(doc, buttons(main, "inboxRuleBtn")[0], "click");
    const { body } = mocks.openModal.mock.results[0].value;
    expect(body.textContent).toContain('inboxRuleApplyAtLeast{"n":500}');
  });
});

describe("rules fetch failure", () => {
  it("keeps the list and shows an error line in the rules section", async () => {
    mocks.inboxRules.mockRejectedValue(new Error("500"));
    await render();
    expect(rowBoxes()).toHaveLength(3);
    expect(main.textContent).toContain("inboxRulesTitle");
    expect(main.textContent).toContain("inboxRulesError");
  });
});

describe("viewer", () => {
  it("sees the lists only", async () => {
    mocks.can.mockReturnValue(false);
    await render();
    expect(main.querySelectorAll("input")).toHaveLength(0);
    expect(main.querySelectorAll("button").filter((b) => b.getAttribute("role") !== "tab")).toHaveLength(0);
    expect(main.textContent).not.toContain("inboxRulesTitle");
    expect(mocks.inboxRules).not.toHaveBeenCalled();
  });
});
