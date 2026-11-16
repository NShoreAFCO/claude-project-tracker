/**
 * apply_changes: up to 100 work package (`wp`) and milestone (`ms`) upserts on one project, all or nothing.
 *
 * Phase A reads the project once (a fixed number of queries, whatever the op count) and runs every op, in
 * array order, on an in-memory overlay (the stored rows plus the effect of every earlier op) with the same
 * rule functions the single tools use. Phase B is one db.batch (one transaction): version guards, then per
 * op its guards, its write, its event, its activity and reachStmts, then the schedule statements. Any guard
 * that fails aborts the whole batch; Phase C maps the D1 message to the failing op.
 */
import type { Caller, MilestoneRow, WorkpackageRow } from "../types";
import { requireAction, toolAction, type Action } from "../auth/permissions";
import { isAgent } from "../auth/caller";
import { ackLine } from "../mcp/ack";
import {
  ConflictError,
  ForbiddenError,
  LIVE,
  NotFoundError,
  TooLargeError,
  ValidationError,
  diffFields,
  eventStmt,
  newId,
  now,
  slugify,
  utf8Bytes,
  type Diff,
} from "./util";
import { activitySet, isSystem, projectActivityStmt } from "./activity";
import { ID_RE, PROJECT_OPEN_SQL, WRITE_COLS, applyActualDates, normaliseWp, stakeholderStmts } from "./workpackages";
import { MS_FIELDS, idList, normaliseMs, reachStmts } from "./milestones";
import {
  OPENING_DECISIONS,
  agentGateRemovalError,
  gateClosedSql,
  gateGuardStmt,
  gateLockedError,
  gatesEnforced,
  latestDecisionSql,
  lockingGates,
  type GateRef,
} from "./gates";
import {
  applyVerificationRules,
  applyWpRules,
  isClosedProjectStatus,
  isOpenWpStatus,
  parseBlockedBy,
  projectClosedError,
  verificationNotAboveSql,
} from "./rules";
import { dependsOnCycle, recomputeScheduleStmts, scheduleConflictError, snapMs, snapWp, type ScheduleIssue } from "./schedule";

export const MAX_OPS = 100;
export const MAX_OPS_BYTES = 128 * 1024;
export const MAX_STMTS = 1500;
export const MAX_WARNINGS = 50;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
/** Op kind → the single tool whose permission (TOOL_ACTIONS) and rules it shares. */
export const OP_TOOL: Readonly<Record<string, string>> = { wp: "upsert_workpackage", ms: "upsert_milestone" };
const WP_REF_FIELDS = ["parent_id", "depends_on"] as const;
const MS_REF_FIELDS = ["requires", "unlocks", "workpackage_id"] as const;

type Obj = Record<string, unknown>;
export type Failed = { index: number | null; ref?: string; code: string };

/** A refused call: names the failing op; `opArgs` are that op's fields (a 409's `current` is slimmed to them). */
export class OpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly failed: Failed,
    readonly current?: unknown,
    readonly opArgs?: Obj,
  ) {
    super(message);
  }
}

const KIND: Record<number, string> = { 400: "invalid", 403: "forbidden", 404: "not_found", 409: "conflict", 413: "too_large" };
type Coded = Error & { status?: number; current?: unknown; batchCode?: string };
const coded = (e: Coded, code: string): Coded => Object.assign(e, { batchCode: code });
const invalid = (code: string, message: string): Coded => coded(new ValidationError(message), code);

function toOpError(e: unknown, index: number | null, key?: string, opArgs?: Obj): OpError {
  if (e instanceof OpError) return e;
  const err = e as Coded;
  if (!err?.status) throw e;
  const cur = err.current as { code?: unknown } | undefined;
  // A row in `current` (a version conflict) has its own `code` column: only a details object names the error code.
  const detailCode = cur && typeof cur.code === "string" && typeof (cur as { version?: unknown }).version !== "number" ? cur.code : undefined;
  const code = err.batchCode ?? detailCode ?? KIND[err.status] ?? "error";
  const msg = String(err.message ?? "");
  const where = index === null ? "" : `op ${index}${key ? ` (${key})` : ""}: `;
  return new OpError(
    err.status,
    `${where}${/[.!?]$/.test(msg) ? msg : `${msg}.`} Nothing was applied.`,
    { index, ...(key ? { ref: key } : {}), code },
    err.status === 409 ? err.current : undefined,
    opArgs,
  );
}

type Wp = WorkpackageRow & { stake: string[] };
type Ms = MilestoneRow & { requires: string[]; unlocks: string[]; latest: string | null; reached: boolean };
type PersonHit = { v: string; by_id: string | null; by_email: string | null; name_n: number; by_name: string | null };

/** The op's key: its `ref`, else the code a `wp` op sets. */
function keyOf(op: unknown): string | undefined {
  if (!op || typeof op !== "object") return undefined;
  const o = op as Obj;
  if (typeof o.ref === "string") return o.ref;
  if (o.op === "wp" && typeof o.code === "string" && o.code.trim()) return o.code.trim();
  return undefined;
}

/** Test seam: receives the overlay's gate locks after the last op (parity with gateLockedWpIds). */
let afterPlan: ((locks: Map<string, GateRef[]>) => void) | null = null;
export function setAfterPlanForTesting(f: ((locks: Map<string, GateRef[]>) => void) | null): void {
  afterPlan = f;
}

export type ApplyOptions = {
  /** Action lookup per tool name (default: the central TOOL_ACTIONS table). */
  actionOf?: (tool: string) => Action | undefined;
  /** Per-op schema check: returns the op's fields or throws a ValidationError naming the path. */
  parse?: (op: unknown, index: number) => Obj;
};
export type ApplyResult = { ops: Obj[]; warnings?: Array<ScheduleIssue & { op: number | null }>; warnings_more?: number };

type Plan = {
  index: number;
  kind: "wp" | "ms";
  key?: string;
  ref?: string;
  args: Obj;
  id: string;
  create: boolean;
  /** Stored version of an update target (version guard). */
  storedVersion?: number;
  changed: boolean;
  stmts: D1PreparedStatement[];
  gateIds: string[];
  removalGuard: boolean;
  reopensOrCreates: boolean;
  dependsChanged: boolean;
  line: Obj;
};

/** Phase A + B + C. Throws OpError on any refusal (nothing written). */
export async function applyChanges(db: D1Database, projectId: string, rawOps: unknown, by: Caller, opts: ApplyOptions = {}): Promise<ApplyResult> {
  const actionOf = opts.actionOf ?? toolAction;
  if (!Array.isArray(rawOps) || !rawOps.length) throw toOpError(invalid("OP_INVALID", "ops must list 1 to 100 changes"), null);
  if (rawOps.length > MAX_OPS)
    throw toOpError(new TooLargeError(`ops has ${rawOps.length} entries, at most ${MAX_OPS} per call: split the call`), null);
  if (utf8Bytes(JSON.stringify(rawOps)) > MAX_OPS_BYTES) throw toOpError(new TooLargeError("ops is larger than 128 KB: split the call"), null);

  // Permission per op kind through the central table (fail closed on an unmapped kind or action).
  rawOps.forEach((o, i) => {
    try {
      const kind = (o as Obj | null)?.op;
      const tool = typeof kind === "string" && Object.hasOwn(OP_TOOL, kind) ? OP_TOOL[kind] : undefined;
      const action = tool ? actionOf(tool) : undefined;
      if (!action) throw new ForbiddenError(`no permission is defined for op kind ${String(kind)}`);
      requireAction(by, action);
    } catch (e) {
      throw toOpError(e, i, keyOf(o));
    }
  });

  // Schema, ref format, locator and ref uniqueness.
  const ops: Obj[] = rawOps.map((o, i) => {
    try {
      const op = opts.parse ? opts.parse(o, i) : (o as Obj);
      if (op.ref !== undefined && (typeof op.ref !== "string" || !REF_RE.test(op.ref)))
        throw invalid("OP_INVALID", `ops[${i}].ref must match ${REF_RE.source}`);
      if (op.op === "wp" && op.id != null && op.wp_code !== undefined) throw invalid("OP_INVALID", "Give id or wp_code, not both.");
      return op;
    } catch (e) {
      throw toOpError(coded(e as Coded, (e as Coded).batchCode ?? "OP_INVALID"), i, keyOf(o));
    }
  });
  const refsSeen = new Set<string>();
  ops.forEach((op, i) => {
    if (typeof op.ref !== "string") return;
    if (refsSeen.has(op.ref)) throw toOpError(invalid("REF_DUPLICATE", `ref ${op.ref} is used by an earlier op`), i, op.ref);
    refsSeen.add(op.ref);
  });

  // Keys and explicit ids of every op (forward detection).
  const allKeys = new Map<string, number[]>();
  const explicitIds = new Map<string, number>();
  ops.forEach((op, i) => {
    const k = keyOf(op);
    if (op.op === "wp" && k) allKeys.set(k, [...(allKeys.get(k) ?? []), i]);
    if (typeof op.id === "string" && !explicitIds.has(op.id)) explicitIds.set(op.id, i);
  });

  // ---- Phase A, R1: one batch of reads.
  const literal = new Set<string>();
  for (const op of ops) {
    if (typeof op.id === "string") literal.add(op.id);
    for (const f of [...WP_REF_FIELDS, ...MS_REF_FIELDS]) {
      const v = op[f];
      for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "string" && !x.startsWith("@")) literal.add(x);
    }
  }
  const literalJson = JSON.stringify([...literal]);
  const prefix = `${projectId}-`;
  const [pRes, wRes, sRes, mRes, lRes, fwRes, fmRes, tRes] = await db.batch([
    db.prepare("SELECT id, owner_person_id, owner_text, status, deleted_at FROM project WHERE id = ?").bind(projectId),
    db.prepare("SELECT * FROM workpackage WHERE project_id = ?").bind(projectId),
    db
      .prepare(
        `SELECT s.workpackage_id, s.person_id FROM wp_stakeholder s JOIN workpackage w ON w.id = s.workpackage_id
         JOIN person p ON p.id = s.person_id AND ${LIVE("p")} WHERE w.project_id = ?`,
      )
      .bind(projectId),
    db.prepare(`SELECT m.*, ${latestDecisionSql("m")} AS latest FROM milestone m WHERE m.project_id = ?`).bind(projectId),
    db
      .prepare(
        `SELECT l.milestone_id, l.workpackage_id, l.role FROM milestone_link l JOIN milestone m ON m.id = l.milestone_id
         JOIN workpackage w ON w.id = l.workpackage_id AND ${LIVE("w")} WHERE m.project_id = ? ORDER BY l.workpackage_id`,
      )
      .bind(projectId),
    db.prepare("SELECT id, project_id, deleted_at FROM workpackage WHERE id IN (SELECT value FROM json_each(?)) AND project_id != ?").bind(literalJson, projectId),
    db.prepare("SELECT id, project_id, deleted_at FROM milestone WHERE id IN (SELECT value FROM json_each(?)) AND project_id != ?").bind(literalJson, projectId),
    db.prepare("SELECT id FROM workpackage WHERE substr(id, 1, ?) = ? AND project_id != ?").bind(prefix.length, prefix, projectId),
  ]);
  const project = pRes.results[0] as { status: string; deleted_at: string | null } | undefined;
  if (!project || project.deleted_at) throw toOpError(new NotFoundError(`project ${projectId} not found`), null);
  const closed = isClosedProjectStatus(project.status);

  const wps = new Map<string, Wp>();
  for (const w of wRes.results as WorkpackageRow[]) wps.set(w.id, { ...w, stake: [] });
  for (const s of sRes.results as Array<{ workpackage_id: string; person_id: string }>) wps.get(s.workpackage_id)?.stake.push(s.person_id);
  for (const w of wps.values()) w.stake.sort();
  const mss = new Map<string, Ms>();
  for (const m of mRes.results as Array<MilestoneRow & { latest: string | null }>)
    mss.set(m.id, { ...m, requires: [], unlocks: [], reached: m.reached_at !== null });
  for (const l of lRes.results as Array<{ milestone_id: string; workpackage_id: string; role: string }>) {
    const m = mss.get(l.milestone_id);
    if (m) (l.role === "requires" ? m.requires : m.unlocks).push(l.workpackage_id);
  }
  const foreignWp = new Map((fwRes.results as Array<{ id: string; project_id: string; deleted_at: string | null }>).map((r) => [r.id, r]));
  const foreignMs = new Map((fmRes.results as Array<{ id: string; project_id: string; deleted_at: string | null }>).map((r) => [r.id, r]));
  const taken = new Set<string>([...wps.keys(), ...(tRes.results as Array<{ id: string }>).map((r) => r.id), ...foreignWp.keys()]);
  const storedCodes = new Map<string, string[]>();
  for (const w of wps.values()) if (!w.deleted_at && w.code) storedCodes.set(w.code, [...(storedCodes.get(w.code) ?? []), w.id]);

  // ---- Phase A, step 2: person refs, one query (resolvePersonRef's precedence, evaluated in SQL per value).
  const personVals = new Set<string>();
  for (const op of ops) {
    for (const v of [op.owner, op.verified_by, ...(Array.isArray(op.priority_stakeholders) ? op.priority_stakeholders : [])])
      if (typeof v === "string" && v.trim()) personVals.add(v.trim());
  }
  const people = new Map<string, string | null>();
  if (personVals.size) {
    const { results } = await db
      .prepare(
        `SELECT json_extract(j.value, '$[0]') AS v,
           (SELECT p.id FROM person p WHERE p.id = json_extract(j.value, '$[0]') AND p.deleted_at IS NULL) AS by_id,
           (SELECT p.id FROM person p WHERE p.email IS NOT NULL AND lower(p.email) = json_extract(j.value, '$[1]') AND p.deleted_at IS NULL LIMIT 1) AS by_email,
           (SELECT COUNT(*) FROM (SELECT 1 FROM person p WHERE lower(p.name) = lower(json_extract(j.value, '$[0]')) AND p.deleted_at IS NULL LIMIT 2)) AS name_n,
           (SELECT p.id FROM person p WHERE lower(p.name) = lower(json_extract(j.value, '$[0]')) AND p.deleted_at IS NULL LIMIT 1) AS by_name
         FROM json_each(?) j`,
      )
      .bind(JSON.stringify([...personVals].map((v) => [v, v.toLowerCase()])))
      .all<PersonHit>();
    for (const r of results)
      people.set(r.v, r.by_id ?? (r.v.includes("@") ? r.by_email : null) ?? (r.name_n === 1 ? r.by_name : null) ?? null);
  }
  const resolvePerson = (ref: string): { person_id: string | null; text: string | null } => {
    const v = ref.trim();
    if (!v) return { person_id: null, text: null };
    const id = people.get(v) ?? null;
    return id ? { person_id: id, text: null } : { person_id: null, text: v };
  };

  // ---- Phase A, step 3: blocked_by wp:/ms: targets, one query.
  const blockedIds = { wp: new Set<string>(), ms: new Set<string>() };
  for (const op of ops) {
    const r = typeof op.blocked_by === "string" ? parseBlockedBy(op.blocked_by) : null;
    if (r && (r.kind === "wp" || r.kind === "ms")) blockedIds[r.kind].add(r.ref);
  }
  const liveBlocked = new Set<string>();
  if (blockedIds.wp.size || blockedIds.ms.size) {
    const { results } = await db
      .prepare(
        `SELECT 'wp' AS k, id FROM workpackage WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL
         UNION ALL SELECT 'ms' AS k, id FROM milestone WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL`,
      )
      .bind(JSON.stringify([...blockedIds.wp]), JSON.stringify([...blockedIds.ms]))
      .all<{ k: string; id: string }>();
    for (const r of results) liveBlocked.add(`${r.k}:${r.id}`);
  }

  // ---- Overlay helpers.
  const targeted = new Set<string>();
  const createdBy = new Map<string, number>();
  const opKeys = new Map<string, string[]>();
  const liveWp = (id: string): Wp | undefined => {
    const w = wps.get(id);
    return w && !w.deleted_at ? w : undefined;
  };
  const qualifies = (m: Ms): boolean => {
    const req = m.requires.map((id) => liveWp(id)).filter((w): w is Wp => !!w);
    return req.some((w) => w.status !== "dropped") && req.every((w) => w.status === "done" || w.status === "dropped");
  };
  const enforced = gatesEnforced();
  const gateOrder = (a: Ms, b: Ms): number =>
    Number(a.due_date === null) - Number(b.due_date === null) ||
    String(a.due_date ?? "").localeCompare(String(b.due_date ?? "")) ||
    a.sort - b.sort ||
    (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  /** The overlay's gate locks (rule of lockedCte): WP id → locking gates in gate order, and the lock roots. */
  const locks = (): { by: Map<string, GateRef[]>; roots: Set<string> } => {
    const out = new Map<string, GateRef[]>();
    const roots = new Set<string>();
    if (!enforced) return { by: out, roots };
    const closedGates = [...mss.values()]
      .filter((m) => m.gate === 1 && !m.deleted_at && (!m.reached || !(OPENING_DECISIONS as readonly string[]).includes(m.latest ?? "")))
      .sort(gateOrder);
    const children = new Map<string, Wp[]>();
    for (const w of wps.values()) if (w.parent_id && !w.deleted_at && !w.gate_override_at) children.set(w.parent_id, [...(children.get(w.parent_id) ?? []), w]);
    for (const g of closedGates) {
      const ref: GateRef = { milestone_id: g.id, title: g.title };
      const stack: string[] = [];
      for (const id of g.unlocks) {
        const w = liveWp(id);
        if (!w || w.gate_override_at || w.status === "doing" || w.status === "done" || w.progress !== 0) continue;
        roots.add(id);
        stack.push(id);
      }
      const seen = new Set<string>();
      while (stack.length) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const list = out.get(id) ?? [];
        if (!list.some((r) => r.milestone_id === g.id)) out.set(id, [...list, ref]);
        for (const c of children.get(id) ?? []) stack.push(c.id);
      }
    }
    return { by: out, roots };
  };

  const later = (key: string, i: number): boolean => (allKeys.get(key) ?? []).some((j) => j > i);
  /** One ref field value → a WP id (refs and literal ids; existence on stored + earlier ops). */
  const resolveRef = (v: string, i: number, field: string): string => {
    if (v.startsWith("@")) {
      const x = v.slice(1);
      const ids = new Set<string>([...(opKeys.get(x) ?? []), ...(storedCodes.get(x) ?? [])]);
      if (!ids.size) {
        if (later(x, i)) throw invalid("REF_FORWARD", `${field} ${v} names a later op; refs name earlier ops only`);
        throw invalid("REF_UNKNOWN", `${field} ${v} matches no work package of this project`);
      }
      if (ids.size > 1) throw invalid("REF_AMBIGUOUS", `${field} ${v} matches ${[...ids].join(", ")}; give the id`);
      return [...ids][0];
    }
    if (!liveWp(v) && (explicitIds.get(v) ?? -1) > i && !wps.has(v))
      throw invalid("REF_FORWARD", `${field} ${v} is created by a later op; refs name earlier ops only`);
    return v;
  };
  const refList = (v: unknown, i: number, field: string): unknown =>
    Array.isArray(v) ? v.map((x) => (typeof x === "string" ? resolveRef(x, i, field) : x)) : v;
  const refOne = (v: unknown, i: number, field: string): unknown => (typeof v === "string" && v ? resolveRef(v, i, field) : v);

  const startGuardPlan = (wp: Wp | null, next: Obj): { stmts: D1PreparedStatement[]; ids: string[] } => {
    const out = { stmts: [] as D1PreparedStatement[], ids: [] as string[] };
    if (by.channel === "system" || !enforced) return out;
    const started = (s: unknown) => s === "doing" || s === "done";
    const status = next.status !== undefined ? next.status : (wp?.status ?? "todo");
    const progress = typeof next.progress === "number" ? next.progress : (wp?.progress ?? 0);
    const startedAfter = started(status) || progress > 0;
    const oldParent = wp?.parent_id ?? null;
    const parent = next.parent_id !== undefined ? ((next.parent_id as string | null) ?? null) : oldParent;
    const parentChanged = !!wp && next.parent_id !== undefined && parent !== oldParent;
    const l = locks();
    if (wp) {
      const toStarted = started(next.status) && next.status !== wp.status;
      const progressChange = typeof next.progress === "number" && next.progress !== wp.progress;
      if (toStarted || progressChange) {
        const gates = l.by.get(wp.id) ?? [];
        if (gates.length) throw gateLockedError(wp.id, gates, by);
        out.stmts.push(gateGuardStmt(db, wp.id));
        out.ids.push(wp.id);
      }
      if (parentChanged) {
        if (l.by.has(wp.id) && !l.roots.has(wp.id)) throw gateLockedError(wp.id, l.by.get(wp.id)!, by);
        out.stmts.push(gateGuardStmt(db, wp.id, true));
        out.ids.push(wp.id);
      }
    }
    if (parent && startedAfter && (parentChanged || !wp)) {
      const gates = l.by.get(parent) ?? [];
      if (gates.length) throw gateLockedError(parent, gates, by);
      out.stmts.push(gateGuardStmt(db, parent));
      out.ids.push(parent);
    }
    return out;
  };

  const checkParent = (selfId: string | null, parentId: unknown): void => {
    if (parentId === null || parentId === undefined) return;
    if (!liveWp(String(parentId))) throw new ValidationError(`parent ${String(parentId)} is not a workpackage of project ${projectId}`);
    let cur: string | null = String(parentId);
    for (let depth = 0; cur && depth < 100; depth++) {
      if (cur === selfId) throw new ValidationError("cycle: a workpackage cannot be its own ancestor");
      cur = wps.get(cur)?.parent_id ?? null;
    }
  };
  const checkDepsExist = (selfId: string, deps: string[]): void => {
    const bad = deps.filter((d) => d === selfId || !liveWp(d));
    if (bad.length) throw new ValidationError(`depends_on: not other workpackages of project ${projectId}: ${bad.join(", ")}`);
  };

  // ---- Phase A, step 4: per op on the overlay.
  const plans: Plan[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const key = keyOf(op);
    const { op: kind, ref, expected_version, wp_code, ...rest } = op;
    const opArgs: Obj = { ...rest, ...(wp_code !== undefined ? { wp_code } : {}) };
    try {
      const input: Obj = { ...rest };
      if (kind === "wp") {
        if (wp_code !== undefined) {
          const code = String(wp_code).trim();
          const hits = storedCodes.get(code) ?? [];
          if (!hits.length) throw new NotFoundError(`work package ${code} not found in project ${projectId}`);
          if (hits.length > 1) throw new ValidationError(`work package code ${code} is ambiguous in project ${projectId}: ${hits.join(", ")}; give the id`);
          input.id = hits[0];
        }
        for (const f of WP_REF_FIELDS) if (f in input) input[f] = f === "depends_on" ? refList(input[f], i, f) : refOne(input[f], i, f);
        plans.push(planWp(i, key, ref as string | undefined, input, opArgs, typeof expected_version === "number" ? expected_version : undefined));
      } else {
        for (const f of MS_REF_FIELDS) if (f in input) input[f] = f === "workpackage_id" ? refOne(input[f], i, f) : refList(input[f], i, f);
        plans.push(planMs(i, key, ref as string | undefined, input, opArgs, typeof expected_version === "number" ? expected_version : undefined));
      }
    } catch (e) {
      throw toOpError(e, i, key, opArgs);
    }
    // Reached inside the call: a gate whose requires qualify is open for later ops once decided go.
    for (const m of mss.values()) if (!m.deleted_at && !m.reached && qualifies(m)) m.reached = true;
  }

  function planWp(i: number, key: string | undefined, ref: string | undefined, input: Obj, opArgs: Obj, expectedVersion?: number): Plan {
    const fields: Obj = normaliseWp(input);
    if (fields.status === "done" && fields.progress === undefined) fields.progress = 100;
    if (input.owner !== undefined) {
      const v = input.owner;
      if (v !== null && typeof v !== "string") throw new ValidationError("owner must be a person id, an email or a name");
      if (typeof v === "string" && v.trim().length > 200) throw new ValidationError("owner is longer than 200 characters");
      const o = typeof v === "string" ? resolvePerson(v) : { person_id: null, text: null };
      fields.owner_person_id = o.person_id;
      fields.owner_text = o.text;
    }
    let stakeholders: string[] | undefined;
    if (input.priority_stakeholders !== undefined) {
      const v = input.priority_stakeholders;
      if (v === null) stakeholders = [];
      else {
        if (!Array.isArray(v) || v.length > 50 || v.some((x) => typeof x !== "string"))
          throw new ValidationError("priority_stakeholders must be a list of up to 50 person ids, emails or names");
        const ids: string[] = [];
        for (const r of v as string[]) {
          const p = resolvePerson(r);
          if (!p.person_id) throw new ValidationError(`priority_stakeholders: "${r}" matches no person; add them with upsert_person first`);
          if (!ids.includes(p.person_id)) ids.push(p.person_id);
        }
        stakeholders = ids.sort();
      }
    }
    if (input.verified_by !== undefined) {
      const v = input.verified_by;
      if (v === null || v === "") fields.verified_by = null;
      else {
        if (typeof v !== "string" || v.trim().length > 200) throw new ValidationError("verified_by must be a person id or email");
        const { person_id } = resolvePerson(v);
        if (!person_id)
          throw new ValidationError(`verified_by: "${v.trim()}" matches no person; verified_by must reference a person, not free text or an agent`);
        if (isAgent(by) && person_id !== by.personId)
          throw new ForbiddenError("agents may only record their own login's person as verified_by; the person who verified records it in the dashboard");
        fields.verified_by = person_id;
      }
    }
    if (fields.blocked_by !== undefined) {
      const r = typeof fields.blocked_by === "string" ? parseBlockedBy(fields.blocked_by) : null;
      if (r && (r.kind === "wp" || r.kind === "ms")) {
        const earlier = r.kind === "wp" ? !!liveWp(r.ref) && createdBy.has(r.ref) : createdBy.has(r.ref) && !!mss.get(r.ref);
        if (!earlier && !liveBlocked.has(`${r.kind}:${r.ref}`)) {
          const table = r.kind === "wp" ? "workpackage" : "milestone";
          throw new ValidationError(`blocked_by: ${table} ${r.ref} not found (use ext:<text> for external blockers)`);
        }
      }
    }
    const id0 = input.id !== undefined && input.id !== null ? String(input.id) : undefined;
    if (id0 !== undefined && targeted.has(id0))
      throw invalid("TARGET_DUPLICATE", `${id0} is already the target of an earlier op; merge the fields into one op`);
    const existing = id0 !== undefined ? (wps.get(id0) ?? null) : null;
    const foreign = id0 !== undefined && !existing ? foreignWp.get(id0) : undefined;
    if (existing?.deleted_at || foreign?.deleted_at) throw new NotFoundError(`workpackage ${id0} is in the trash; restore it first`);
    if (foreign) throw new ValidationError(`workpackage ${foreign.id} belongs to project ${foreign.project_id}`);
    const ts = now();

    if (existing) {
      if (expectedVersion !== undefined && expectedVersion !== existing.version) throw new ConflictError("version conflict", existing);
      applyWpRules(existing, fields);
      applyVerificationRules(existing, fields, by);
      applyActualDates(existing, fields);
      const gateGuard = startGuardPlan(existing, fields);
      if (closed && fields.status !== undefined && fields.status !== existing.status && isOpenWpStatus(String(fields.status)))
        throw projectClosedError(projectId, project!.status);
      if ("parent_id" in fields) checkParent(existing.id, fields.parent_id);
      const next = { ...existing, ...fields } as Obj;
      const diff: Diff = diffFields(existing as unknown as Obj, next, WRITE_COLS);
      const changed = Object.keys(diff);
      let stakeStmts: D1PreparedStatement[] = [];
      if (stakeholders && JSON.stringify(existing.stake) !== JSON.stringify(stakeholders)) {
        diff.priority_stakeholders = [existing.stake, stakeholders];
        stakeStmts = stakeholderStmts(db, existing.id, existing.version, stakeholders);
      }
      targeted.add(existing.id);
      if (key) opKeys.set(key, [...new Set([...(opKeys.get(key) ?? []), existing.id])]);
      const base: Plan = {
        index: i, kind: "wp", key, ref, args: opArgs, id: existing.id, create: false, storedVersion: existing.version, changed: false,
        stmts: [], gateIds: [], removalGuard: false, reopensOrCreates: false, dependsChanged: false, line: {},
      };
      if (!Object.keys(diff).length) return { ...base, line: ackLine(existing as unknown as Obj, opArgs, existing as unknown as Obj) };
      if ("depends_on" in diff) checkDepsExist(existing.id, snapWp(next as unknown as WorkpackageRow).depends_on);
      const progressWrite = changed.includes("status") || changed.includes("progress");
      const act = activitySet(by, ts, progressWrite);
      const projectAct = projectActivityStmt(db, by, projectId, ts, progressWrite);
      const agentVerify = isAgent(by) && "verification" in diff ? ` AND verification IN ${verificationNotAboveSql(next.verification)}` : "";
      const reopening = changed.includes("status") && isOpenWpStatus(String(next.status));
      const projectGuard = reopening ? `project_id = CASE WHEN ${PROJECT_OPEN_SQL} THEN project_id ELSE NULL END, ` : "";
      const stmts = [
        ...gateGuard.stmts,
        ...stakeStmts,
        db
          .prepare(
            `UPDATE workpackage SET ${projectGuard}${changed.map((f) => `${f} = ?, `).join("")}version = version + 1, updated_at = ?${act.sql} WHERE id = ? AND version = ?${agentVerify}`,
          )
          .bind(...(reopening ? [projectId] : []), ...changed.map((f) => next[f] ?? null), ts, ...act.params, existing.id, existing.version),
        eventStmt(db, {
          by,
          project_id: projectId,
          entity: "workpackage",
          entity_id: existing.id,
          action: "update",
          summary: `${String(next.title)}: ${Object.keys(diff).join(", ")}`,
          diff,
        }),
        ...(projectAct ? [projectAct] : []),
        ...reachStmts(db, projectId, by),
      ];
      const after: Wp = {
        ...(next as unknown as Wp),
        version: existing.version + 1,
        updated_at: ts,
        ...(isSystem(by) ? {} : { last_changed_at: ts, ...(progressWrite ? { last_progress_at: ts } : {}) }),
        stake: stakeholders ?? existing.stake,
      };
      wps.set(existing.id, after);
      return {
        ...base, changed: true, stmts, gateIds: gateGuard.ids, reopensOrCreates: reopening, dependsChanged: "depends_on" in diff,
        line: ackLine(after as unknown as Obj, opArgs, existing as unknown as Obj),
      };
    }

    if (closed) throw projectClosedError(projectId, project!.status);
    const title = String(fields.title ?? "");
    if (!title) throw new ValidationError("title is required");
    if (id0 !== undefined && !ID_RE.test(id0)) throw new ValidationError("id must match ^[a-z0-9][a-z0-9-]{0,62}$");
    checkParent(null, fields.parent_id);
    applyWpRules(null, fields);
    applyVerificationRules(null, fields, by);
    applyActualDates(null, fields);
    const gateGuard = startGuardPlan(null, fields);
    const base = id0 ?? `${projectId}-${slugify(title)}`.slice(0, 63).replace(/-+$/, "");
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    const row = {
      id, project_id: projectId, parent_id: null, title, description_md: null, status: "todo", blocked_by: null, progress: 0, weight: 1,
      effort_planned_pd: null, effort_actual_pd: null, start_date: null, end_date: null, actual_start: null, actual_end: null, code: null,
      depends_on: null, sort: 0, category: null, human: null, owner_person_id: null, owner_text: null, drop_reason: null,
      blocked_since: null, waiting_reason: null, deliverable: null, acceptance_criteria_md: null, verification: "none", verified_by: null,
      verified_at: null,
      ...(fields as Partial<WorkpackageRow>),
      version: 1, created_at: ts, updated_at: ts,
      last_progress_at: isSystem(by) ? null : ts, last_changed_at: isSystem(by) ? null : ts,
    } as WorkpackageRow;
    if (fields.depends_on !== undefined) checkDepsExist(id, snapWp(row).depends_on);
    const projectAct = projectActivityStmt(db, by, projectId, ts, false);
    const cols = ["id", "project_id", ...WRITE_COLS, "version", "created_at", "updated_at", "last_progress_at", "last_changed_at"] as const;
    const values = cols.map((c) => (c === "project_id" ? `CASE WHEN ${PROJECT_OPEN_SQL} THEN ? ELSE NULL END` : "?"));
    const params = cols.flatMap((c) => (c === "project_id" ? [projectId, projectId] : [(row as unknown as Obj)[c] ?? null]));
    const stmts = [
      ...gateGuard.stmts,
      db.prepare(`INSERT INTO workpackage (${cols.join(", ")}) VALUES (${values.join(", ")})`).bind(...params),
      eventStmt(db, {
        by,
        project_id: projectId,
        entity: "workpackage",
        entity_id: id,
        action: "create",
        summary: title,
        diff: {
          ...diffFields(null, row as unknown as Obj, WRITE_COLS),
          ...(stakeholders?.length ? { priority_stakeholders: [null, stakeholders] } : {}),
        },
      }),
      ...(stakeholders?.length ? stakeholderStmts(db, id, 1, stakeholders) : []),
      ...(projectAct ? [projectAct] : []),
      ...reachStmts(db, projectId, by),
    ];
    wps.set(id, { ...row, stake: stakeholders ?? [] });
    taken.add(id);
    targeted.add(id);
    createdBy.set(id, i);
    if (key) opKeys.set(key, [...new Set([...(opKeys.get(key) ?? []), id])]);
    return {
      index: i, kind: "wp", key, ref, args: opArgs, id, create: true, changed: true, stmts, gateIds: gateGuard.ids, removalGuard: false,
      reopensOrCreates: true, dependsChanged: fields.depends_on !== undefined, line: ackLine(row as unknown as Obj, opArgs),
    };
  }

  function planMs(i: number, key: string | undefined, ref: string | undefined, input: Obj, opArgs: Obj, expectedVersion?: number): Plan {
    const fields: Obj = normaliseMs(input);
    const requires = idList(input.requires, "requires");
    const unlocks = idList(input.unlocks, "unlocks");
    const named = [...(requires ?? []), ...(unlocks ?? []), ...(typeof fields.workpackage_id === "string" ? [fields.workpackage_id] : [])];
    const bad = named.filter((id) => !liveWp(id));
    if (bad.length) throw new ValidationError(`not workpackages of project ${projectId}: ${bad.join(", ")}`);
    const id0 = input.id !== undefined && input.id !== null ? String(input.id) : undefined;
    if (id0 !== undefined && targeted.has(id0))
      throw invalid("TARGET_DUPLICATE", `${id0} is already the target of an earlier op; merge the fields into one op`);
    const existing = id0 !== undefined ? (mss.get(id0) ?? null) : null;
    const foreign = id0 !== undefined && !existing ? foreignMs.get(id0) : undefined;
    if (existing?.deleted_at || foreign?.deleted_at) throw new NotFoundError(`milestone ${id0} is in the trash; restore it first`);
    if (foreign) throw new ValidationError(`milestone ${foreign.id} belongs to project ${foreign.project_id}`);
    const ts = now();
    const linkStmts = (id: string, version: number | null): D1PreparedStatement[] => {
      const g = version !== null ? " AND EXISTS (SELECT 1 FROM milestone WHERE id = ? AND version = ?)" : "";
      const where = version !== null ? " WHERE EXISTS (SELECT 1 FROM milestone WHERE id = ? AND version = ?)" : "";
      const gp = version !== null ? [id, version] : [];
      const out: D1PreparedStatement[] = [];
      for (const [role, list] of [["requires", requires], ["unlocks", unlocks]] as const) {
        if (list === undefined) continue;
        out.push(db.prepare(`DELETE FROM milestone_link WHERE milestone_id = ? AND role = ?${g}`).bind(id, role, ...gp));
        for (const wp of list) out.push(db.prepare(`INSERT INTO milestone_link (milestone_id, workpackage_id, role) SELECT ?, ?, ?${where}`).bind(id, wp, role, ...gp));
      }
      return out;
    };
    const projectAct = projectActivityStmt(db, by, projectId, ts, false);

    if (existing) {
      if (expectedVersion !== undefined && expectedVersion !== existing.version) throw new ConflictError("version conflict", msOut(existing));
      const agentRemoval = isAgent(by) && (fields.gate === 0 || (unlocks !== undefined && existing.unlocks.some((id) => !unlocks.includes(id))));
      const removalGuard = agentRemoval && enforced;
      if (removalGuard && existing.gate === 1 && (!existing.reached || !(OPENING_DECISIONS as readonly string[]).includes(existing.latest ?? "")))
        throw agentGateRemovalError(existing.title);
      const next = { ...existing, ...fields } as Obj;
      const diff: Diff = diffFields(existing as unknown as Obj, next, MS_FIELDS);
      const same = (a: string[] | undefined, b: string[]) => a === undefined || [...a].sort().join() === [...b].sort().join();
      if (!same(requires, existing.requires)) diff.requires = [existing.requires, requires];
      if (!same(unlocks, existing.unlocks)) diff.unlocks = [existing.unlocks, unlocks];
      const changed = Object.keys(diff).filter((k) => (MS_FIELDS as readonly string[]).includes(k));
      targeted.add(existing.id);
      const base: Plan = {
        index: i, kind: "ms", key, ref, args: opArgs, id: existing.id, create: false, storedVersion: existing.version, changed: false,
        stmts: [], gateIds: [], removalGuard: false, reopensOrCreates: false, dependsChanged: false, line: { id: existing.id, version: existing.version },
      };
      if (!Object.keys(diff).length) return base;
      const stmts = [
        ...(removalGuard ? [db.prepare(`UPDATE milestone SET title = NULL WHERE id = ? AND ${gateClosedSql("milestone")}`).bind(existing.id)] : []),
        db
          .prepare(`UPDATE milestone SET ${changed.map((f) => `${f} = ?, `).join("")}version = version + 1, updated_at = ? WHERE id = ? AND version = ?`)
          .bind(...changed.map((f) => next[f] ?? null), ts, existing.id, existing.version),
        ...linkStmts(existing.id, existing.version + 1),
        eventStmt(db, {
          by,
          project_id: projectId,
          entity: "milestone",
          entity_id: existing.id,
          action: "update",
          summary: `${String(next.title)}: ${Object.keys(diff).join(", ")}`,
          diff,
        }),
        ...(projectAct ? [projectAct] : []),
        ...reachStmts(db, projectId, by),
      ];
      mss.set(existing.id, {
        ...(next as unknown as Ms),
        version: existing.version + 1,
        updated_at: ts,
        requires: requires ?? existing.requires,
        unlocks: unlocks ?? existing.unlocks,
      });
      return { ...base, changed: true, stmts, removalGuard, line: { id: existing.id, version: existing.version + 1 } };
    }

    const title = String(fields.title ?? "");
    if (!title) throw new ValidationError("title is required");
    const row = {
      id: id0 ?? newId(), project_id: projectId, workpackage_id: null, title, description_md: null, due_date: null, reached_at: null, sort: 0,
      gate: 0, ...(fields as Partial<MilestoneRow>), version: 1, created_at: ts, updated_at: ts,
    } as MilestoneRow;
    const cols = ["id", "project_id", ...MS_FIELDS, "version", "created_at", "updated_at"] as const;
    const stmts = [
      db
        .prepare(`INSERT INTO milestone (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
        .bind(...cols.map((c) => (row as unknown as Obj)[c] ?? null)),
      ...linkStmts(row.id, null),
      eventStmt(db, {
        by,
        project_id: projectId,
        entity: "milestone",
        entity_id: row.id,
        action: "create",
        summary: title,
        diff: { ...diffFields(null, row as unknown as Obj, MS_FIELDS), requires: [null, requires ?? []], unlocks: [null, unlocks ?? []] },
      }),
      ...(projectAct ? [projectAct] : []),
      ...reachStmts(db, projectId, by),
    ];
    mss.set(row.id, { ...row, requires: requires ?? [], unlocks: unlocks ?? [], latest: null, reached: false });
    targeted.add(row.id);
    createdBy.set(row.id, i);
    return {
      index: i, kind: "ms", key, ref, args: opArgs, id: row.id, create: true, changed: true, stmts, gateIds: [], removalGuard: false,
      reopensOrCreates: false, dependsChanged: false, line: { id: row.id, version: 1 },
    };
  }

  afterPlan?.(locks().by);

  // ---- Cycles over the final plan (depends_on), named by the first op on the cycle.
  const finalSnap = { wps: [...wps.values()].filter((w) => !w.deleted_at).map(snapWp), milestones: [] };
  for (const p of plans) {
    if (!p.dependsChanged) continue;
    const cycle = dependsOnCycle(finalSnap, p.id);
    if (cycle) throw toOpError(new ValidationError(`depends_on: creates a dependency cycle: ${cycle.join(" -> ")}`), p.index, p.key, p.args);
  }

  // ---- Phase A, step 5: schedule, once over the final plan.
  const written = plans.filter((p) => p.changed);
  const firstOp = new Map<string, number>();
  for (const p of plans) if (!firstOp.has(p.id)) firstOp.set(p.id, p.index);
  const tag = (s: ScheduleIssue): ScheduleIssue & { op: number | null } => ({
    op: firstOp.get(s.entity_id) ?? (s.related_id ? firstOp.get(s.related_id) : undefined) ?? null,
    ...s,
  });
  let schedule: { stmts: D1PreparedStatement[]; issues: ScheduleIssue[] };
  try {
    const wpIds = [...new Set(written.filter((p) => p.kind === "wp").map((p) => p.id))];
    const msIds = [...new Set(written.filter((p) => p.kind === "ms").map((p) => p.id))];
    schedule = await recomputeScheduleStmts(
      db,
      projectId,
      written.length
        ? {
            wps: wpIds.map((id) => snapWp(wps.get(id)!)),
            milestones: msIds.map((id) => {
              const m = mss.get(id)!;
              return snapMs({ id, due_date: m.due_date ?? null, requires: m.requires, unlocks: m.unlocks });
            }),
          }
        : undefined,
    );
  } catch (e) {
    const cur = (e as Coded).current as { code?: string; issues?: ScheduleIssue[] } | undefined;
    if (cur?.code === "SCHEDULE_STRICT" && Array.isArray(cur.issues)) {
      const issues = cur.issues.map(tag);
      const idx = issues.map((x) => x.op).filter((x): x is number => x !== null);
      const at = idx.length ? Math.min(...idx) : null;
      const p = at === null ? undefined : plans.find((x) => x.index === at);
      (e as Coded).current = { ...cur, issues };
      throw toOpError(e, at, p?.key);
    }
    throw toOpError(e, null);
  }
  if (!written.length) schedule.stmts = [];

  // ---- Phase B: one batch.
  const versionGuards = written
    .filter((p) => !p.create)
    .map((p) =>
      db
        .prepare(`UPDATE ${p.kind === "wp" ? "workpackage" : "milestone"} SET version = NULL WHERE id = ? AND (version != ? OR deleted_at IS NOT NULL)`)
        .bind(p.id, p.storedVersion),
    );
  const stmts = [...versionGuards, ...written.flatMap((p) => p.stmts), ...schedule.stmts];
  if (stmts.length > MAX_STMTS)
    throw toOpError(new TooLargeError(`the call builds ${stmts.length} statements, more than ${MAX_STMTS}: split the call`), null);
  if (written.length) {
    try {
      await db.batch(stmts);
    } catch (e) {
      throw await mapBatchError(db, projectId, e, written, by);
    }
  }

  // ---- Result.
  const touched = new Set(plans.map((p) => p.id));
  const seen = new Set<string>();
  const warnings: Array<ScheduleIssue & { op: number | null }> = [];
  for (const s of schedule.issues) {
    if (!touched.has(s.entity_id) && !(s.related_id && touched.has(s.related_id))) continue;
    const k = `${s.code}|${s.entity}|${s.entity_id}|${s.related_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    warnings.push(tag(s));
  }
  return {
    ops: plans.map((p) => ({ ...(p.ref !== undefined ? { ref: p.ref } : {}), ...p.line })),
    ...(warnings.length ? { warnings: warnings.slice(0, MAX_WARNINGS) } : {}),
    ...(warnings.length > MAX_WARNINGS ? { warnings_more: warnings.length - MAX_WARNINGS } : {}),
  };
}

/** A milestone as a conflict's `current` (row plus its lists). */
const msOut = (m: Ms): Obj => {
  const { latest: _l, reached: _r, ...rest } = m;
  return rest;
};

const RE = {
  version: /NOT NULL constraint failed: (workpackage|milestone)\.version/i,
  gate: /NOT NULL constraint failed: workpackage\.status/i,
  project: /NOT NULL constraint failed: workpackage\.project_id/i,
  removal: /NOT NULL constraint failed: milestone\.title/i,
  rev: /NOT NULL constraint failed: project\.schedule_rev/i,
  unique: /(UNIQUE|PRIMARY KEY) constraint failed: (workpackage|milestone)\.id/i,
};

/** Phase C: which guard fired, and which op it names. Nothing was committed, so these reads are a fresh view. */
async function mapBatchError(db: D1Database, projectId: string, e: unknown, plans: Plan[], by: Caller): Promise<unknown> {
  const msg = String((e as Error)?.message ?? e);
  const at = (p: Plan | undefined, err: unknown) => toOpError(err, p ? p.index : null, p?.key, p?.args);
  if (RE.version.test(msg)) {
    for (const p of plans.filter((x) => !x.create)) {
      const row = await db.prepare(`SELECT * FROM ${p.kind === "wp" ? "workpackage" : "milestone"} WHERE id = ?`).bind(p.id).first<Obj>();
      if (!row || row.deleted_at || row.version !== p.storedVersion) return at(p, new ConflictError("version conflict", row));
    }
    return at(undefined, new ConflictError("version conflict", null));
  }
  if (RE.gate.test(msg)) {
    for (const p of plans)
      for (const id of p.gateIds) {
        const gates = await lockingGates(db, id);
        if (gates.length) return at(p, gateLockedError(id, gates, by));
      }
    return at(undefined, Object.assign(gateLockedError("?", [], by), { message: "a gate changed during the call; reload and try again" }));
  }
  if (RE.project.test(msg)) {
    const p = await db.prepare("SELECT status, deleted_at FROM project WHERE id = ?").bind(projectId).first<{ status: string; deleted_at: string | null }>();
    const first = plans.find((x) => x.reopensOrCreates);
    return at(first, !p || p.deleted_at ? new NotFoundError(`project ${projectId} not found`) : projectClosedError(projectId, p.status));
  }
  if (RE.removal.test(msg)) {
    const p = plans.find((x) => x.removalGuard);
    const row = p ? await db.prepare("SELECT title FROM milestone WHERE id = ?").bind(p.id).first<{ title: string }>() : null;
    return at(p, agentGateRemovalError(row?.title ?? p?.id ?? "?"));
  }
  if (RE.rev.test(msg)) return at(undefined, scheduleConflictError());
  if (RE.unique.test(msg)) {
    for (const p of plans.filter((x) => x.create)) {
      const hit = await db.prepare(`SELECT 1 FROM ${p.kind === "wp" ? "workpackage" : "milestone"} WHERE id = ?`).bind(p.id).first();
      if (hit) return at(p, new ConflictError(`id ${p.id} taken meanwhile; reload and try again`, null));
    }
    return at(undefined, new ConflictError("an id was taken meanwhile; reload and try again", null));
  }
  return e;
}
