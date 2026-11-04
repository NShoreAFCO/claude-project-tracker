import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hookCommand, mergeSettings } from "../lib/settings-merge.mjs";
import { profileBlock } from "../lib/user-env.mjs";
import { installHook } from "../install-hook.mjs";
import { writeSecrets } from "../lib/secrets.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CMD = 'node "C:/Users/Jane Doe/.claude/hooks/tracker-session-end.mjs"';

test("mergeSettings: no file → one SessionEnd entry", () => {
  const r = mergeSettings(null, CMD);
  assert.equal(r.changed, true);
  assert.deepEqual(r.settings, { hooks: { SessionEnd: [{ hooks: [{ type: "command", command: CMD }] }] } });
});

test("mergeSettings: keeps other keys and hooks", () => {
  const existing = {
    model: "opus",
    permissions: { allow: ["Bash(git:*)"] },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x" }] }], SessionEnd: [{ hooks: [{ type: "command", command: "other-hook" }] }] },
  };
  const r = mergeSettings(existing, CMD);
  assert.equal(r.settings.model, "opus");
  assert.deepEqual(r.settings.permissions, existing.permissions);
  assert.deepEqual(r.settings.hooks.PreToolUse, existing.hooks.PreToolUse);
  const cmds = r.settings.hooks.SessionEnd.flatMap((e) => e.hooks.map((h) => h.command));
  assert.deepEqual(cmds.sort(), [CMD, "other-hook"].sort());
});

test("mergeSettings: replaces an older tracker entry instead of duplicating it", () => {
  const existing = { hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "node C:/old/path/tracker-session-end.mjs" }] }] } };
  const r = mergeSettings(existing, CMD);
  const cmds = r.settings.hooks.SessionEnd.flatMap((e) => e.hooks.map((h) => h.command));
  assert.deepEqual(cmds, [CMD]);
});

test("mergeSettings: idempotent rerun → changed=false", () => {
  const once = mergeSettings(null, CMD).settings;
  const twice = mergeSettings(JSON.parse(JSON.stringify(once)), CMD);
  assert.equal(twice.changed, false);
  assert.deepEqual(twice.settings, once);
});

test("hookCommand quotes paths with spaces and uses forward slashes", () => {
  assert.equal(hookCommand("C:\\Users\\Jane Doe", "win32"), CMD);
  assert.equal(hookCommand("/home/jane", "linux"), 'node "/home/jane/.claude/hooks/tracker-session-end.mjs"');
});

test("profile block replaced on rerun", () => {
  const vars = { TRACKER_URL: "https://t.example.workers.dev", TRACKER_CF_CLIENT_ID: "id1.access", TRACKER_CF_CLIENT_SECRET: "s3cr3t" };
  const first = profileBlock("export PATH=$PATH:/x\n", vars);
  assert.match(first, /export PATH=\$PATH:\/x/);
  assert.match(first, /export TRACKER_URL='https:\/\/t\.example\.workers\.dev'/);
  const second = profileBlock(first, { ...vars, TRACKER_CF_CLIENT_SECRET: "new" });
  assert.equal((second.match(/project tracker hook \(begin\)/g) ?? []).length, 1);
  assert.match(second, /TRACKER_CF_CLIENT_SECRET='new'/);
  assert.doesNotMatch(second, /s3cr3t/);
});

test("installHook copies the hook, merges settings with a backup, sets env and tests the hook", async () => {
  const root = mkdtempSync(join(tmpdir(), "hookroot-"));
  mkdirSync(join(root, "hooks"));
  cpSync(join(repo, "hooks", "tracker-session-end.mjs"), join(root, "hooks", "tracker-session-end.mjs"));
  mkdirSync(join(root, "instance"));
  writeFileSync(join(root, "instance", "instance.config.json"), JSON.stringify({ deploy: { publicUrl: "https://t.example.workers.dev" } }));
  writeSecrets(root, { HOOK_CLIENT_ID: "id1.access", HOOK_CLIENT_SECRET: "hook-secret-value-123" });
  const home = mkdtempSync(join(tmpdir(), "home "));
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "opus" }));
  const envSet = [];
  const lines = [];
  const r = await installHook({
    root,
    home,
    platform: "win32",
    setUserEnv: async (vars) => envSet.push(vars),
    runHook: async (env) => ({ code: 0, stdout: '{"ok":true,"matched":null}', env }),
    log: (l) => lines.push(l),
  });
  assert.equal(r.ok, true, lines.join("\n"));
  assert.ok(existsSync(join(home, ".claude", "hooks", "tracker-session-end.mjs")));
  const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.model, "opus");
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].command, hookCommand(home, "win32"));
  assert.ok(readdirSync(join(home, ".claude")).some((f) => f.startsWith("settings.json.bak-")));
  assert.deepEqual(envSet[0], { TRACKER_URL: "https://t.example.workers.dev", TRACKER_CF_CLIENT_ID: "id1.access", TRACKER_CF_CLIENT_SECRET: "hook-secret-value-123" });
  assert.ok(!lines.join("\n").includes("hook-secret-value-123"));
});

test("installHook explains a 302/401 from Access", async () => {
  const root = mkdtempSync(join(tmpdir(), "hookroot-"));
  mkdirSync(join(root, "hooks"));
  cpSync(join(repo, "hooks", "tracker-session-end.mjs"), join(root, "hooks", "tracker-session-end.mjs"));
  mkdirSync(join(root, "instance"));
  writeFileSync(join(root, "instance", "instance.config.json"), JSON.stringify({ deploy: { publicUrl: "https://t.example.workers.dev" } }));
  writeSecrets(root, { HOOK_CLIENT_ID: "id1.access", HOOK_CLIENT_SECRET: "hook-secret-value-123" });
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const lines = [];
  const r = await installHook({
    root,
    home,
    platform: "linux",
    setUserEnv: async () => {},
    runHook: async () => ({ code: 0, stdout: "", stderr: "[tracker-hook] POST 302" }),
    log: (l) => lines.push(l),
  });
  assert.equal(r.ok, false);
  assert.match(lines.join("\n"), /service token/i);
});

// Runs the real hook script against a local server (or an unreachable port) and returns what it posted.
function runHook(cwd, url) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(repo, "hooks", "tracker-session-end.mjs")], {
      env: { ...process.env, TRACKER_URL: url, TRACKER_CF_CLIENT_ID: "id", TRACKER_CF_CLIENT_SECRET: "s" },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("close", (code) => resolve(code));
    child.stdin.end(JSON.stringify({ session_id: "s1", cwd, reason: "other" }));
  });
}

test("hook body carries host and both files; skips a file over 256 KB; exits 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hookcwd-"));
  writeFileSync(join(dir, "session.md"), "# session");
  writeFileSync(join(dir, "HANDOFF.md"), "# handoff");
  let posted = null;
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      posted = JSON.parse(b);
      res.end("{}");
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal(await runHook(dir, url), 0);
    assert.ok(typeof posted.host === "string" && posted.host.length > 0 && posted.host.length <= 64);
    assert.deepEqual(posted.context_files, [
      { name: "session.md", content: "# session" },
      { name: "HANDOFF.md", content: "# handoff" },
    ]);
    posted = null;
    writeFileSync(join(dir, "HANDOFF.md"), "x".repeat(256 * 1024 + 1));
    assert.equal(await runHook(dir, url), 0);
    assert.deepEqual(posted.context_files, [{ name: "session.md", content: "# session" }]);
  } finally {
    srv.close();
  }
});

test("hook exits 0 when the server is unreachable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hookcwd-"));
  assert.equal(await runHook(dir, "http://127.0.0.1:9"), 0);
});
