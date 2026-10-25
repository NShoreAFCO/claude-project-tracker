import { INSTANCE } from "./generated/instance";
import type { Role } from "./types";

export type ScoreLevel = "0" | "5" | "10";

/** The instance's policy block (spec §4.3). build-instance applies the defaults, so every field is set. */
export interface Policy {
  /** Emails that become admins on first login. */
  admins: string[];
  /** Role a new user gets on first login. */
  default_role: Role;
  /** UI languages offered; the first is the instance default (app.locale). */
  locales: string[];
  /** Days without activity before a project counts as stale (category entries may override). */
  stale_days: number;
  schedule_strict_default: boolean;
  /** Project types that need a target date before they can become active. */
  target_date_required_categories: string[];
  gates: { require_decision: boolean };
  /** Soft-deleted items may be purged (manually, by an admin) after this many days. */
  retention_days: number;
  hide_empty_categories: "hide" | "collapse";
  report: { paper: "a4" | "letter"; pdf: boolean };
  /** Per score criterion: what 0, 5 and 10 mean, labels per locale. */
  score_scales: Record<string, Record<ScoreLevel, Record<string, string>>>;
}

/** INSTANCE.policy with defaults applied. A plain object: tests may adjust it in place. */
export const POLICY: Policy = INSTANCE.policy as unknown as Policy;
