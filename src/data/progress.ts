import type { ProjectRow, WorkpackageRow } from "../types";
import { barCategory, effectiveCategories, isHuman } from "./categories";
import { parseJsonArray } from "./util";

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Effective progress (0..100) per work package. Leaves use their own progress ('done' counts as 100);
 * parents use the weighted mean of their non-dropped children (own progress if all children are dropped).
 */
export function computeWpProgress(wps: WorkpackageRow[]): Map<string, number> {
  const byId = new Map(wps.map((w) => [w.id, w]));
  const children = new Map<string, WorkpackageRow[]>();
  for (const w of wps) {
    if (w.parent_id && byId.has(w.parent_id)) {
      const list = children.get(w.parent_id) ?? [];
      list.push(w);
      children.set(w.parent_id, list);
    }
  }

  const result = new Map<string, number>();
  const visiting = new Set<string>();

  const own = (w: WorkpackageRow): number => (w.status === "done" ? 100 : w.progress);

  const visit = (w: WorkpackageRow): number => {
    const cached = result.get(w.id);
    if (cached !== undefined) return cached;
    if (visiting.has(w.id)) return own(w); // cycle guard: treat as leaf
    visiting.add(w.id);
    const kids = (children.get(w.id) ?? []).filter((c) => c.status !== "dropped");
    let value: number;
    if (!kids.length) {
      value = own(w);
    } else {
      let sum = 0;
      let weight = 0;
      for (const c of kids) {
        sum += visit(c) * c.weight;
        weight += c.weight;
      }
      value = weight > 0 ? sum / weight : own(w);
    }
    visiting.delete(w.id);
    value = round1(value);
    result.set(w.id, value);
    return value;
  };

  for (const w of wps) visit(w);
  return result;
}

/** Project progress: manual value, or weighted mean of top-level, non-dropped work packages. */
export function computeProjectProgress(project: Pick<ProjectRow, "progress_mode" | "progress_manual">, wps: WorkpackageRow[]): number {
  if (project.progress_mode === "manual") return round1(project.progress_manual ?? 0);
  const eff = computeWpProgress(wps);
  const ids = new Set(wps.map((w) => w.id));
  const top = wps.filter((w) => (!w.parent_id || !ids.has(w.parent_id)) && w.status !== "dropped");
  let sum = 0;
  let weight = 0;
  for (const w of top) {
    sum += (eff.get(w.id) ?? 0) * w.weight;
    weight += w.weight;
  }
  return weight > 0 ? round1(sum / weight) : 0;
}

export type WpNode<T extends WorkpackageRow> = T & {
  effective_progress: number;
  effective_category: string | null;
  is_human: boolean;
  locked: boolean;
  bar_category: string | null;
  depends_ids: string[];
  children: WpNode<T>[];
};

/** Leaf WPs (no children) by state: open = todo/waiting/blocked, started = doing; dropped is not counted. */
export function leafCounts(wps: WorkpackageRow[]): { open: number; started: number; done: number } {
  const parents = new Set(wps.filter((w) => w.parent_id && w.parent_id !== w.id).map((w) => w.parent_id));
  const out = { open: 0, started: 0, done: 0 };
  for (const w of wps) {
    if (parents.has(w.id)) continue;
    if (w.status === "done") out.done++;
    else if (w.status === "doing") out.started++;
    else if (w.status !== "dropped") out.open++;
  }
  return out;
}

/** Nested tree (top-level first), children sorted by sort, then title. `locked` = WPs unlocked by a not-yet-reached milestone. */
export function buildWpTree<T extends WorkpackageRow>(wps: T[], opts: { locked?: Set<string> } = {}): WpNode<T>[] {
  const eff = computeWpProgress(wps);
  const cats = effectiveCategories(wps);
  const kidsOf = new Map<string, T[]>();
  for (const w of wps) if (w.parent_id) kidsOf.set(w.parent_id, [...(kidsOf.get(w.parent_id) ?? []), w]);
  const nodes = new Map<string, WpNode<T>>(
    wps.map((w) => [
      w.id,
      {
        ...w,
        effective_progress: eff.get(w.id) ?? 0,
        effective_category: cats.get(w.id) ?? null,
        is_human: isHuman(w, cats.get(w.id) ?? null),
        locked: opts.locked?.has(w.id) ?? false,
        bar_category: barCategory(w, kidsOf.get(w.id) ?? [], cats),
        depends_ids: parseJsonArray(w.depends_on),
        children: [],
      },
    ]),
  );
  const roots: WpNode<T>[] = [];
  for (const n of nodes.values()) {
    const parent = n.parent_id ? nodes.get(n.parent_id) : undefined;
    if (parent && parent !== n) parent.children.push(n);
    else roots.push(n);
  }
  const order = (a: WpNode<T>, b: WpNode<T>) => a.sort - b.sort || a.title.localeCompare(b.title);
  const sortRec = (list: WpNode<T>[], seen = new Set<string>()) => {
    list.sort(order);
    for (const n of list) {
      if (seen.has(n.id)) {
        n.children = [];
        continue;
      }
      seen.add(n.id);
      sortRec(n.children, seen);
    }
  };
  sortRec(roots);
  return roots;
}
