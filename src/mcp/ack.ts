/** Compact write acknowledgements and slim 409 replies for MCP (REST output is never touched). */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Fields the server may set on its own; echoed only when the caller did not send them. */
const SERVER_SET = ["actual_start", "actual_end", "verified_by", "verified_at"] as const;

/** Keys that locate a row or guard a write; they are not part of a patch. */
const LOCATORS = new Set(["id", "project_id", "wp_code", "expected_version", "return"]);

/** The keys the caller sent: the top-level args plus an update_project style `patch`. */
function sentKeys(args: unknown): Set<string> {
  const a = isObj(args) ? args : {};
  return new Set([...Object.keys(a), ...(isObj(a.patch) ? Object.keys(a.patch) : [])]);
}

/**
 * Acknowledgement of a write: `{id, code?, version, status?, progress?}`, `warnings` only when non-empty, and the
 * server-set fields (actual_start, actual_end, verified_by, verified_at) that are in the result but not in the args.
 * A progress log with a work package acknowledges that work package plus `event_id`; one without returns `{event_id}`.
 * A list result (set_scores) becomes `{count}`.
 */
export function ack(result: unknown, args: unknown): unknown {
  if (Array.isArray(result)) return { count: result.length };
  if (!isObj(result)) return result;
  let row: Obj = result;
  const out: Obj = {};
  if (isObj(result.workpackage)) row = result.workpackage;
  else if (!("id" in result) && "event_id" in result) return withExtras({ event_id: result.event_id }, result);
  const sent = sentKeys(args);
  for (const k of ["id", "code", "version", "status", "progress"]) if (row[k] !== undefined && row[k] !== null) out[k] = row[k];
  if (Array.isArray(row.warnings) && row.warnings.length) out.warnings = row.warnings;
  for (const k of SERVER_SET) if (!sent.has(k) && row[k] !== undefined && row[k] !== null && row[k] !== "") out[k] = row[k];
  if (row !== result && result.event_id !== undefined) out.event_id = result.event_id;
  return row !== result ? withExtras(out, result) : out;
}

/**
 * One result line of apply_changes: `{id, code?, version}`, plus `status` / `progress` when they differ from what the
 * op sent (or, when it sent none, from the stored row on update, the default todo/0 on create), and the server-set
 * fields the op did not send that the write changed.
 */
export function ackLine(row: Obj, opArgs: Obj, before?: Obj): Obj {
  const out: Obj = { id: row.id };
  if (row.code !== undefined && row.code !== null && row.code !== "") out.code = row.code;
  out.version = row.version;
  const base: Obj = before ?? { status: "todo", progress: 0 };
  for (const k of ["status", "progress"]) {
    const ref = k in opArgs ? opArgs[k] : base[k];
    if (row[k] !== undefined && row[k] !== null && row[k] !== ref) out[k] = row[k];
  }
  for (const k of SERVER_SET)
    if (!(k in opArgs) && row[k] !== undefined && row[k] !== null && row[k] !== "" && row[k] !== (before?.[k] ?? null)) out[k] = row[k];
  return out;
}

/** A progress log's extra writes (handover, token_cost) and its own warnings, next to the work package's. */
function withExtras(out: Obj, result: Obj): Obj {
  for (const k of ["handover", "token_cost"]) if (isObj(result[k])) out[k] = result[k];
  if (Array.isArray(result.warnings) && result.warnings.length)
    out.warnings = [...(Array.isArray(out.warnings) ? out.warnings : []), ...result.warnings];
  return out;
}

/**
 * Slim `current` of a version conflict: its version and the fields the call tried to change. Anything that is not a
 * row (a GATE_LOCKED or WP_DONE code object, null) stays as it is.
 */
export function slimConflict(current: unknown, args: unknown): unknown {
  if (!isObj(current) || typeof current.version !== "number") return current;
  const out: Obj = { version: current.version };
  for (const k of sentKeys(args)) if (!LOCATORS.has(k) && k in current) out[k] = current[k];
  return out;
}
