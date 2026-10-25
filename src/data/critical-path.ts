/**
 * Critical path (spec F4), pure. Nodes are WPs and milestones; edges run predecessor → WP for each
 * depends_on entry, required WP → milestone and milestone → unlocked WP. A WP lasts end − start in
 * calendar days (0 without both dates, never negative); a milestone lasts 0.
 */
import type { ScheduleSnapshot } from "./schedule";

const DAY_MS = 86_400_000;

/** Whole calendar days from `from` to `to` (YYYY-MM-DD), parsed as UTC dates. */
export function daysBetween(from: string, to: string): number {
  const utc = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((utc(to) - utc(from)) / DAY_MS);
}

/**
 * Ids on the longest path by duration; on a tie, the ids of every tied path. Ids that are not in the
 * snapshot and self references are ignored. A cycle anywhere in the graph, or a longest path of zero
 * days (no dated work), gives an empty set.
 */
export function criticalPath(s: ScheduleSnapshot): Set<string> {
  const wpById = new Map(s.wps.map((wp) => [wp.id, wp] as const));
  const ids = new Set<string>([...wpById.keys(), ...s.milestones.map((m) => m.id)]);
  const successors = new Map<string, Set<string>>();
  const predecessors = new Map<string, Set<string>>();
  for (const id of ids) {
    successors.set(id, new Set());
    predecessors.set(id, new Set());
  }
  const addEdge = (from: string, to: string): void => {
    if (from === to || !ids.has(from) || !ids.has(to)) return;
    successors.get(from)!.add(to);
    predecessors.get(to)!.add(from);
  };
  for (const wp of s.wps) for (const dep of wp.depends_on) addEdge(dep, wp.id);
  for (const m of s.milestones) {
    for (const r of m.requires) if (wpById.has(r)) addEdge(r, m.id);
    for (const u of m.unlocks) if (wpById.has(u)) addEdge(m.id, u);
  }

  // Kahn's algorithm: topological order, and a cycle leaves nodes out.
  const indegree = new Map<string, number>();
  const order: string[] = [];
  for (const id of ids) {
    indegree.set(id, predecessors.get(id)!.size);
    if (predecessors.get(id)!.size === 0) order.push(id);
  }
  for (let i = 0; i < order.length; i++)
    for (const next of successors.get(order[i])!) {
      const d = indegree.get(next)! - 1;
      indegree.set(next, d);
      if (d === 0) order.push(next);
    }
  if (order.length !== ids.size) return new Set();

  const duration = (id: string): number => {
    const wp = wpById.get(id);
    return wp?.start_date && wp.end_date ? Math.max(0, daysBetween(wp.start_date, wp.end_date)) : 0;
  };
  // best: the longest duration of a path ending at the node; tied: every predecessor reaching it.
  const best = new Map<string, number>();
  const tied = new Map<string, string[]>();
  for (const id of order) {
    let top = 0;
    let preds: string[] = [];
    for (const p of predecessors.get(id)!) {
      const v = best.get(p)!;
      if (preds.length === 0 || v > top) {
        top = v;
        preds = [p];
      } else if (v === top) preds.push(p);
    }
    best.set(id, top + duration(id));
    tied.set(id, preds);
  }
  const longest = Math.max(0, ...best.values());
  if (longest <= 0) return new Set();

  const result = new Set<string>();
  const stack = order.filter((id) => best.get(id) === longest);
  while (stack.length) {
    const id = stack.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    stack.push(...tied.get(id)!);
  }
  return result;
}
