import type { Caller, MilestoneRow, PersonOut } from "../types";
import {
  ConflictError,
  LIVE,
  NotFoundError,
  ValidationError,
  diffFields,
  eventStmt,
  eventStmtIfChanged,
  newId,
  now,
  parseJsonArray,
} from "./util";
import { issuesOf, recomputeScheduleStmts, scheduleBatch, storeSchedule, type ScheduleIssue } from "./schedule";
import { OPENING_DECISIONS, agentGateRemovalError, gateClosedSql, gatesEnforced, type Decision } from "./gates";
import { initials } from "./persons";
import { isAgent } from "../auth/caller";

/** A recorded gate decision as returned to clients (history, oldest first). */
export type DecisionOut = {
  id: string;
  decision: Decision;
  decided_by: PersonOut;
  decided_at: string;
  note_md: string | null;
  evidence: string[];
  conditions: Array<{ title: string; workpackage_id: string }>;
  on_behalf: boolean;
  baseline_id: string | null;
};
/** none = no gate, or a gate neither reached nor decided; pending = reached gate without a decision; else the latest decision. */
export type DecisionState = "none" | "pending" | Decision;
export type MilestoneOut = Omit<MilestoneRow, "gate"> & {
  requires: string[];
  unlocks: string[];
  done: boolean;
  gate: boolean;
  decision_state: DecisionState;
  decisions: DecisionOut[];
};
/** Write result: the milestone plus the schedule issues that concern it (spec F4). */
export type MilestoneWriteOut = MilestoneOut & { warnings: ScheduleIssue[] };
export type MilestoneInput = {
  id?: string;
  title?: unknown;
  description_md?: unknown;
  due_date?: unknown;
  workpackage_id?: unknown;
  sort?: unknown;
  requires?: unknown;
  unlocks?: unknown;
  gate?: unknown;
};

const MS_FIELDS = ["title", "description_md", "due_date", "workpackage_id", "sort", "gate"] as const;
type MsField = (typeof MS_FIELDS)[number];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A milestone qualifies (is done) when it has at least one non-dropped `requires` WP and every
 * `requires` WP is done or dropped. WPs in the trash do not count. `m` is the milestone alias.
 */
export const QUALIFIES = `EXISTS (SELECT 1 FROM milestone_link l JOIN workpackage w ON w.id = l.workpackage_id
    WHERE l.milestone_id = m.id AND l.role = 'requires' AND w.deleted_at IS NULL AND w.status != 'dropped')
  AND NOT EXISTS (SELECT 1 FROM milestone_link l JOIN workpackage w ON w.id = l.workpackage_id
    WHERE l.milestone_id = m.id AND l.role = 'requires' AND w.deleted_at IS NULL AND w.status NOT IN ('done', 'dropped'))`;

/**
 * Statements to append at the end of any batch that writes work packages or milestones of a project:
 * one `milestone/reached` event per newly qualifying milestone, then `reached_at` (set once, never cleared).
 */
export function reachStmts(db: D1Database, projectId: string, by: Caller): D1PreparedStatement[] {
  const ts = now();
  return [
    db
      .prepare(
        `INSERT INTO event (ts, actor, person_id, project_id, entity, entity_id, action, summary, diff_json)
         SELECT ?, ?, ?, m.project_id, 'milestone', m.id, 'reached', m.title, NULL FROM milestone m
         WHERE m.project_id = ? AND m.reached_at IS NULL AND ${LIVE("m")} AND ${QUALIFIES}`,
      )
      .bind(ts, by.actor, by.personId, projectId),
    db
      .prepare(`UPDATE milestone AS m SET reached_at = ? WHERE m.project_id = ? AND m.reached_at IS NULL AND ${LIVE("m")} AND ${QUALIFIES}`)
      .bind(ts, projectId),
  ];
}

type DecisionRow = {
  id: string;
  milestone_id: string;
  decision: Decision;
  decided_by: string;
  decided_at: string;
  decision_note_md: string | null;
  evidence: string | null;
  conditions: string | null;
  on_behalf: number;
  baseline_id: string | null;
  person_name: string | null;
  person_display_name: string | null;
};

function decisionOut(d: DecisionRow): DecisionOut {
  // Persons in the trash keep their name here: the decision history needs it.
  const name = d.person_name ?? d.decided_by;
  let conditions: DecisionOut["conditions"] = [];
  try {
    const c = d.conditions ? JSON.parse(d.conditions) : [];
    if (Array.isArray(c)) conditions = c;
  } catch {
    /* unreadable conditions stay empty */
  }
  return {
    id: d.id,
    decision: d.decision,
    decided_by: { person_id: d.decided_by, name, initials: initials({ name, display_name: d.person_display_name }) },
    decided_at: d.decided_at,
    note_md: d.decision_note_md,
    evidence: parseJsonArray(d.evidence),
    conditions,
    on_behalf: d.on_behalf === 1,
    baseline_id: d.baseline_id,
  };
}

export async function listMilestones(db: D1Database, projectId: string): Promise<MilestoneOut[]> {
  const [ms, links, decisions] = await db.batch([
    db
      .prepare(
        `SELECT m.*, (${QUALIFIES}) AS done FROM milestone m WHERE m.project_id = ? AND ${LIVE("m")} ORDER BY m.due_date IS NULL, m.due_date, m.sort, m.title`,
      )
      .bind(projectId),
    db
      .prepare(
        `SELECT l.* FROM milestone_link l JOIN milestone m ON m.id = l.milestone_id JOIN workpackage w ON w.id = l.workpackage_id
         WHERE m.project_id = ? AND ${LIVE("m")} AND ${LIVE("w")} ORDER BY l.workpackage_id`,
      )
      .bind(projectId),
    db
      .prepare(
        `SELECT d.id, d.milestone_id, d.decision, d.decided_by, d.decided_at, d.decision_note_md, d.evidence, d.conditions, d.on_behalf,
           d.baseline_id, p.name AS person_name, p.display_name AS person_display_name
         FROM decision d LEFT JOIN person p ON p.id = d.decided_by WHERE d.project_id = ? ORDER BY d.decided_at, d.rowid`,
      )
      .bind(projectId),
  ]);
  const by = new Map<string, { requires: string[]; unlocks: string[] }>();
  for (const l of links.results as Array<{ milestone_id: string; workpackage_id: string; role: string }>) {
    const e = by.get(l.milestone_id) ?? { requires: [], unlocks: [] };
    (l.role === "requires" ? e.requires : e.unlocks).push(l.workpackage_id);
    by.set(l.milestone_id, e);
  }
  const hist = new Map<string, DecisionOut[]>();
  for (const d of decisions.results as DecisionRow[]) hist.set(d.milestone_id, [...(hist.get(d.milestone_id) ?? []), decisionOut(d)]);
  return (ms.results as Array<MilestoneRow & { done: number }>).map((m) => {
    const list = hist.get(m.id) ?? [];
    const gate = m.gate === 1;
    const last = list[list.length - 1];
    return {
      ...m,
      done: m.done === 1,
      ...(by.get(m.id) ?? { requires: [], unlocks: [] }),
      gate,
      decision_state: !gate ? "none" : last ? last.decision : m.reached_at ? "pending" : "none",
      decisions: list,
    };
  });
}

/**
 * Display lock from milestones: WPs unlocked by a milestone that has never been reached. Gates are left
 * out while gate decisions are required: their lock is gateLockedWpIds (decision, start state, override).
 */
export function lockedWpIds(ms: MilestoneOut[]): Set<string> {
  const enforced = gatesEnforced();
  return new Set(ms.filter((m) => !m.reached_at && !(m.gate && enforced)).flatMap((m) => m.unlocks));
}

function normalise(input: MilestoneInput): Partial<Record<MsField, unknown>> {
  const out: Partial<Record<MsField, unknown>> = {};
  for (const f of MS_FIELDS) {
    if (!(f in input) || input[f] === undefined) continue;
    let v = input[f];
    if (f === "title") {
      if (typeof v !== "string" || !v.trim()) throw new ValidationError("title is required");
      v = v.trim();
    } else if (f === "sort") {
      if (typeof v !== "number" || !Number.isFinite(v)) throw new ValidationError("sort must be a number");
      v = Math.trunc(v);
    } else if (f === "gate") {
      // spec F5: a gate unlocks on a go decision, not on being reached
      if (typeof v !== "boolean") throw new ValidationError("gate must be true or false");
      v = v ? 1 : 0;
    } else {
      if (v === "") v = null;
      if (v !== null && typeof v !== "string") throw new ValidationError(`${f} must be a string`);
      if (f === "due_date" && v !== null && !DATE_RE.test(String(v))) throw new ValidationError("due_date must be YYYY-MM-DD");
    }
    out[f] = v;
  }
  return out;
}

function idList(v: unknown, name: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ValidationError(`${name} must be an array of workpackage ids`);
  return [...new Set(v as string[])];
}

async function checkWps(db: D1Database, projectId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { results } = await db
    .prepare(`SELECT id FROM workpackage WHERE project_id = ? AND ${LIVE()}`)
    .bind(projectId)
    .all<{ id: string }>();
  const own = new Set(results.map((r) => r.id));
  const bad = ids.filter((id) => !own.has(id));
  if (bad.length) throw new ValidationError(`not workpackages of project ${projectId}: ${bad.join(", ")}`);
}

async function getOne(db: D1Database, projectId: string, id: string): Promise<MilestoneOut> {
  const m = (await listMilestones(db, projectId)).find((x) => x.id === id);
  if (!m) throw new NotFoundError(`milestone ${id} not found`);
  return m;
}

/** Create, or update when input.id names an existing milestone. `requires` / `unlocks` replace the stored links. */
export async function upsertMilestone(
  db: D1Database,
  projectId: string,
  input: MilestoneInput,
  by: Caller,
  expectedVersion?: number,
): Promise<MilestoneWriteOut> {
  if (!(await db.prepare(`SELECT 1 FROM project WHERE id = ? AND ${LIVE()}`).bind(projectId).first()))
    throw new NotFoundError(`project ${projectId} not found`);
  const fields = normalise(input);
  const requires = idList(input.requires, "requires");
  const unlocks = idList(input.unlocks, "unlocks");
  await checkWps(db, projectId, [
    ...(requires ?? []),
    ...(unlocks ?? []),
    ...(typeof fields.workpackage_id === "string" ? [fields.workpackage_id] : []),
  ]);

  const existing = input.id ? await db.prepare("SELECT * FROM milestone WHERE id = ?").bind(input.id).first<MilestoneRow>() : null;
  if (existing?.deleted_at) throw new NotFoundError(`milestone ${existing.id} is in the trash; restore it first`);
  const ts = now();
  const linkStmts = (id: string, guard: { version: number } | null): D1PreparedStatement[] => {
    // On update the link writes only apply if this batch's versioned UPDATE won (same batch = same transaction).
    const where = guard ? " WHERE EXISTS (SELECT 1 FROM milestone WHERE id = ? AND version = ?)" : "";
    const g = guard ? [id, guard.version] : [];
    const out: D1PreparedStatement[] = [];
    for (const [role, list] of [
      ["requires", requires],
      ["unlocks", unlocks],
    ] as const) {
      if (list === undefined) continue;
      out.push(
        db
          .prepare(
            `DELETE FROM milestone_link WHERE milestone_id = ? AND role = ?${guard ? " AND EXISTS (SELECT 1 FROM milestone WHERE id = ? AND version = ?)" : ""}`,
          )
          .bind(id, role, ...g),
      );
      for (const wp of list)
        out.push(
          db.prepare(`INSERT INTO milestone_link (milestone_id, workpackage_id, role) SELECT ?, ?, ?${where}`).bind(id, wp, role, ...g),
        );
    }
    return out;
  };

  if (existing) {
    if (existing.project_id !== projectId) throw new ValidationError(`milestone ${existing.id} belongs to project ${existing.project_id}`);
    if (typeof expectedVersion === "number" && expectedVersion !== existing.version)
      throw new ConflictError("version conflict", await getOne(db, projectId, existing.id));
    const current = await getOne(db, projectId, existing.id);
    // F5: agents never lift a gate lock, so they may not clear the gate flag or drop unlocked WPs while
    // the gate is undecided. The UPDATE re-checks the gate state (a hold recorded meanwhile → conflict).
    const agentRemoval =
      isAgent(by) && (fields.gate === 0 || (unlocks !== undefined && current.unlocks.some((id) => !unlocks.includes(id))));
    if (agentRemoval && current.gate && gatesEnforced() && !(OPENING_DECISIONS as string[]).includes(current.decision_state))
      throw agentGateRemovalError(existing.title);
    const gateGuard = agentRemoval && gatesEnforced() ? ` AND NOT ${gateClosedSql("milestone")}` : "";
    const next = { ...existing, ...fields } as Record<string, unknown>;
    const diff = diffFields(existing as unknown as Record<string, unknown>, next, MS_FIELDS);
    const same = (a: string[] | undefined, b: string[]) => a === undefined || [...a].sort().join() === [...b].sort().join();
    if (!same(requires, current.requires)) diff.requires = [current.requires, requires];
    if (!same(unlocks, current.unlocks)) diff.unlocks = [current.unlocks, unlocks];
    const changed = Object.keys(diff).filter((k) => (MS_FIELDS as readonly string[]).includes(k));
    if (!Object.keys(diff).length) {
      const { issues } = await recomputeScheduleStmts(db, projectId);
      return { ...current, warnings: issuesOf(issues, current.id) };
    }
    const schedule = await recomputeScheduleStmts(db, projectId, {
      milestones: [
        {
          id: existing.id,
          due_date: (next.due_date as string | null) ?? null,
          requires: requires ?? current.requires,
          unlocks: unlocks ?? current.unlocks,
        },
      ],
    });
    const res = await scheduleBatch(db, [
      db
        .prepare(
          `UPDATE milestone SET ${changed.map((f) => `${f} = ?, `).join("")}version = version + 1, updated_at = ? WHERE id = ? AND version = ?${gateGuard}`,
        )
        .bind(...changed.map((f) => next[f] ?? null), ts, existing.id, existing.version),
      eventStmtIfChanged(db, {
        by,
        project_id: projectId,
        entity: "milestone",
        entity_id: existing.id,
        action: "update",
        summary: `${String(next.title)}: ${Object.keys(diff).join(", ")}`,
        diff,
      }),
      ...linkStmts(existing.id, { version: existing.version + 1 }),
      ...reachStmts(db, projectId, by),
      ...schedule.stmts,
    ]);
    if (!res[0].meta.changes) {
      // The batch stored issues computed for this write; put back the ones of the stored plan.
      await storeSchedule(db, projectId);
      throw new ConflictError("version conflict", await getOne(db, projectId, existing.id));
    }
    return { ...(await getOne(db, projectId, existing.id)), warnings: issuesOf(schedule.issues, existing.id) };
  }

  const title = String(fields.title ?? "");
  if (!title) throw new ValidationError("title is required");
  const row: MilestoneRow = {
    id: input.id ? String(input.id) : newId(),
    project_id: projectId,
    workpackage_id: null,
    title,
    description_md: null,
    due_date: null,
    reached_at: null,
    sort: 0,
    gate: 0,
    ...(fields as Partial<MilestoneRow>),
    version: 1,
    created_at: ts,
    updated_at: ts,
  };
  const schedule = await recomputeScheduleStmts(db, projectId, {
    milestones: [{ id: row.id, due_date: row.due_date, requires: requires ?? [], unlocks: unlocks ?? [] }],
  });
  const cols = ["id", "project_id", ...MS_FIELDS, "version", "created_at", "updated_at"] as const;
  await scheduleBatch(db, [
    db
      .prepare(`INSERT INTO milestone (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .bind(...cols.map((c) => (row as unknown as Record<string, unknown>)[c] ?? null)),
    eventStmt(db, {
      by,
      project_id: projectId,
      entity: "milestone",
      entity_id: row.id,
      action: "create",
      summary: title,
      diff: {
        ...diffFields(null, row as unknown as Record<string, unknown>, MS_FIELDS),
        requires: [null, requires ?? []],
        unlocks: [null, unlocks ?? []],
      },
    }),
    ...linkStmts(row.id, null),
    ...reachStmts(db, projectId, by),
    ...schedule.stmts,
  ]);
  return { ...(await getOne(db, projectId, row.id)), warnings: issuesOf(schedule.issues, row.id) };
}
