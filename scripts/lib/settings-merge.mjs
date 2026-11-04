// Merges the tracker SessionEnd hook into a Claude Code settings.json object (pure, never mutates its input).
const isTrackerHook = (h) => typeof h?.command === "string" && /tracker-session-end\.mjs"?(\s+--budget-ms\s+\d+)?$/.test(h.command.trim());

/** The hook's own budget and the settings.json `timeout` (seconds) that lets Claude Code wait for it (SessionEnd default: 1.5 s). */
export const HOOK_BUDGET_MS = 4000;
export const HOOK_TIMEOUT_S = 5;

export function hookCommand(homeDir, _platform) {
  return `node "${String(homeDir).replaceAll("\\", "/").replace(/\/+$/, "")}/.claude/hooks/tracker-session-end.mjs" --budget-ms ${HOOK_BUDGET_MS}`;
}

export function mergeSettings(existing, command) {
  const base = structuredClone(existing ?? {});
  const kept = (base.hooks?.SessionEnd ?? [])
    .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !isTrackerHook(h)) }))
    .filter((e) => e.hooks.length > 0);
  kept.push({ hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] });
  const settings = { ...base, hooks: { ...(base.hooks ?? {}), SessionEnd: kept } };
  const changed = JSON.stringify(settings) !== JSON.stringify(existing ?? null);
  return { settings, changed };
}
