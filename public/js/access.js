import config from "../instance/config.js";
import { api } from "./api.js";
import { t } from "./i18n.js";

/** Display policy of the instance (public config), with defaults when a key is missing. */
export const POLICY = {
  locales: ["en"],
  hide_empty_categories: "collapse",
  target_date_required_categories: [],
  ...(config.policy || {}),
};

export const ROLES = ["viewer", "editor", "decider", "admin"];

export const MIN_ROLE = {
  read: "viewer",
  write: "editor",
  decide: "decider",
  close: "decider",
  verify_sign_off: "decider",
  manage_roles: "admin",
  purge: "admin",
  restore: "admin",
};

let me = null;

/** Loads and caches the current person. */
export async function loadMe() {
  try {
    const result = await api.whoami();
    me = result.person;
  } catch {
    me = null;
  }
  return me;
}

/** Returns the cached current person. */
export function getMe() {
  return me;
}

/** Returns the cached access role. */
export function role() {
  return me?.access_role ?? null;
}

/** Returns whether the cached role permits an action. */
export function can(action) {
  if (!Object.prototype.hasOwnProperty.call(MIN_ROLE, action)) {
    return false;
  }

  const currentRole = role();
  if (currentRole === null) {
    return false;
  }

  const currentRank = ROLES.indexOf(currentRole);
  const minimumRank = ROLES.indexOf(MIN_ROLE[action]);

  return currentRank >= minimumRank;
}

/** Returns the localized minimum-role tip for an action. */
export function roleTip(action) {
  return t("needsRole", { role: t("accessRole." + MIN_ROLE[action]) });
}

/** Returns an allowed element or hides it when access is denied. */
export function gate(el, action) {
  if (el == null) {
    return null;
  }

  if (!can(action)) {
    el.hidden = true;
    return null;
  }

  return el;
}
