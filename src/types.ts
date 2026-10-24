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
  tags: string | null;
  category: string | null;
  version: number;
  created_at: string;
  updated_at: string;
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
  weight: number;
  start_date: string | null;
  end_date: string | null;
  depends_on: string | null;
  sort: number;
  category: string | null;
  human: number | null;
  version: number;
  created_at: string;
  updated_at: string;
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

/** Identity resolved by the auth layer for a request. */
export type Identity = { kind: "user"; email: string } | { kind: "service"; clientId: string };

export const DEFAULT_SCORE_CRITERIA = ["value", "quality", "risk", "effort", "token_efficiency"] as const;
export const CONTEXT_DOC_MAX_BYTES = 256 * 1024;
export const CONTEXT_OWNER_MAX_BYTES = 2 * 1024 * 1024;
export const CONTEXT_REVISIONS_KEPT = 20;
