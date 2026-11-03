/**
 * Central role enforcement (spec §4.2, F11). Every REST route and MCP tool maps to exactly one Action
 * (REST_ACTIONS, TOOL_ACTIONS); the dispatcher and the MCP `reg` wrapper check it before the handler runs.
 * Content-dependent actions (closing a project, verifying a sign_off WP, changing a user's access) are
 * checked again in the data layer, where the write's content is known.
 *
 * The role is read from the caller, which is built from the person row on every request (userCaller,
 * mcpCaller): a role change takes effect on the caller's next request. Nothing here caches a role.
 */
import type { Caller, Role } from "../types";
import { ForbiddenError } from "../data/util";

export type Action = "read" | "write" | "decide" | "close" | "verify_sign_off" | "manage_roles" | "purge" | "restore";

export const ACTIONS: readonly Action[] = ["read", "write", "decide", "close", "verify_sign_off", "manage_roles", "purge", "restore"];

const RANK: Record<Role, number> = { viewer: 0, editor: 1, decider: 2, admin: 3 };
/** Own-property lookup, so inherited names ("constructor", "toString") never count as a role or action. */
const own = (o: object, k: unknown): boolean => typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);

/** Lowest role allowed to perform an action (spec §4.2). */
export const MIN_ROLE: Record<Action, Role> = {
  read: "viewer",
  write: "editor",
  decide: "decider",
  close: "decider",
  verify_sign_off: "decider",
  manage_roles: "admin",
  purge: "admin",
  restore: "admin",
};

/**
 * Actions an agent channel never performs, whatever its role. Service tokens (hook, webhook, scripts) act
 * as editor and never decide, close, verify a sign_off, change access, purge or restore, also with
 * on_behalf_of. MCP clients act with their OAuth login's role (an admin login may restore, spec §4.2),
 * but never change access or purge (global constraints).
 */
const AGENT_DENIED: Record<"mcp" | "service", readonly Action[]> = {
  service: ["decide", "close", "verify_sign_off", "manage_roles", "purge", "restore"],
  mcp: ["manage_roles", "purge"],
};

const WHAT: Record<Action, string> = {
  read: "reading tracker data",
  write: "changing tracker data",
  decide: "recording a gate decision",
  close: "closing a project (done or abandoned)",
  verify_sign_off: "verifying a sign_off work package",
  manage_roles: "changing a user's access (role, login email, deleting or restoring a user)",
  purge: "purging items from the trash",
  restore: "restoring items from the trash",
};

/** Whether the caller's role is `role` or above (for rules that name a role rather than an action). */
export const hasRole = (by: Caller, role: Role): boolean =>
  !!by.role && own(RANK, by.role) && own(RANK, role) && RANK[by.role] >= RANK[role];

/** Whether `by` may perform `action`; requireAction throws where this is false. */
export function canDo(by: Caller, action: Action): boolean {
  if (by.channel === "mcp" || by.channel === "service") {
    if (AGENT_DENIED[by.channel].includes(action)) return false;
  }
  return own(MIN_ROLE, action) && hasRole(by, MIN_ROLE[action]);
}

/** Throws ForbiddenError (403) unless `by` may perform `action`. An unknown action is refused (fail closed). */
export function requireAction(by: Caller, action: Action): void {
  if (canDo(by, action)) return;
  const what = own(WHAT, action) ? WHAT[action] : `action ${String(action)}`;
  if (!own(MIN_ROLE, action)) throw new ForbiddenError(`no permission is defined for ${what}`);
  if (by.channel === "service" && AGENT_DENIED.service.includes(action))
    throw new ForbiddenError(`service tokens cannot do this (${what}); a person does it`);
  if (by.channel === "mcp" && AGENT_DENIED.mcp.includes(action))
    throw new ForbiddenError(`agents cannot do this (${what}); an admin does it in the dashboard`);
  if (!by.role) throw new ForbiddenError(`${what} needs an access role; this login has none`);
  throw new ForbiddenError(`${what} needs the ${MIN_ROLE[action]} role or above (this login: ${by.role})`);
}

/**
 * Every REST route ("METHOD pattern", as registered in src/api/rest.ts, plus the hook and webhook
 * endpoints) → its Action. A route missing here is refused at runtime (403), and test/permissions.test.ts
 * fails, so a new route cannot slip through unmapped.
 */
export const REST_ACTIONS: Readonly<Record<string, Action>> = {
  "GET /api/whoami": "read",
  "GET /api/context/bundle": "read",
  // projects (a status change to done/abandoned also needs "close", checked in updateProject/createProject)
  "GET /api/projects": "read",
  "POST /api/projects": "write",
  "GET /api/projects/:id": "read",
  "GET /api/projects/:id/report": "read",
  "GET /api/report/print.css": "read",
  "PATCH /api/projects/:id": "write",
  "DELETE /api/projects/:id": "write",
  "POST /api/projects/:id/move-workpackages": "write",
  "POST /api/projects/:id/baselines": "write",
  // risks
  "GET /api/risks": "read",
  "POST /api/risks": "write",
  "PATCH /api/risks/:id": "write",
  "DELETE /api/risks/:id": "write",
  // portfolio
  "GET /api/portfolio/summary": "read",
  "GET /api/workpackages/upcoming": "read",
  "GET /api/workpackages/mine": "read",
  "GET /api/workpackages/open": "read",
  "GET /api/gates/open": "read",
  "GET /api/persons/me/dashboard": "read",
  "PUT /api/persons/me/dashboard": "read",
  // work packages (completing or verifying a sign_off WP also needs "verify_sign_off", checked in the data layer)
  "GET /api/workpackages": "read",
  "POST /api/workpackages": "write",
  "PATCH /api/workpackages/:id": "write",
  "DELETE /api/workpackages/:id": "write",
  "POST /api/workpackages/:id/gate-override": "write",
  // milestones and gates
  "GET /api/milestones": "read",
  "POST /api/milestones": "write",
  "PATCH /api/milestones/:id": "write",
  "DELETE /api/milestones/:id": "write",
  "POST /api/milestones/:id/decisions": "decide",
  // persons (access_role / a user's email, and deleting a user, also need "manage_roles")
  "GET /api/persons": "read",
  "POST /api/persons": "write",
  // own UI preferences (locale, display_name, phone) are not tracker data: viewers set them too
  "PATCH /api/persons/me": "read",
  "PATCH /api/persons/:id": "write",
  "DELETE /api/persons/:id": "write",
  // trash (spec §4.2: restore and purge are admin actions)
  "GET /api/trash": "read",
  "POST /api/trash/:kind/:id/restore": "restore",
  "DELETE /api/trash/:kind/:id": "purge",
  "GET /api/delete-preview": "read",
  // audit export trigger
  "POST /api/audit/run": "write",
  // branches, scores, token cost, progress
  "POST /api/branches": "write",
  "DELETE /api/branches/:id": "write",
  "POST /api/scores": "write",
  "POST /api/token-cost": "write",
  "POST /api/progress": "write",
  // events, inbox, search
  "GET /api/events": "read",
  "GET /api/inbox": "read",
  "POST /api/inbox/:id/assign": "write",
  "GET /api/search": "read",
  // context
  "GET /api/context": "read",
  "POST /api/context/upload": "write",
  "POST /api/context": "write",
  "GET /api/context/revisions/:rev": "read",
  "GET /api/context/:id": "read",
  "PUT /api/context/:id": "write",
  "PATCH /api/context/:id": "write",
  "POST /api/context/:id/append": "write",
  "DELETE /api/context/:id": "write",
  "GET /api/context/:id/revisions": "read",
  "POST /api/context/:id/restore": "write",
  // service endpoints (user or service token; HMAC-signed webhook)
  "POST /api/hooks/claude-code": "write",
  "POST /webhooks/github": "write",
};

/** Every MCP tool → its Action. A tool missing here is refused at runtime and fails the coverage test. */
export const TOOL_ACTIONS: Readonly<Record<string, Action>> = {
  list_projects: "read",
  get_project: "read",
  create_project: "write",
  update_project: "write",
  upsert_workpackage: "write",
  move_workpackages: "write",
  upsert_milestone: "write",
  record_gate_decision: "decide",
  create_baseline: "write",
  upsert_risk: "write",
  list_risks: "read",
  delete_entity: "write",
  restore_entity: "restore",
  log_progress: "write",
  link_branch: "write",
  set_scores: "write",
  log_token_cost: "write",
  search: "read",
  list_context: "read",
  read_context: "read",
  get_context_bundle: "read",
  write_context: "write",
  append_context: "write",
  delete_context: "write",
  set_context_meta: "write",
  get_portfolio_summary: "read",
  list_persons: "read",
  upsert_person: "write",
};

/** Action of a REST route key, or undefined (refused) when unmapped. */
export const restAction = (key: string): Action | undefined => (own(REST_ACTIONS, key) ? REST_ACTIONS[key] : undefined);

/** Action of an MCP tool, or undefined (refused) when unmapped. */
export const toolAction = (name: string): Action | undefined => (own(TOOL_ACTIONS, name) ? TOOL_ACTIONS[name] : undefined);
