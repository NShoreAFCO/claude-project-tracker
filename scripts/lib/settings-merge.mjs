// Merges the tracker SessionEnd hook into a Claude Code settings.json object (pure, never mutates its input).
const isTrackerHook = (h) => typeof h?.command === "string" && /tracker-session-end\.mjs"?$/.test(h.command.trim());

export function hookCommand(homeDir, _platform) {
  return `node "${String(homeDir).replaceAll("\\", "/").replace(/\/+$/, "")}/.claude/hooks/tracker-session-end.mjs"`;
}

export function mergeSettings(existing, command) {
  const base = structuredClone(existing ?? {});
  const kept = (base.hooks?.SessionEnd ?? [])
    .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !isTrackerHook(h)) }))
    .filter((e) => e.hooks.length > 0);
  kept.push({ hooks: [{ type: "command", command }] });
  const settings = { ...base, hooks: { ...(base.hooks ?? {}), SessionEnd: kept } };
  const changed = JSON.stringify(settings) !== JSON.stringify(existing ?? null);
  return { settings, changed };
}
