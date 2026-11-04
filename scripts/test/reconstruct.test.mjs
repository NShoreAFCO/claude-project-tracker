import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseArgs,
  startEvidence,
  gateOpenings,
  proposeWp,
  clamp,
  mergeGit,
  changesFor,
  buildProposals,
  formatTable,
  branchDates,
  gitEvidence,
  fetchEvents,
  makeClient,
  run,
} from "../reconstruct-timeline.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "reconstruct-timeline.mjs");
const project = { start_date: "2026-01-05", created_at: "2026-01-02T10:00:00Z" };
const wp = (o = {}) => ({ id: "w1", title: "Task", status: "doing", actual_start: null, actual_end: null, version: 3, children: [], ...o });
const ev = (o) => ({ entity: "workpackage", entity_id: "w1", action: "progress", ts: "2026-02-10T09:00:00Z", diff_json: null, ...o });
const ctx = (o = {}) => ({ project, parentStart: null, opening: null, events: [], git: null, ...o });

test("parseArgs: flags, required project, unknown argument", () => {
  assert.deepEqual(parseArgs(["--project", "p1", "--apply", "--git", "/r"]), { project: "p1", git: "/r", apply: true, help: false });
  assert.match(parseArgs(["--apply"]).error, /--project/);
  assert.match(parseArgs(["--project"]).error, /needs a value/);
  assert.match(parseArgs(["--x"]).error, /unknown/);
  assert.equal(parseArgs(["--help"]).help, true);
});

test("startEvidence: notes are ignored, todo WPs have no evidence", () => {
  const events = [ev({ action: "note", ts: "2026-01-20T00:00:00Z" }), ev({ ts: "2026-02-10T09:00:00Z" })];
  assert.deepEqual(
    startEvidence(wp(), events).map((e) => e.date),
    ["2026-02-10"],
  );
  assert.deepEqual(startEvidence(wp({ status: "todo" }), events), []);
});

test("startEvidence: status change to doing and progress above 0 count", () => {
  const events = [
    ev({ action: "update", ts: "2026-03-01T00:00:00Z", diff_json: JSON.stringify({ status: ["todo", "doing"] }) }),
    ev({ action: "update", ts: "2026-03-02T00:00:00Z", diff_json: JSON.stringify({ progress: [0, 0] }) }),
    ev({ action: "update", ts: "2026-03-03T00:00:00Z", diff_json: "not json" }),
  ];
  assert.deepEqual(
    startEvidence(wp(), events).map((e) => e.date),
    ["2026-03-01"],
  );
});

test("proposeWp: earliest progress event wins over every fallback", () => {
  const p = proposeWp(
    wp(),
    ctx({
      events: [ev({ ts: "2026-02-12T00:00:00Z" }), ev({ ts: "2026-02-10T00:00:00Z" })],
      opening: "2026-02-01",
      parentStart: "2026-01-15",
    }),
  );
  assert.deepEqual(p.start, { value: "2026-02-10", source: "progress event" });
});

test("proposeWp: fallback order gate, parent, project start, project created", () => {
  assert.deepEqual(proposeWp(wp(), ctx({ opening: "2026-02-01", parentStart: "2026-01-15" })).start, {
    value: "2026-02-01",
    source: "gate opening",
  });
  assert.deepEqual(proposeWp(wp(), ctx({ parentStart: "2026-01-15" })).start, { value: "2026-01-15", source: "parent start" });
  assert.deepEqual(proposeWp(wp(), ctx()).start, { value: "2026-01-05", source: "project start" });
  assert.deepEqual(proposeWp(wp(), ctx({ project: { created_at: "2026-01-02T10:00:00Z" } })).start, {
    value: "2026-01-02",
    source: "project created",
  });
  assert.equal(proposeWp(wp(), ctx({ project: {} })).start.value, null);
});

test("proposeWp: an override log before the gate opening wins", () => {
  const p = proposeWp(wp(), ctx({ opening: "2026-03-01", events: [ev({ ts: "2026-02-20T00:00:00Z" })] }));
  assert.equal(p.start.value, "2026-02-20");
});

test("proposeWp: existing dates are kept", () => {
  const p = proposeWp(wp({ status: "done", actual_start: "2026-01-10", actual_end: "2026-01-20" }), ctx({ opening: "2026-02-01" }));
  assert.deepEqual(p, { start: { value: "2026-01-10", source: "current" }, end: { value: "2026-01-20", source: "current" } });
  assert.deepEqual(changesFor(wp({ actual_start: "2026-01-10" }), p), { actual_end: "2026-01-20" });
});

test("proposeWp: end only for done WPs; done event, then git, then last progress", () => {
  assert.equal(proposeWp(wp(), ctx({ events: [ev()] })).end.value, null);
  const done = wp({ status: "done" });
  const doneEv = ev({ action: "update", ts: "2026-04-01T00:00:00Z", diff_json: JSON.stringify({ status: ["doing", "done"] }) });
  assert.deepEqual(proposeWp(done, ctx({ events: [ev(), doneEv] })).end, { value: "2026-04-01", source: "done event" });
  assert.deepEqual(proposeWp(done, ctx({ events: [ev()], git: { first: "2026-02-01", last: "2026-03-30" } })).end, {
    value: "2026-03-30",
    source: "git last commit",
  });
  assert.deepEqual(proposeWp(done, ctx({ events: [ev()] })).end, { value: "2026-02-10", source: "progress event" });
});

test("clamp: start is never later than end", () => {
  const p = clamp({ start: { value: "2026-05-01", source: "project start" }, end: { value: "2026-04-01", source: "done event" } });
  assert.equal(p.start.value, "2026-04-01");
  assert.match(p.start.source, /clamped/);
  const ok = { start: { value: "2026-03-01", source: "x" }, end: { value: "2026-04-01", source: "y" } };
  assert.deepEqual(clamp(ok), ok);
});

test("mergeGit: first commit replaces fallbacks and later events, not earlier events", () => {
  const w = wp();
  const fb = { start: { value: "2026-01-05", source: "project start" }, end: { value: null, source: "current" } };
  assert.deepEqual(mergeGit(fb, { first: "2026-02-02", last: "2026-03-01" }, w).start, { value: "2026-02-02", source: "git first commit" });
  const evp = { start: { value: "2026-02-10", source: "progress event" }, end: { value: null, source: "current" } };
  assert.equal(mergeGit(evp, { first: "2026-02-02" }, w).start.source, "git first commit");
  assert.equal(mergeGit(evp, { first: "2026-02-20" }, w).start.source, "progress event");
  assert.equal(mergeGit(fb, { first: "2026-02-02", last: "2026-03-01" }, w).end.value, null);
});

test("gateOpenings: reached and go decision, later of the two; hold does not open", () => {
  const ms = [
    {
      gate: 1,
      reached_at: "2026-02-01T00:00:00Z",
      decisions: [
        { decision: "hold", decided_at: "2026-02-02" },
        { decision: "go", decided_at: "2026-02-10T00:00:00Z" },
      ],
      unlocks: ["a"],
    },
    { gate: 1, reached_at: "2026-02-01", decisions: [{ decision: "stop", decided_at: "2026-02-02" }], unlocks: ["b"] },
    { gate: 0, reached_at: "2026-01-20", decisions: [], unlocks: ["c"] },
    { gate: 0, reached_at: null, decisions: [], unlocks: ["d"] },
    { gate: 1, reached_at: "2026-03-01", decisions: [], unlocks: ["e"] },
  ];
  const o = gateOpenings(ms);
  assert.equal(o.get("a"), "2026-02-10");
  assert.equal(o.has("e"), false);
  assert.equal(o.has("b"), false);
  assert.equal(o.get("c"), "2026-01-20");
  assert.equal(o.has("d"), false);
});

test("buildProposals: child follows the parent's proposed start; only changed fields listed", () => {
  const child = wp({ id: "c1", parent_id: "w1", title: "Child", status: "todo" });
  const parent = wp({ children: [child] });
  const rows = buildProposals({ project, workpackages: [parent], milestones: [], events: [ev({ ts: "2026-02-10T00:00:00Z" })] });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1].proposal.start, { value: "2026-02-10", source: "parent start" });
  assert.deepEqual(rows[0].changes, { actual_start: "2026-02-10" });
});

test("formatTable: header, separator, one line per WP, dash for empty", () => {
  const rows = buildProposals({ project, workpackages: [wp({ code: "T1" })], milestones: [], events: [] });
  const lines = formatTable(rows).split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^WP\s+current start\s+proposed start/);
  assert.match(lines[2], /^T1 Task\s+-\s+2026-01-05\s+project start\s+-\s+-\s+current/);
});

test("branchDates / gitEvidence: range with base, origin fallback, several branches merged", () => {
  const calls = [];
  const run = (repo, args) => {
    calls.push(args.join(" "));
    if (args[2] === "origin/f1") return "2026-02-05\n2026-02-01\n";
    if (args[2] === "main..f2") return "2026-03-01\n2026-02-20\n";
    return "";
  };
  assert.deepEqual(branchDates("/r", { name: "f1" }, run), { first: "2026-02-01", last: "2026-02-05" });
  assert.deepEqual(calls.slice(0, 2), ["log --format=%as f1", "log --format=%as origin/f1"]);
  assert.equal(branchDates("/r", { name: "none" }, run), null);
  const m = gitEvidence(
    [
      { workpackage_id: "w1", name: "f1" },
      { workpackage_id: "w1", name: "f2", base: "main" },
      { workpackage_id: null, name: "x" },
    ],
    "/r",
    run,
  );
  assert.deepEqual(m.get("w1"), { first: "2026-02-01", last: "2026-03-01" });
  assert.equal(m.size, 1);
});

function fakeApi(detail, events, { failPatch = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const u = new URL(url);
    const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (init.method === "PATCH") return failPatch ? reply(409, { error: "version conflict" }) : reply(200, {});
    if (u.pathname === "/api/events") return reply(200, events);
    return reply(200, detail);
  };
  return { calls, fetchImpl };
}

test("makeClient sends the service-token headers and reports HTTP errors", async () => {
  const { calls, fetchImpl } = fakeApi({}, []);
  const c = makeClient({ url: "https://t.example/", id: "ID", secret: "SEC", fetchImpl });
  await c.get("/api/x");
  assert.equal(calls[0].url, "https://t.example/api/x");
  assert.equal(calls[0].init.headers["CF-Access-Client-Id"], "ID");
  const bad = fakeApi({}, [], { failPatch: true });
  const c2 = makeClient({ url: "https://t.example", id: "I", secret: "S", fetchImpl: bad.fetchImpl });
  await assert.rejects(c2.patch("/api/y", {}), /409 version conflict/);
});

test("fetchEvents pages by before_id until a short page", async () => {
  const pages = [Array.from({ length: 200 }, (_, i) => ({ id: 1000 - i })), [{ id: 800 }]];
  const urls = [];
  const client = { get: async (p) => (urls.push(p), pages.shift()) };
  const all = await fetchEvents(client, "p 1");
  assert.equal(all.length, 201);
  assert.match(urls[0], /project_id=p%201&limit=200$/);
  assert.match(urls[1], /before_id=801$/);
});

const detail = { project, workpackages: [wp({ id: "w1", code: "T1" })], milestones: [], branches: [] };

test("run: dry run writes nothing", async () => {
  const api = fakeApi(detail, [ev()]);
  const out = [];
  const code = await run({
    args: { project: "p1", apply: false },
    client: makeClient({ url: "https://t.example", id: "I", secret: "S", fetchImpl: api.fetchImpl }),
    log: (l) => out.push(l),
  });
  assert.equal(code, 0);
  assert.ok(!api.calls.some((c) => c.init.method === "PATCH"));
  assert.match(out.join("\n"), /1 of 1 work packages would change/);
  assert.match(out.join("\n"), /Dry run/);
});

test("run --apply: PATCH with expected_version and only the changed fields", async () => {
  const api = fakeApi(detail, [ev()]);
  const code = await run({
    args: { project: "p1", apply: true },
    client: makeClient({ url: "https://t.example", id: "I", secret: "S", fetchImpl: api.fetchImpl }),
    log: () => {},
  });
  assert.equal(code, 0);
  const patch = api.calls.find((c) => c.init.method === "PATCH");
  assert.match(patch.url, /\/api\/workpackages\/w1$/);
  assert.deepEqual(JSON.parse(patch.init.body), { project_id: "p1", expected_version: 3, actual_start: "2026-02-10" });
});

test("run --apply: a failed write gives exit code 1; an unreadable tracker too", async () => {
  const api = fakeApi(detail, [ev()], { failPatch: true });
  const out = [];
  const client = makeClient({ url: "https://t.example", id: "I", secret: "S", fetchImpl: api.fetchImpl });
  assert.equal(await run({ args: { project: "p1", apply: true }, client, log: (l) => out.push(l) }), 1);
  assert.match(out.join("\n"), /FAILED T1/);
  const broken = {
    get: async () => {
      throw new Error("down");
    },
    patch: async () => {},
  };
  assert.equal(await run({ args: { project: "p1" }, client: broken, log: () => {} }), 1);
});

test("CLI: --help exits 0, missing project or credentials exits 2", () => {
  const sh = (args, env = {}) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
    });
  const h = sh(["--help"]);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /Usage: node scripts\/reconstruct-timeline\.mjs/);
  assert.equal(sh([]).status, 2);
  const noEnv = sh(["--project", "p1"]);
  assert.equal(noEnv.status, 2);
  assert.match(noEnv.stderr, /TRACKER_URL/);
});

test("review FIX t23: existing start is never rewritten by clamping", () => {
  const p = proposeWp(
    wp({ status: "done", actual_start: "2026-03-01" }),
    ctx({ events: [ev({ action: "update", ts: "2026-02-10T00:00:00Z", diff_json: JSON.stringify({ status: ["doing", "done"] }) })] }),
  );
  assert.equal(p.start.value, "2026-03-01");
  assert.equal(p.end.value, null);
  assert.deepEqual(changesFor(wp({ status: "done", actual_start: "2026-03-01" }), p), {});
});

test("review FIX t23: a status-only history gives the start (no fallback)", () => {
  const events = [ev({ action: "update", ts: "2026-02-03T00:00:00Z", diff_json: JSON.stringify({ status: ["todo", "doing"] }) })];
  assert.deepEqual(proposeWp(wp(), ctx({ events, opening: "2026-02-20" })).start, { value: "2026-02-03", source: "progress event" });
});

test("review FIX t23: an unreached gate opens nothing", () => {
  const o = gateOpenings([{ gate: 1, reached_at: null, decisions: [{ decision: "go", decided_at: "2026-02-10" }], unlocks: ["a"] }]);
  assert.equal(o.has("a"), false);
});

test("review FIX t23: fetchEvents fails when the page limit is reached", async () => {
  const client = { get: async () => Array.from({ length: 200 }, (_, i) => ({ id: 1000 - i })) };
  await assert.rejects(fetchEvents(client, "p", 2), /history incomplete/);
});

test("review FIX-fix1: go then hold does not open; hold then go does; later of reached and go", () => {
  const g = (reached, decisions) => gateOpenings([{ gate: 1, reached_at: reached, decisions, unlocks: ["a"] }]).get("a") ?? null;
  assert.equal(
    g("2026-02-01", [
      { decision: "go", decided_at: "2026-02-02" },
      { decision: "hold", decided_at: "2026-02-05" },
    ]),
    null,
  );
  assert.equal(
    g("2026-02-10", [
      { decision: "go", decided_at: "2026-02-02" },
      { decision: "hold", decided_at: "2026-02-05" },
    ]),
    null,
  );
  assert.equal(
    g("2026-02-01", [
      { decision: "hold", decided_at: "2026-02-02" },
      { decision: "go", decided_at: "2026-02-05" },
    ]),
    "2026-02-05",
  );
  assert.equal(
    g("2026-02-09", [
      { decision: "hold", decided_at: "2026-02-02" },
      { decision: "go_with_conditions", decided_at: "2026-02-05" },
    ]),
    "2026-02-09",
  );
});

test("review FIX-fix1: nearest ancestor start counts through a todo parent, independent of order", () => {
  const mk = (id, parent_id, o = {}) => ({
    id,
    parent_id,
    title: id,
    status: "doing",
    actual_start: null,
    actual_end: null,
    children: [],
    ...o,
  });
  const gc = mk("gc", "c");
  const c = mk("c", "root", { status: "todo", children: [gc] });
  const root = mk("root", null, { actual_start: "2026-02-03", children: [c] });
  const rows = buildProposals({ project, workpackages: [root], milestones: [], events: [] });
  assert.equal(rows.find((r) => r.wp.id === "gc").proposal.start.value, "2026-02-03");
});

test("review FIX-fix1: --git with a bad repo path is an error, exit 2", async () => {
  const api = fakeApi(detail, [ev()]);
  const out = [];
  const code = await run({
    args: { project: "p1", apply: true, git: "/nonexistent" },
    client: makeClient({ url: "https://t.example", id: "I", secret: "S", fetchImpl: api.fetchImpl }),
    log: (l) => out.push(l),
  });
  assert.equal(code, 2);
  assert.match(out.join("\n"), /not a git repository/);
  assert.ok(!api.calls.some((c) => c.init.method === "PATCH"));
  const real = await run({
    args: { project: "p1", apply: false, git: join(dirname(script), "no-such-dir-xyz") },
    client: makeClient({ url: "https://t.example", id: "I", secret: "S", fetchImpl: api.fetchImpl }),
    log: () => {},
  });
  assert.equal(real, 2);
});
