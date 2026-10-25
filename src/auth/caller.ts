import type { Caller } from "../types";

/** Writes the worker performs on its own (migrations, scheduled jobs). */
export const SYSTEM_CALLER: Caller = { actor: "system", personId: null, role: "admin", channel: "system" };

/** Agents (MCP clients, service tokens) are kept from decisions reserved for persons (spec §4.2). */
export const isAgent = (c: Caller): boolean => c.channel === "mcp" || c.channel === "service";

/** Actor string for an MCP client: mcp:<client name>, restricted to a safe character set. */
export function mcpActor(clientName: string | undefined): string {
  const name = (clientName ?? "")
    .replace(/[^\w .@-]/g, "")
    .trim()
    .slice(0, 60);
  return `mcp:${name || "client"}`;
}

/** Dashboard user (Access JWT, allow-listed email). */
export async function userCaller(_db: D1Database, email: string): Promise<Caller> {
  return { actor: `user:${email}`, personId: null, role: null, channel: "dashboard" };
}

/** MCP request; props are the OAuth grant props. */
export async function mcpCaller(_db: D1Database, props: { email?: string; clientName?: string }): Promise<Caller> {
  return { actor: mcpActor(props.clientName), personId: null, role: null, channel: "mcp" };
}

/** Service token (hook, webhook): acts as editor, for a person only when on_behalf_of names one. */
export async function serviceCaller(_db: D1Database, actor: string, _onBehalfOf?: string | null): Promise<Caller> {
  return { actor, personId: null, role: "editor", channel: "service" };
}
