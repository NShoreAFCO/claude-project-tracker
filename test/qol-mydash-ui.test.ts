import { beforeEach, describe, expect, it, vi } from "vitest";

type Node = {
  sel: string;
  attrs: Record<string, any>;
  children: any[];
};

const mocks = vi.hoisted(() => ({
  getDashboardPrefs: vi.fn(),
  putDashboardPrefs: vi.fn(),
  myWps: vi.fn(),
  openWps: vi.fn(),
  openGates: vi.fn(),
  projects: vi.fn(),
  prompt: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("../public/js/api.js", () => ({
  api: {
    getDashboardPrefs: mocks.getDashboardPrefs,
    putDashboardPrefs: mocks.putDashboardPrefs,
    myWps: mocks.myWps,
    openWps: mocks.openWps,
    openGates: mocks.openGates,
    projects: mocks.projects,
  },
}));

vi.mock("../public/js/i18n.js", () => ({
  t: (k: string, v?: unknown) => k + (v ? JSON.stringify(v) : ""),
  fmtDate: (d: string | null | undefined) => d ?? "-",
}));

vi.mock("../public/js/dom.js", () => {
  const flatten = (items: any[]): any[] =>
    items.flat(Infinity).filter((item) => item !== null && item !== undefined && item !== false);

  return {
    h(sel: string, attrs?: any, ...children: any[]) {
      if (
        attrs === null ||
        attrs === undefined ||
        typeof attrs !== "object" ||
        Array.isArray(attrs) ||
        Object.prototype.hasOwnProperty.call(attrs, "sel")
      ) {
        if (attrs !== null && attrs !== undefined) children.unshift(attrs);
        attrs = {};
      }
      return { sel, attrs, children: flatten(children) };
    },
    clear(el: { children: any[] }, ...children: any[]) {
      el.children = flatten(children);
      return el;
    },
  };
});

const projects = [
  { id: "p1", title: "Alpha", status: "active", target_date: "2027-01-01", owner_initials: "AA" },
  { id: "p2", title: "Beta", status: "idea", target_date: null, owner_initials: null },
];

const emptyPrefs = {
  prefs: { version: 1, views: [], active_projects: [] },
  version: 1,
};

function classes(sel: string) {
  return sel.split(".").slice(1);
}

function tag(sel: string) {
  return sel.split(".")[0];
}

function matches(node: any, wantedTag?: string, wantedClass?: string) {
  if (!node || typeof node !== "object" || !node.sel) return false;
  return (!wantedTag || tag(node.sel) === wantedTag) && (!wantedClass || classes(node.sel).includes(wantedClass));
}

function find(root: any, predicate: (node: Node) => boolean): Node | undefined {
  if (root && typeof root === "object" && root.sel && predicate(root)) return root;
  for (const child of root?.children || []) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return undefined;
}

function findAll(root: any, predicate: (node: Node) => boolean): Node[] {
  const out: Node[] = [];
  const walk = (node: any) => {
    if (node && typeof node === "object" && node.sel) {
      if (predicate(node)) out.push(node);
      for (const child of node.children || []) walk(child);
    } else {
      for (const child of node?.children || []) walk(child);
    }
  };
  walk(root);
  return out;
}

function text(node: any): string {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  return (node.children || []).map(text).join("");
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function render(prefs = emptyPrefs) {
  mocks.getDashboardPrefs.mockResolvedValue(prefs);
  const main = { children: [] as any[] };
  // @ts-expect-error untyped JS module
  const { renderMyDashboard } = await import("../public/js/mydash.js");
  await renderMyDashboard(main, {});
  await flush();
  return main;
}

function button(root: any, label: string) {
  return find(root, (node) => tag(node.sel) === "button" && text(node) === label)!;
}

function returnedPrefs(next: any) {
  return { prefs: next, version: 1 };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projects.mockResolvedValue(projects);
  mocks.myWps.mockResolvedValue([]);
  mocks.openWps.mockResolvedValue([]);
  mocks.openGates.mockResolvedValue([]);
  mocks.putDashboardPrefs.mockImplementation(async (prefs) => returnedPrefs(prefs));
  vi.stubGlobal("window", {
    prompt: mocks.prompt,
    confirm: mocks.confirm,
  });
});

describe("My dashboard", () => {
  it("renders six kind buttons and calls each API with exact parameters", async () => {
    const main = await render();
    const kinds = findAll(main, (node) => tag(node.sel) === "button" && text(node).startsWith("mydKind."));
    expect(kinds).toHaveLength(6);
    expect(mocks.myWps).toHaveBeenCalledWith({ sort: "end", assigned_only: 1 });

    button(main, "mydKind.my_human_tasks").attrs.on.click();
    await flush();
    expect(mocks.myWps).toHaveBeenLastCalledWith({ sort: "end", human_only: 1 });

    button(main, "mydKind.my_decisions").attrs.on.click();
    await flush();
    expect(mocks.openGates).toHaveBeenLastCalledWith({ scope: "me" });

    button(main, "mydKind.all_decisions").attrs.on.click();
    await flush();
    expect(mocks.openGates).toHaveBeenLastCalledWith({ scope: "all" });

    button(main, "mydKind.all_human_tasks").attrs.on.click();
    await flush();
    expect(mocks.openWps).toHaveBeenLastCalledWith({ human_only: 1, limit: 200 });

    button(main, "mydKind.active_projects").attrs.on.click();
    await flush();
    expect(mocks.projects).toHaveBeenCalledTimes(1);

    button(main, "mydKind.my_tasks").attrs.on.click();
    await flush();
    const select = find(main, (node) => matches(node, "select", "mydash-project"))!;
    select.attrs.on.change({ target: { value: "p2" } });
    await flush();
    expect(mocks.myWps).toHaveBeenLastCalledWith({
      sort: "end",
      assigned_only: 1,
      project_id: "p2",
    });

    button(main, "mydKind.all_decisions").attrs.on.click();
    await flush();
    expect(mocks.openGates).toHaveBeenLastCalledWith({ scope: "all", project_id: "p2" });
  });

  it("selecting a project reloads with project_id", async () => {
    const main = await render();
    const select = find(main, (node) => matches(node, "select", "mydash-project"))!;
    select.attrs.on.change({ target: { value: "p1" } });
    await flush();

    expect(mocks.myWps).toHaveBeenLastCalledWith({
      sort: "end",
      assigned_only: 1,
      project_id: "p1",
    });
  });

  it("renders row links with the project id and code plus title", async () => {
    mocks.myWps.mockResolvedValue([
      {
        id: "w1",
        project_id: "project / one",
        project_title: "Alpha",
        code: "WP-1",
        title: "Build",
        status: "doing",
        end_date: "2026-12-01",
        effective_owner: { name: "Ada", initials: "AL" },
      },
    ]);

    const main = await render();
    const row = find(main, (node) => matches(node, "tr", "mydash-row"))!;
    const link = find(row, (node) => tag(node.sel) === "a")!;

    expect(link.attrs.href).toBe("#/p/project%20%2F%20one");
    expect(text(link)).toBe("WP-1 Build");
  });

  it("shows the empty state and replaces everything with an error on rejected load", async () => {
    const emptyMain = await render();
    expect(text(find(emptyMain, (node) => matches(node, "p", "empty")))).toBe("mydEmpty");

    mocks.myWps.mockRejectedValueOnce(new Error("offline"));
    const errorMain = await render();
    expect(errorMain.children).toHaveLength(1);
    const error = find(errorMain, (node) => matches(node, "p", "mydash-error"))!;
    expect(text(error)).toBe('mydLoadFailed{"error":"offline"}');
  });

  it("saves a named view with its current kind and project", async () => {
    mocks.prompt.mockReturnValue("My Alpha work");
    const main = await render();

    const select = find(main, (node) => matches(node, "select", "mydash-project"))!;
    select.attrs.on.change({ target: { value: "p1" } });
    await flush();

    find(main, (node) => matches(node, "button", "mydash-save"))!.attrs.on.click();
    await flush();

    expect(mocks.putDashboardPrefs).toHaveBeenCalledTimes(1);
    const sent = mocks.putDashboardPrefs.mock.calls[0][0];
    expect(sent.version).toBe(1);
    expect(sent.active_projects).toEqual([]);
    expect(sent.views).toHaveLength(1);
    expect(sent.views[0]).toMatchObject({
      name: "My Alpha work",
      kind: "my_tasks",
      project_id: "p1",
    });
    expect(sent.views[0].id).toMatch(/^v/);
  });

  it("caps a saved view name at the 80 characters the server accepts", async () => {
    mocks.prompt.mockReturnValue(`  ${"n".repeat(100)}  `);
    const main = await render();
    find(main, (node) => matches(node, "button", "mydash-save"))!.attrs.on.click();
    await flush();
    expect(mocks.putDashboardPrefs.mock.calls.at(-1)![0].views.at(-1).name).toBe("n".repeat(80));
  });

  it("renames, deletes, reorders, and makes views default", async () => {
    const views = [
      { id: "a", name: "A", kind: "my_tasks", project_id: null },
      { id: "b", name: "B", kind: "my_decisions", project_id: "p1" },
      { id: "c", name: "C", kind: "all_decisions", project_id: null },
    ];
    const main = await render(returnedPrefs({ version: 1, views, active_projects: [] }));

    mocks.prompt.mockReturnValueOnce("Bee");
    findAll(main, (node) => matches(node, "button", "mydash-rename"))[1].attrs.on.click();
    await flush();
    expect(mocks.putDashboardPrefs.mock.calls[0][0].views.map((v: any) => v.name)).toEqual(["A", "Bee", "C"]);

    let current = findAll(main, (node) => matches(node, "button", "mydash-down"));
    current[0].attrs.on.click();
    await flush();
    expect(mocks.putDashboardPrefs.mock.calls[1][0].views.map((v: any) => v.id)).toEqual(["b", "a", "c"]);

    current = findAll(main, (node) => matches(node, "button", "mydash-up"));
    current[2].attrs.on.click();
    await flush();
    expect(mocks.putDashboardPrefs.mock.calls[2][0].views.map((v: any) => v.id)).toEqual(["b", "c", "a"]);

    findAll(main, (node) => matches(node, "button", "mydash-default"))[0].attrs.on.click();
    await flush();
    expect(mocks.putDashboardPrefs.mock.calls[3][0].views.map((v: any) => v.id)).toEqual(["c", "b", "a"]);

    mocks.confirm.mockReturnValueOnce(false);
    findAll(main, (node) => matches(node, "button", "mydash-delete"))[1].attrs.on.click();
    await flush();
    expect(mocks.putDashboardPrefs).toHaveBeenCalledTimes(4);

    mocks.confirm.mockReturnValueOnce(true);
    findAll(main, (node) => matches(node, "button", "mydash-delete"))[1].attrs.on.click();
    await flush();
    expect(mocks.putDashboardPrefs.mock.calls[4][0].views.map((v: any) => v.id)).toEqual(["c", "a"]);
  });

  it("applies the first saved view during initial loading", async () => {
    await render(
      returnedPrefs({
        version: 1,
        views: [{ id: "v1", name: "All gates", kind: "all_decisions", project_id: null }],
        active_projects: [],
      }),
    );

    expect(mocks.openGates).toHaveBeenCalledTimes(1);
    expect(mocks.openGates).toHaveBeenCalledWith({ scope: "all" });
    expect(mocks.myWps).not.toHaveBeenCalled();
  });

  it("persists active project toggles and filters project rows", async () => {
    const main = await render(
      returnedPrefs({
        version: 1,
        views: [{ id: "v1", name: "Active", kind: "active_projects", project_id: null }],
        active_projects: ["p1"],
      }),
    );

    let rows = findAll(main, (node) => matches(node, "tr", "mydash-row"));
    expect(rows).toHaveLength(1);
    expect(text(rows[0])).toContain("Alpha");
    expect(text(rows[0])).not.toContain("Beta");
    // Due column shows the project's planned completion date (target_date).
    expect(text(rows[0])).toContain("2027-01-01");

    const picks = findAll(main, (node) => matches(node, "input", "mydash-pick"));
    const beta = picks.find((pick) => pick.attrs.value === "p2")!;
    beta.attrs.on.change({ target: { checked: true } });
    await flush();

    expect(mocks.putDashboardPrefs).toHaveBeenLastCalledWith({
      version: 1,
      views: [{ id: "v1", name: "Active", kind: "active_projects", project_id: null }],
      active_projects: ["p1", "p2"],
    });

    rows = findAll(main, (node) => matches(node, "tr", "mydash-row"));
    expect(rows).toHaveLength(2);
  });

  it("reloads project rows after a view mutation and after a failed toggle", async () => {
    const views = [{ id: "v1", name: "Active", kind: "active_projects", project_id: null }];
    const main = await render(returnedPrefs({ version: 1, views, active_projects: ["p1"] }));
    mocks.prompt.mockReturnValueOnce("Renamed");
    find(main, (node) => matches(node, "button", "mydash-rename"))!.attrs.on.click();
    await flush();
    expect(findAll(main, (node) => matches(node, "tr", "mydash-row"))).toHaveLength(1);

    mocks.putDashboardPrefs.mockRejectedValueOnce(new Error("down"));
    const beta = findAll(main, (node) => matches(node, "input", "mydash-pick")).find((pick) => pick.attrs.value === "p2")!;
    beta.attrs.on.change({ target: { checked: true } });
    await flush();
    const picks = findAll(main, (node) => matches(node, "input", "mydash-pick"));
    expect(picks.find((pick) => pick.attrs.value === "p2")!.attrs.checked).toBe(false);
    expect(findAll(main, (node) => matches(node, "tr", "mydash-row"))).toHaveLength(1);
    expect(find(main, (node) => matches(node, "p", "mydash-error"))).toBeTruthy();
  });

  it("shows a save error and keeps the previous views when persistence fails", async () => {
    const original = [{ id: "a", name: "A", kind: "my_tasks", project_id: null }];
    const main = await render(returnedPrefs({ version: 1, views: original, active_projects: [] }));
    mocks.putDashboardPrefs.mockRejectedValueOnce(new Error("save down"));
    mocks.prompt.mockReturnValueOnce("Changed");

    find(main, (node) => matches(node, "button", "mydash-rename"))!.attrs.on.click();
    await flush();

    const error = find(main, (node) => matches(node, "p", "mydash-error"))!;
    expect(text(error)).toBe('mydSaveFailed{"error":"save down"}');
    expect(text(find(main, (node) => matches(node, "button", "mydash-open")))).toBe("A");
  });

  it("serialises overlapping preference writes so no change is lost or restored stale", async () => {
    const views = [
      { id: "a", name: "A", kind: "my_tasks", project_id: null },
      { id: "b", name: "B", kind: "my_tasks", project_id: null },
    ];
    const main = await render(returnedPrefs({ version: 1, views, active_projects: [] }));
    const resolvers: Array<(v: any) => void> = [];
    mocks.putDashboardPrefs.mockImplementation(
      (prefs) => new Promise((resolve) => resolvers.push(() => resolve(returnedPrefs(prefs)))),
    );

    mocks.prompt.mockReturnValueOnce("A2");
    const first = button(main, "mydRename").attrs.on.click();
    const second = find(main, (node) => matches(node, "button", "mydash-down"))!.attrs.on.click();
    await flush();

    // only one PUT in flight until the first is acknowledged
    expect(mocks.putDashboardPrefs).toHaveBeenCalledTimes(1);
    resolvers[0](null);
    await first;
    await flush();
    expect(mocks.putDashboardPrefs).toHaveBeenCalledTimes(2);
    resolvers[1](null);
    await second;
    await flush();

    const last = mocks.putDashboardPrefs.mock.calls[1][0];
    expect(last.views.map((v: any) => v.name)).toEqual(["B", "A2"]);
    const names = findAll(main, (node) => matches(node, "button", "mydash-open")).map(text);
    expect(names).toEqual(["B", "A2"]);
  });

  it("rolls a failed queued write back to the last acknowledged prefs without dropping later ones", async () => {
    const views = [
      { id: "a", name: "A", kind: "my_tasks", project_id: null },
      { id: "b", name: "B", kind: "my_tasks", project_id: null },
    ];
    const main = await render(returnedPrefs({ version: 1, views, active_projects: [] }));
    const settle: Array<(fail: boolean, prefs?: any) => void> = [];
    mocks.putDashboardPrefs.mockImplementation(
      (prefs) =>
        new Promise((resolve, reject) =>
          settle.push((fail) => (fail ? reject(new Error("boom")) : resolve(returnedPrefs(prefs)))),
        ),
    );
    mocks.prompt.mockReturnValueOnce("Bad");
    const first = button(main, "mydRename").attrs.on.click();
    const second = find(main, (node) => matches(node, "button", "mydash-down"))!.attrs.on.click();
    await flush();
    settle[0](true);
    await first;
    await flush();
    settle[1](false);
    await second;
    await flush();

    const sent = mocks.putDashboardPrefs.mock.calls[1][0];
    expect(sent.views.map((v: any) => v.name)).toEqual(["B", "A"]);
  });
});
