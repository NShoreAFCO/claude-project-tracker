import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  ASSETS: Fetcher;
  OAUTH_PROVIDER: OAuthHelpers;

  // vars (wrangler.jsonc)
  PUBLIC_URL: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALLOWED_EMAILS: string;
  ALLOWED_SERVICE_TOKEN_IDS: string;
  AUDIT_REPO: string;

  // secrets (wrangler secret put)
  ACCESS_CLIENT_ID: string;
  ACCESS_CLIENT_SECRET: string;
  ACCESS_TOKEN_URL: string;
  ACCESS_AUTHORIZATION_URL: string;
  ACCESS_JWKS_URL: string;
  COOKIE_ENCRYPTION_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  AUDIT_GITHUB_TOKEN: string;

  // .dev.vars only; honoured on localhost only
  DEV_AUTH_EMAIL?: string;
}

export type ProjectStatus = "idea" | "active" | "on_hold" | "done" | "abandoned";
export type ProjectOrigin = "claude-web" | "claude-code" | "manual" | "mixed";
export type WpStatus = "todo" | "doing" | "blocked" | "waiting" | "done" | "dropped";
export type BranchKind = "branch" | "fork" | "worktree";
export type BranchStatus = "open" | "merged" | "closed" | "abandoned" | "stale";
export type OwnerKind = "project" | "workpackage" | "branch";
export type ContextSource = "upload" | "paste" | "claude" | "sync";
export type ContextDocStatus = "draft" | "released" | "obsolete";

/** JSON-array columns (tags, depends_on) are stored as TEXT and kept as strings in rows. */
export interface ProjectRow {
  id: string;
  title: string;
  summary: string | null;
  description_md: string | null;
  status: ProjectStatus;
  origin: ProjectOrigin;
  repo_url: string | null;
  local_path: string | null;
  context_file: string | null;
  session_id: string | null;
  start_date: string | null;
  target_date: string | null;
  progress_mode: "derived" | "manual";
  progress_manual: number | null;
  /** Why the progress is set by hand (spec F7); required when manual mode or the manual value is written. */
  progress_manual_reason?: string | null;
  tags: string | null;
  category: string | null;
  /** Owner, sponsor, decision maker: a person id, or free text when no person matches (spec §4.1). */
  owner_person_id: string | null;
  owner_text: string | null;
  sponsor_person_id: string | null;
  sponsor_text: string | null;
  decision_maker_person_id: string | null;
  decision_maker_text: string | null;
  /** Closure record (spec F3): `done` and `abandoned` need the note, `done` also lessons learned. */
  closure_note_md: string | null;
  lessons_learned_md: string | null;
  /** Objectives and scope (spec F2), Markdown. */
  objectives_md?: string | null;
  scope_in_md?: string | null;
  scope_out_md?: string | null;
  success_criteria_md?: string | null;
  /** Report language (one of policy.locales); NULL = instance default locale. */
  language?: string | null;
  /** Schedule validation (spec F4): 1 strict, 0 lenient, NULL = policy schedule_strict_default. */
  schedule_strict?: number | null;
  /** Bumped by every schedule-affecting write (guarded, same batch) to detect concurrent writes. */
  schedule_rev?: number;
  /** A gate `stop` decision put the project on hold (spec F5). */
  closure_decision_pending?: number;
  /** Soft delete (spec F10): set while the row is in the trash. */
  deleted_at?: string | null;
  deleted_by?: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  /** Activity data (spec F8): last progress / last write; null until first tracked write. */
  last_progress_at: string | null;
  last_changed_at: string | null;
}

export interface WorkpackageRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  description_md: string | null;
  status: WpStatus;
  blocked_by: string | null;
  progress: number;
  /** Effort in person-days (PD); also the progress weight. */
  weight: number;
  /** Planned and actual effort in PD (spec F7); actual is added to by log_progress effort_pd. */
  effort_planned_pd?: number | null;
  effort_actual_pd?: number | null;
  start_date: string | null;
  end_date: string | null;
  depends_on: string | null;
  sort: number;
  category: string | null;
  human: number | null;
  /** Optional WP owner (person id or free text); the effective owner falls back to the project owner. */
  owner_person_id: string | null;
  owner_text: string | null;
  /** Why a WP was dropped (required for `dropped`). */
  drop_reason: string | null;
  /** YYYY-MM-DD the WP became `blocked`; cleared when it leaves `blocked`. */
  blocked_since: string | null;
  /** Optional reason for a deferral (`waiting`); cleared when it leaves `waiting`. */
  waiting_reason: string | null;
  /** Deliverable (short text) and acceptance criteria (Markdown), spec F2. */
  deliverable?: string | null;
  acceptance_criteria_md?: string | null;
  /** How completion is verified: review|test|demo|sign_off|none (default none). */
  verification?: string;
  /** Person id of the verifier (never an agent) and when; set only while the WP is done. */
  verified_by?: string | null;
  verified_at?: string | null;
  /** Stored schedule issues (JSON array of ScheduleIssue; "[]" = none, NULL = not computed yet), spec F4. */
  schedule_issues?: string | null;
  /** Gate lock override by a person (spec F5). */
  gate_override_by?: string | null;
  gate_override_at?: string | null;
  gate_override_reason?: string | null;
  /** Soft delete (spec F10): set while the row is in the trash. */
  deleted_at?: string | null;
  deleted_by?: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  last_progress_at: string | null;
  last_changed_at: string | null;
}

export interface MilestoneRow {
  id: string;
  project_id: string;
  workpackage_id: string | null;
  title: string;
  description_md: string | null;
  due_date: string | null;
  reached_at: string | null;
  sort: number;
  /** Stored schedule issues (JSON array of ScheduleIssue; "[]" = none, NULL = not computed yet), spec F4. */
  schedule_issues?: string | null;
  /** Gate milestone (spec F5): unlocking needs a go decision. */
  gate?: number;
  /** Soft delete (spec F10): set while the row is in the trash. */
  deleted_at?: string | null;
  deleted_by?: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface BranchRow {
  id: string;
  project_id: string;
  workpackage_id: string | null;
  repo: string;
  name: string;
  kind: BranchKind;
  base: string | null;
  status: BranchStatus;
  pr_number: number | null;
  pr_url: string | null;
  last_commit: string | null;
  last_activity: string | null;
  note: string | null;
}

export interface ScoreRow {
  id: string;
  project_id: string;
  criterion: string;
  value: number;
  note: string | null;
  recorded_at: string;
  actor: string;
}

export interface TokenCostRow {
  id: string;
  project_id: string;
  workpackage_id: string | null;
  recorded_at: string;
  claude_tokens: number | null;
  copilot_prompts: number | null;
  note: string | null;
  actor: string;
}

export interface EventRow {
  id: number;
  ts: string;
  actor: string;
  /** The human behind the write (login person, or on_behalf_of for service tokens); null for none. */
  person_id: string | null;
  project_id: string | null;
  entity: string;
  entity_id: string | null;
  action: string;
  summary: string | null;
  diff_json: string | null;
}

export interface ContextDocRow {
  id: string;
  project_id: string;
  owner_kind: OwnerKind;
  owner_id: string;
  title: string;
  slug: string;
  source: ContextSource;
  filename: string | null;
  content_md: string;
  pinned: number;
  sort: number;
  bytes: number;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  /** Document control (spec F10): draft|released|obsolete; obsolete docs stay out of bundles by default. */
  status: ContextDocStatus;
  released_by: string | null;
  released_at: string | null;
  /** Soft delete (spec F10): set while the row is in the trash. */
  deleted_at?: string | null;
  deleted_by?: string | null;
}

export interface ContextRevisionRow {
  id: number;
  doc_id: string;
  version: number;
  content_md: string;
  changed_at: string;
  changed_by: string;
}

/** Who performed a write: mcp:<client>, user:<email>, hook:claude-code, webhook:github. */
export type Actor = string;

/** Access role of a person (spec §4.2); stored from R1, enforced from R5. */
export type Role = "viewer" | "editor" | "decider" | "admin";
/** Where a write came from: dashboard user, MCP client, service token (hook, webhook), or the system itself. */
export type Channel = "dashboard" | "mcp" | "service" | "system";
/** Who performs a write: the technical actor string plus the human behind it, when known. */
export interface Caller {
  actor: string;
  personId: string | null;
  role: Role | null;
  channel: Channel;
}

export interface PersonRow {
  id: string;
  name: string;
  display_name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  contact_note: string | null;
  internal: number;
  function: string | null;
  comment: string | null;
  access_role: Role | null;
  locale: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

/** A person as shown next to an entity (owner chips, stakeholder lists). */
export interface PersonOut {
  person_id: string;
  name: string;
  initials: string;
}
/** A person-or-text field (owner, sponsor, decision maker) as returned to clients. */
export type PersonRefOut = PersonOut | { text: string } | null;

/** Non-blocking notice on a write result (e.g. a project created as idea because active preconditions are missing). */
export interface WriteWarning {
  code: string;
  message: string;
  fields?: string[];
}

/** Event with the human behind it joined in, for history display ("mcp:Claude for Jane Doe"). */
export type EventOut = EventRow & { person_name: string | null };

/** Identity resolved by the auth layer for a request. */
export type Identity = { kind: "user"; email: string } | { kind: "service"; clientId: string };

export const DEFAULT_SCORE_CRITERIA = ["value", "quality", "risk", "effort", "token_efficiency"] as const;
export const CONTEXT_DOC_MAX_BYTES = 256 * 1024;
export const CONTEXT_OWNER_MAX_BYTES = 2 * 1024 * 1024;
export const CONTEXT_REVISIONS_KEPT = 20;
