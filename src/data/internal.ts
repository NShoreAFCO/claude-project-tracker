/**
 * Spec F12: a project's `local_path`, `session_id` and `repo_url` are internal. Editors and above (agents
 * included: MCP and service callers act as editor or above) see them; viewers get reads without them.
 * Applied at the read layer (project list and detail, event history, inbox), for REST and MCP alike.
 * Reports and context bundles never contain them.
 */
import type { Caller, EventOut } from "../types";
import { hasRole } from "../auth/permissions";

export const INTERNAL_FIELDS = ["local_path", "session_id", "repo_url"] as const;
/** Keys dropped from nested event payloads (the hook event records the session's working directory). */
const INTERNAL_NESTED = new Set<string>([...INTERNAL_FIELDS, "cwd"]);

/** Whether `by` may see internal fields. No caller = an internal read (reports, tests), which sees all. */
export const seesInternal = (by?: Caller): boolean => !by || hasRole(by, "editor");

/** The object without its internal fields when `by` may not see them. */
export function omitInternal<T extends object>(obj: T, by?: Caller): T {
  if (seesInternal(by)) return obj;
  const out = { ...obj } as Record<string, unknown>;
  for (const f of INTERNAL_FIELDS) delete out[f];
  return out as T;
}

function scrub(v: unknown, values: Set<string>, depth: number): unknown {
  if (Array.isArray(v)) return v.map((x) => scrub(x, values, depth));
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (depth === 0 ? (INTERNAL_FIELDS as readonly string[]).includes(k) : INTERNAL_NESTED.has(k)) {
      collect(x, values);
      continue;
    }
    out[k] = scrub(x, values, depth + 1);
  }
  return out;
}

function collect(v: unknown, values: Set<string>): void {
  if (typeof v === "string" && v) values.add(v);
  else if (Array.isArray(v)) for (const x of v) collect(x, values);
}

/**
 * Events for `by`: for viewers, internal keys are removed from the diff (top level, and from nested
 * payloads such as the hook record), and their values are masked in the summary.
 */
export function redactEvents<T extends EventOut>(events: T[], by?: Caller): T[] {
  if (seesInternal(by)) return events;
  return events.map((e) => {
    if (!e.diff_json) return e;
    let diff: unknown;
    try {
      diff = JSON.parse(e.diff_json);
    } catch {
      return { ...e, diff_json: null };
    }
    const values = new Set<string>();
    const clean = scrub(diff, values, 0);
    let summary = e.summary;
    for (const v of values) if (summary) summary = summary.split(v).join("…");
    const entity_id = e.entity_id && values.has(e.entity_id) ? null : e.entity_id;
    return { ...e, diff_json: JSON.stringify(clean), summary, entity_id };
  });
}
