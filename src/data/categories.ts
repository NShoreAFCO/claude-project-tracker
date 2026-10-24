import type { WorkpackageRow } from "../types";
import { ValidationError } from "./util";
import { INSTANCE } from "../generated/instance";

// Category lists come from the instance config (instance.config.json → src/generated/instance.ts).
const keys = <T extends { key: string }>(list: readonly T[]) => list.map((c) => c.key) as [string, ...string[]];
export const PROJECT_CATEGORIES: readonly [string, ...string[]] = keys(INSTANCE.categories.project);
export const WP_CATEGORIES: readonly [string, ...string[]] = keys(INSTANCE.categories.workpackage);
/** Categories whose WPs are done off the computer unless `human` says otherwise. */
export const HUMAN_DEFAULT: readonly string[] = INSTANCE.categories.workpackage.filter((c) => "human" in c && c.human).map((c) => c.key);

/** Validate a category value (null clears it). */
export function checkCategory(v: unknown, allowed: readonly string[], field = "category"): string | null {
  if (v === null || v === "") return null;
  if (typeof v !== "string" || !allowed.includes(v)) throw new ValidationError(`${field} must be one of ${allowed.join("|")} or null`);
  return v;
}

/** Validate the human flag: true/false/null → 1/0/NULL. */
export function checkHuman(v: unknown): number | null {
  if (v === null) return null;
  if (v === true || v === 1) return 1;
  if (v === false || v === 0) return 0;
  throw new ValidationError("human must be true, false or null");
}

/** Own category, else the nearest ancestor's, else null. */
export function effectiveCategories(wps: WorkpackageRow[]): Map<string, string | null> {
  const byId = new Map(wps.map((w) => [w.id, w]));
  const out = new Map<string, string | null>();
  for (const w of wps) {
    let cur: WorkpackageRow | undefined = w;
    let cat: string | null = null;
    for (let depth = 0; cur && depth < 100; depth++) {
      if (cur.category) {
        cat = cur.category;
        break;
      }
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    out.set(w.id, cat);
  }
  return out;
}

export function isHuman(w: Pick<WorkpackageRow, "human">, eff: string | null): boolean {
  if (w.human === 1 || w.human === 0) return w.human === 1;
  return eff !== null && HUMAN_DEFAULT.includes(eff);
}

/**
 * Gantt bar colour: a leaf uses its effective category; a parent uses the category with the
 * largest summed weight among its non-dropped children (ties: own category, then WP_CATEGORIES order).
 */
export function barCategory(w: WorkpackageRow, children: WorkpackageRow[], eff: Map<string, string | null>): string | null {
  const own = eff.get(w.id) ?? null;
  const kids = children.filter((c) => c.status !== "dropped");
  if (!kids.length) return own;
  const sum = new Map<string, number>();
  for (const c of kids) {
    const cat = eff.get(c.id);
    if (cat) sum.set(cat, (sum.get(cat) ?? 0) + c.weight);
  }
  if (!sum.size) return own;
  const max = Math.max(...sum.values());
  const top = [...sum.entries()].filter(([, v]) => v === max).map(([k]) => k);
  if (own && top.includes(own)) return own;
  return WP_CATEGORIES.find((c) => top.includes(c)) ?? top[0];
}
