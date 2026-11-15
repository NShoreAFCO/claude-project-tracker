/** Result compaction for MCP replies (REST output is never touched). */

const isEmpty = (v: unknown): boolean =>
  v === null || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

/**
 * Drops object keys whose value is null, "", [] or {} (judged after compaction), and schedule_issues when it is "[]".
 * false, 0 and "0" are kept. Array elements and their order are kept; object elements are compacted. Strings are unchanged.
 */
export function compactResult<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => compactResult(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "schedule_issues" && v === "[]") continue;
      const c = compactResult(v);
      if (isEmpty(c)) continue;
      out[k] = c;
    }
    return out as T;
  }
  return value;
}

/** Removes depends_ids where it only repeats the sibling depends_on (same list, parsed). Keeps it when they differ. */
export function dropDuplicateDependsIds<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => dropDuplicateDependsIds(v)) as unknown as T;
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    let dup = false;
    if (Array.isArray(src.depends_ids) && typeof src.depends_on === "string") {
      try {
        dup = JSON.stringify(JSON.parse(src.depends_on)) === JSON.stringify(src.depends_ids);
      } catch {
        dup = false;
      }
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (k === "depends_ids" && dup) continue;
      out[k] = dropDuplicateDependsIds(v);
    }
    return out as T;
  }
  return value;
}
