// Installs the SessionEnd hook for the current user: copies it to ~/.claude/hooks, merges ~/.claude/settings.json,
// stores the TRACKER_* environment variables and sends a test event.
// Usage: npm run hook:install        Run `npm run setup` first.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSecrets, scrubber } from "./lib/secrets.mjs";
import { hookCommand, mergeSettings } from "./lib/settings-merge.mjs";
import { setUserEnv as realSetUserEnv } from "./lib/user-env.mjs";

function realRunHook(hookFile, root) {
  return (env) =>
    new Promise((done) => {
      const child = spawn(process.execPath, [hookFile], {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10000,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("error", (e) => done({ code: 1, stdout, stderr: stderr + e.message }));
      child.on("close", (code) => done({ code, stdout, stderr }));
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ session_id: "install-test", cwd: root, reason: "other" }));
    });
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

export async function installHook({
  root,
  home = os.homedir(),
  platform = process.platform,
  setUserEnv = realSetUserEnv,
  runHook,
  log = console.log,
}) {
  const secrets = readSecrets(root);
  const scrub = scrubber(secrets);
  const say = (l) => log(scrub(l));
  const cfgFile = join(root, "instance", "instance.config.json");
  const publicUrl = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, "utf8")).deploy?.publicUrl : undefined;
  if (!publicUrl || !secrets.HOOK_CLIENT_ID || !secrets.HOOK_CLIENT_SECRET) {
    say("The deployment is not set up yet (public URL or hook service token missing). Run `npm run setup` first.");
    return { ok: false };
  }
  try {
    const target = join(home, ".claude", "hooks", "tracker-session-end.mjs");
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, "hooks", "tracker-session-end.mjs"), target);
    say(`  ✓ hook copied to ${target}`);

    const settingsFile = join(home, ".claude", "settings.json");
    let existing = null;
    if (existsSync(settingsFile)) {
      const raw = readFileSync(settingsFile, "utf8");
      try {
        existing = JSON.parse(raw);
      } catch {
        say(`${settingsFile} contains invalid JSON. Fix or remove it, then run this again. Nothing was changed there.`);
        return { ok: false };
      }
      writeFileSync(`${settingsFile}.bak-${stamp()}`, raw);
    }
    const { settings, changed } = mergeSettings(existing, hookCommand(home, platform));
    if (changed) writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    say(changed ? "  ✓ settings.json updated (backup saved next to it)" : "  ✓ settings.json already up to date");

    const env = {
      TRACKER_URL: publicUrl,
      TRACKER_CF_CLIENT_ID: secrets.HOOK_CLIENT_ID,
      TRACKER_CF_CLIENT_SECRET: secrets.HOOK_CLIENT_SECRET,
    };
    const where = await setUserEnv(env, { platform, home });
    say(`  ✓ environment variables stored (${where ?? "user environment"})`);

    const run = runHook ?? realRunHook(target, root);
    const r = await run({ ...env, TRACKER_DEBUG: "1" });
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    if (out.includes('"ok":true')) say("  ✓ test event accepted by the tracker");
    else if (/\b(302|401|403)\b/.test(out)) {
      say(
        "  ✗ Cloudflare Access rejected the service token. Check the HOOK client id/secret, the Access application's service-auth policy and allowedServiceTokenIds, then rerun `npm run setup`.",
      );
      return { ok: false };
    } else {
      say(`  ✗ test event failed: ${out.trim().slice(-400)}`);
      return { ok: false };
    }
  } catch (e) {
    say(`  ✗ ${e.message}`);
    return { ok: false };
  }
  say("Restart Claude Code (and on Windows open a new terminal) so it picks up the new environment variables.");
  return { ok: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  installHook({ root }).then((r) => process.exit(r.ok ? 0 : 1));
}
