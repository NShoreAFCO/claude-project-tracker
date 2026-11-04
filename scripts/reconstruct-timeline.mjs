#!/usr/bin/env node
// One-off timeline reconstruction: proposes actual_start / actual_end for work packages that lack them.
// Dry run by default (prints a table); --apply writes the changed fields through the REST API.
// Rules: docs/UPDATING.md ("Reconstructing actual dates").
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const HELP = `Usage: node scripts/reconstruct-timeline.mjs --project <id> [--git <repo-path>] [--apply]

Proposes actual_start / actual_end for work packages (WPs) that have none, from the tracker's events,
gate openings, parent and project dates, and optionally the commit dates of the linked git branches.
Dry run by default: prints a table, changes nothing.

Options
  --project <id>     Project to read (required; one project per run)
  --git <path>       Local git repository to read first/last commit dates of the WPs' linked branches
  --apply            Write the proposals through the REST API (only the fields that change)
  --help             Show this text

Environment (same names as the session-end hook)
  TRACKER_URL                 Base URL of the tracker
  TRACKER_CF_CLIENT_ID        Access service token id
  TRACKER_CF_CLIENT_SECRET    Access service token secret

Start order for a WP without actual_start: earliest progress event (notes do not count), then the
opening of a gate that unlocks it, then the parent WP start, the project start date, the project
creation date. Git commit dates, where present, replace the gate/parent/project fallbacks and
any later event date. The end (done WPs only) is the date the WP was set to done, else the last
commit, else the last progress event. The start is never later than the end.

Exit codes: 0 done (or nothing to do), 1 the tracker could not be read or a write failed,
2 bad usage or configuration.`;

export function parseArgs(argv) {
  const o = { project: null, git: null, apply: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--apply") o.apply = true;
    else if (a === "--project" || a === "--git") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) return { error: `${a} needs a value` };
      o[a.slice(2)] = v;
    } else return { error: `unknown argument: ${a}` };
  }
  if (!o.help && !o.project) return { error: "--project <id> is required" };
  return o;
}

const day = (s) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
const minDay = (a) => a.filter(Boolean).sort()[0] ?? null;
const maxDay = (a) => a.filter(Boolean).sort().at(-1) ?? null;

function diffOf(e) {
  if (!e.diff_json) return {};
  try {
    return typeof e.diff_json === "string" ? JSON.parse(e.diff_json) || {} : e.diff_json;
  } catch {
    return {};
  }
}

/** Events of a WP that show work: progress logs, or a change to doing/done or progress above 0. Notes never count. */
export function startEvidence(wp, events) {
  const mine = events.filter((e) => e.entity === "workpackage" && e.entity_id === wp.id && e.action !== "note");
  const out = [];
  for (const e of mine) {
    const d = diffOf(e);
    const worked =
      e.action === "progress" || ["doing", "done"].includes(d.status?.[1]) || (typeof d.progress?.[1] === "number" && d.progress[1] > 0);
    if (worked && day(e.ts)) out.push({ date: day(e.ts), done: d.status?.[1] === "done", progress: e.action === "progress" });
  }
  // D21 (h): old progress events count as a start only if the WP is not in todo now
  return wp.status === "todo" ? [] : out;
}

/** Date each WP became unlocked: per gate max(reached, first go decision); over several gates the latest. */
export function gateOpenings(milestones) {
  const by = new Map();
  for (const m of milestones) {
    let open = day(m.reached_at);
    if (m.gate && !open) continue; // a gate that was never reached opened nothing (D6)
    if (m.gate) {
      const decisions = m.decisions ?? [];
      const go = decisions.filter((d) => ["go", "go_with_conditions"].includes(d.decision)).map((d) => day(d.decided_at));
      if (go.length) open = maxDay([open, minDay(go)]);
      else if (decisions.length) open = null; // decided, never go: not opened
    }
    if (!open) continue;
    for (const id of m.unlocks ?? []) by.set(id, maxDay([by.get(id), open]));
  }
  return by;
}

/** Flatten the WP tree, parents first. */
export function flattenTree(nodes, out = []) {
  for (const n of nodes) {
    out.push(n);
    flattenTree(n.children ?? [], out);
  }
  return out;
}

/** Merge git commit dates ({first,last}) into the event/fallback proposal. */
export function mergeGit(proposal, git, wp) {
  const p = { start: { ...proposal.start }, end: { ...proposal.end } };
  if (git?.first && !wp.actual_start) {
    const eventBased = p.start.source === "progress event";
    if (!p.start.value || !eventBased || git.first < p.start.value) p.start = { value: git.first, source: "git first commit" };
  }
  if (git?.last && wp.status === "done" && !wp.actual_end && p.end.source !== "done event") {
    p.end = { value: git.last, source: "git last commit" };
  }
  return p;
}

/** Start never later than end. */
export function clamp({ start, end }, wp = {}) {
  if (start.value && end.value && start.value > end.value) {
    // never rewrite an existing start: keep the current end instead of a proposal that contradicts it
    if (wp.actual_start)
      return { start, end: { value: wp.actual_end ?? null, source: "current (proposed end is before the existing start)" } };
    return { start: { value: end.value, source: `${start.source}, clamped to end` }, end };
  }
  return { start, end };
}

/** D21 (e) for one WP. ctx: { project, parentStart, opening, events, git }. Existing dates are kept. */
export function proposeWp(wp, ctx) {
  const ev = startEvidence(wp, ctx.events);
  const progress = ev.map((e) => e.date);
  let start = { value: wp.actual_start ?? null, source: "current" };
  if (!wp.actual_start) {
    const steps = [
      [minDay(progress), "progress event"],
      [ctx.opening, "gate opening"],
      [day(ctx.parentStart), "parent start"],
      [day(ctx.project.start_date), "project start"],
      [day(ctx.project.created_at), "project created"],
    ];
    const hit = steps.find(([v]) => v);
    start = hit ? { value: hit[0], source: hit[1] } : { value: null, source: "no evidence" };
  }
  let end = { value: wp.actual_end ?? null, source: "current" };
  if (!wp.actual_end && wp.status === "done") {
    const doneDate = maxDay(ev.filter((e) => e.done).map((e) => e.date));
    const last = maxDay(ev.map((e) => e.date));
    if (doneDate) end = { value: doneDate, source: "done event" };
    else if (ctx.git?.last) end = { value: ctx.git.last, source: "git last commit" };
    else if (last) end = { value: last, source: "progress event" };
    else end = { value: null, source: "no evidence" };
  }
  return clamp(ctx.git ? mergeGit({ start, end }, ctx.git, wp) : { start, end }, wp);
}

/** Fields to write: only those that are proposed and differ from the current value. */
export function changesFor(wp, p) {
  const c = {};
  if (p.start.value && p.start.value !== (wp.actual_start ?? null)) c.actual_start = p.start.value;
  if (p.end.value && p.end.value !== (wp.actual_end ?? null)) c.actual_end = p.end.value;
  return c;
}

/** Build all proposals for a project. Parents come first so a child sees its parent's proposed start. */
export function buildProposals({ project, workpackages, milestones, events, gitByWp = new Map() }) {
  const openings = gateOpenings(milestones);
  const effStart = new Map();
  const rows = [];
  for (const wp of flattenTree(workpackages)) {
    const parentStart = wp.parent_id ? (effStart.get(wp.parent_id) ?? null) : null;
    const proposal = proposeWp(wp, { project, parentStart, opening: openings.get(wp.id) ?? null, events, git: gitByWp.get(wp.id) ?? null });
    effStart.set(wp.id, proposal.start.value);
    rows.push({ wp, proposal, changes: changesFor(wp, proposal) });
  }
  return rows;
}

export function formatTable(rows) {
  const head = ["WP", "current start", "proposed start", "start source", "current end", "proposed end", "end source"];
  const cell = (v) => v ?? "-";
  const body = rows.map(({ wp, proposal: p }) => [
    `${wp.code ? wp.code + " " : ""}${wp.title}`.slice(0, 48),
    cell(wp.actual_start),
    cell(p.start.value),
    p.start.source,
    cell(wp.actual_end),
    cell(p.end.value),
    p.end.source,
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (r) =>
    r
      .map((c, i) => c.padEnd(w[i]))
      .join("  ")
      .trimEnd();
  return [line(head), line(w.map((n) => "-".repeat(n))), ...body.map(line)].join("\n");
}

// ---- git (optional)

export function gitDefaultRunner(repo, args) {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 15000,
    });
  } catch {
    return null;
  }
}

/** First/last commit date (author date) on a branch; with a base, only commits not on the base. Tries name, then origin/name. */
export function branchDates(repo, branch, run = gitDefaultRunner) {
  for (const ref of [branch.name, `origin/${branch.name}`]) {
    const range = branch.base ? `${branch.base}..${ref}` : ref;
    const out = run(repo, ["log", "--format=%as", range]);
    const dates = (out ?? "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
    if (dates.length) return { first: minDay(dates), last: maxDay(dates) };
  }
  return null;
}

/** wp id -> { first, last } over all its linked branches. */
export function gitEvidence(branches, repo, run = gitDefaultRunner) {
  const by = new Map();
  for (const b of branches) {
    if (!b.workpackage_id) continue;
    const d = branchDates(repo, b, run);
    if (!d) continue;
    const cur = by.get(b.workpackage_id);
    by.set(b.workpackage_id, cur ? { first: minDay([cur.first, d.first]), last: maxDay([cur.last, d.last]) } : d);
  }
  return by;
}

// ---- REST

export function makeClient({ url, id, secret, fetchImpl = fetch }) {
  const base = url.replace(/\/+$/, "");
  const call = async (method, path, body) => {
    const res = await fetchImpl(base + path, {
      method,
      headers: { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${data?.error ?? data?.message ?? text.slice(0, 120)}`);
    return data;
  };
  return { get: (p) => call("GET", p), patch: (p, b) => call("PATCH", p, b) };
}

/** All events of a project, newest first, paged by before_id. */
export async function fetchEvents(client, projectId, maxPages = 500) {
  const all = [];
  let before;
  for (let page = 0; page < maxPages; page++) {
    const rows = await client.get(
      `/api/events?project_id=${encodeURIComponent(projectId)}&limit=200${before ? `&before_id=${before}` : ""}`,
    );
    all.push(...rows);
    if (rows.length < 200) return all;
    before = rows[rows.length - 1].id;
  }
  throw new Error(`more than ${maxPages * 200} events: history incomplete, refusing to propose dates`);
}

export async function run({ args, client, gitRun = gitDefaultRunner, log = console.log }) {
  let detail, events;
  try {
    detail = await client.get(`/api/projects/${encodeURIComponent(args.project)}`);
    events = await fetchEvents(client, args.project);
  } catch (e) {
    log(`Could not read the tracker: ${e.message}`);
    return 1;
  }
  const gitByWp = args.git ? gitEvidence(detail.branches ?? [], args.git, gitRun) : new Map();
  const rows = buildProposals({
    project: detail.project,
    workpackages: detail.workpackages,
    milestones: detail.milestones,
    events,
    gitByWp,
  });
  log(formatTable(rows));
  const todo = rows.filter((r) => Object.keys(r.changes).length);
  log(`\n${todo.length} of ${rows.length} work packages would change.`);
  if (!args.apply) {
    if (todo.length) log("Dry run: nothing written. Add --apply to write the changes.");
    return 0;
  }
  let failed = 0;
  for (const { wp, changes } of todo) {
    try {
      await client.patch(`/api/workpackages/${encodeURIComponent(wp.id)}`, {
        project_id: args.project,
        expected_version: wp.version,
        ...changes,
      });
      log(
        `updated ${wp.code ?? wp.id}: ${Object.entries(changes)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}`,
      );
    } catch (e) {
      failed++;
      log(`FAILED ${wp.code ?? wp.id}: ${e.message}`);
    }
  }
  return failed ? 1 : 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`${args.error}\n\n${HELP}`);
    return 2;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const { TRACKER_URL, TRACKER_CF_CLIENT_ID, TRACKER_CF_CLIENT_SECRET } = process.env;
  if (!TRACKER_URL || !TRACKER_CF_CLIENT_ID || !TRACKER_CF_CLIENT_SECRET) {
    console.error("Set TRACKER_URL, TRACKER_CF_CLIENT_ID and TRACKER_CF_CLIENT_SECRET in the environment.");
    return 2;
  }
  const client = makeClient({ url: TRACKER_URL, id: TRACKER_CF_CLIENT_ID, secret: TRACKER_CF_CLIENT_SECRET });
  return run({ args, client });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (c) => process.exit(c),
    (e) => (console.error(e.message), process.exit(1)),
  );
}
