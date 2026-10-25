import type { Caller } from "../types";
import { ensureUserPerson, resolvePersonRef } from "../data/persons";
import { ValidationError } from "../data/util";

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

/** Dashboard user (Access JWT, allow-listed email); the person is created on first login. */
export async function userCaller(db: D1Database, email: string): Promise<Caller> {
  const p = await ensureUserPerson(db, email);
  return { actor: `user:${email}`, personId: p.id, role: p.access_role, channel: "dashboard" };
}

/** MCP request; props are the OAuth grant props (the email is the login's, already allow-list checked). */
export async function mcpCaller(db: D1Database, props: { email?: string; clientName?: string }): Promise<Caller> {
  const p = props.email ? await ensureUserPerson(db, props.email) : null;
  return { actor: mcpActor(props.clientName), personId: p?.id ?? null, role: p?.access_role ?? null, channel: "mcp" };
}

/**
 * Service token (hook, webhook): acts as editor without a person, unless on_behalf_of names one
 * by person id or email. An on_behalf_of that matches nobody is an error, not a silent drop.
 */
export async function serviceCaller(db: D1Database, actor: string, onBehalfOf?: string | null): Promise<Caller> {
  const ref = typeof onBehalfOf === "string" ? onBehalfOf.trim() : "";
  let personId: string | null = null;
  if (ref) {
    const r = await resolvePersonRef(db, ref);
    // Only an id or email counts: a name match is not precise enough to act on someone's behalf.
    const precise = r.person_id !== null && (r.person_id === ref || ref.includes("@"));
    if (!precise) throw new ValidationError("on_behalf_of must be the id or email of a person");
    personId = r.person_id;
  }
  return { actor, personId, role: "editor", channel: "service" };
}
