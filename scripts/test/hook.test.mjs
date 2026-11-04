import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOOK_TIMEOUT_S, hookCommand, mergeSettings } from "../lib/settings-merge.mjs";
import { profileBlock } from "../lib/user-env.mjs";
import { installHook } from "../install-hook.mjs";
import { writeSecrets } from "../lib/secrets.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CMD = 'node "C:/Users/Jane Doe/.claude/hooks/tracker-session-end.mjs" --budget-ms 4000';

test("mergeSettings: no file → one SessionEnd entry", () => {
  const r = mergeSettings(null, CMD);
  assert.equal(r.changed, true);
  assert.deepEqual(r.settings, { hooks: { SessionEnd: [{ hooks: [{ type: "command", command: CMD, timeout: HOOK_TIMEOUT_S }] }] } });
});

test("mergeSettings: keeps other keys and hooks", () => {
  const existing = {
    model: "opus",
    permissions: { allow: ["Bash(git:*)"] },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x" }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: "other-hook" }] }],
    },
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

test("mergeSettings: replaces a hand-made entry (no flag, no timeout) and a flagged one", () => {
  for (const command of [
    'node "C:/Users/Jane Doe/.claude/hooks/tracker-session-end.mjs"',
    "node C:/x/tracker-session-end.mjs --budget-ms 900",
    "node 'C:/x/tracker-session-end.mjs' --budget-ms=4000",
    "node C:\\x\\tracker-session-end.mjs 2>/dev/null || true",
  ]) {
    const r = mergeSettings({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command }] }] } }, CMD);
    assert.deepEqual(r.settings.hooks.SessionEnd, [{ hooks: [{ type: "command", command: CMD, timeout: HOOK_TIMEOUT_S }] }]);
  }
});

test("mergeSettings: idempotent rerun → changed=false", () => {
  const once = mergeSettings(null, CMD).settings;
  const twice = mergeSettings(JSON.parse(JSON.stringify(once)), CMD);
  assert.equal(twice.changed, false);
  assert.deepEqual(twice.settings, once);
});

test("hookCommand quotes paths with spaces and uses forward slashes", () => {
  assert.equal(hookCommand("C:\\Users\\Jane Doe", "win32"), CMD);
  assert.equal(hookCommand("/home/jane", "linux"), 'node "/home/jane/.claude/hooks/tracker-session-end.mjs" --budget-ms 4000');
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
  assert.deepEqual(envSet[0], {
    TRACKER_URL: "https://t.example.workers.dev",
    TRACKER_CF_CLIENT_ID: "id1.access",
    TRACKER_CF_CLIENT_SECRET: "hook-secret-value-123",
  });
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

function hookRoot({ secrets } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hookroot-"));
  mkdirSync(join(root, "hooks"));
  cpSync(join(repo, "hooks", "tracker-session-end.mjs"), join(root, "hooks", "tracker-session-end.mjs"));
  mkdirSync(join(root, "instance"));
  writeFileSync(join(root, "instance", "instance.config.json"), JSON.stringify({ deploy: { publicUrl: "https://t.example.workers.dev" } }));
  if (secrets) writeSecrets(root, secrets);
  return root;
}

test("installHook without a hook token in the secrets store uses the existing TRACKER_* variables and leaves them alone", async () => {
  const root = hookRoot();
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const envSet = [];
  const ran = [];
  const lines = [];
  const procEnv = {
    TRACKER_URL: "https://t.example.workers.dev",
    TRACKER_CF_CLIENT_ID: "env-id.access",
    TRACKER_CF_CLIENT_SECRET: "env-secret-value-456",
  };
  const r = await installHook({
    root,
    home,
    platform: "win32",
    procEnv,
    setUserEnv: async (vars) => envSet.push(vars),
    runHook: async (env) => (ran.push(env), { code: 0, stdout: '{"ok":true}' }),
    log: (l) => lines.push(l),
  });
  assert.equal(r.ok, true, lines.join("\n"));
  assert.equal(envSet.length, 0);
  assert.deepEqual(ran[0], { ...procEnv, TRACKER_DEBUG: "1" });
  assert.match(lines.join("\n"), /existing environment variables/);
  assert.ok(!lines.join("\n").includes("env-secret-value-456"));
  const hook = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).hooks.SessionEnd[0].hooks[0];
  assert.equal(hook.timeout, HOOK_TIMEOUT_S);
  assert.match(hook.command, /--budget-ms 4000$/);
});

test("installHook without a stored token refuses a TRACKER_URL of another tracker and changes nothing", async () => {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const envSet = [];
  const lines = [];
  const procEnv = {
    TRACKER_URL: "https://other.example.workers.dev",
    TRACKER_CF_CLIENT_ID: "env-id.access",
    TRACKER_CF_CLIENT_SECRET: "env-secret-value-456",
  };
  const r = await installHook({ root: hookRoot(), home, procEnv, setUserEnv: async (v) => envSet.push(v), log: (l) => lines.push(l) });
  assert.equal(r.ok, false);
  assert.equal(envSet.length, 0);
  assert.equal(existsSync(join(home, ".claude", "settings.json")), false);
  assert.match(lines.join("\n"), /another tracker/);
});

test("installHook with env values hides the secret when the test event fails", async () => {
  const lines = [];
  const procEnv = {
    TRACKER_URL: "https://t.example.workers.dev/",
    TRACKER_CF_CLIENT_ID: "env-id.access",
    TRACKER_CF_CLIENT_SECRET: "env-secret-value-456",
  };
  const r = await installHook({
    root: hookRoot(),
    home: mkdtempSync(join(tmpdir(), "home-")),
    procEnv,
    setUserEnv: async () => {},
    runHook: async () => ({ code: 1, stdout: "", stderr: "boom env-secret-value-456" }),
    log: (l) => lines.push(l),
  });
  assert.equal(r.ok, false);
  assert.ok(!lines.join("\n").includes("env-secret-value-456"));
});

test("installHook with neither a stored token nor TRACKER_* variables explains both ways", async () => {
  const lines = [];
  const r = await installHook({
    root: hookRoot(),
    home: mkdtempSync(join(tmpdir(), "home-")),
    procEnv: {},
    setUserEnv: async () => {},
    log: (l) => lines.push(l),
  });
  assert.equal(r.ok, false);
  assert.match(lines.join("\n"), /npm run setup.*TRACKER_CF_CLIENT_ID/s);
});

// Runs the real hook script against a local server (or an unreachable port) and returns what it posted.
// The pending file goes to a temp state folder, never the real home folder.
function runHook(cwd, url, stateDir = mkdtempSync(join(tmpdir(), "hookstate-")), sessionId = "s1", args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(repo, "hooks", "tracker-session-end.mjs"), ...args], {
      env: {
        ...process.env,
        TRACKER_URL: url,
        TRACKER_CF_CLIENT_ID: "id",
        TRACKER_CF_CLIENT_SECRET: "s",
        TRACKER_HOOK_STATE_DIR: stateDir,
      },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("close", (code) => resolve(code));
    child.stdin.end(JSON.stringify({ session_id: sessionId, cwd, reason: "other" }));
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

// A server that answers each POST with the next [status, body] from `replies` (then 200) and records the bodies.
async function scripted(replies) {
  const posts = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      posts.push(JSON.parse(b));
      const [status, body] = replies.shift() ?? [200, { ok: true }];
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { posts, url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}
const conflict409 = (code) => [409, { error: "conflict", message: "refused", current: { code } }];

for (const code of ["GATE_LOCKED", "WP_DONE"])
  test(`hook retries a 409 ${code} once as a note`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "hookcwd-"));
    const stateDir = mkdtempSync(join(tmpdir(), "hookstate-"));
    const s = await scripted([conflict409(code)]);
    try {
      assert.equal(await runHook(dir, s.url, stateDir), 0);
      assert.equal(s.posts.length, 2);
      assert.equal(s.posts[0].note, undefined);
      assert.equal(s.posts[1].note, true);
      assert.equal(s.posts[1].session_id, "s1");
      assert.equal(existsSync(join(stateDir, "tracker-pending.json")), false);
    } finally {
      s.close();
    }
  });

test("hook budget: a slow server is waited for with --budget-ms, and kept for later without it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hookcwd-"));
  let taken = 0;
  const srv = createServer((req, res) => {
    req.resume();
    req.on("end", () => setTimeout(() => (taken++, res.writeHead(200).end('{"ok":true}')), 1500));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const slowState = mkdtempSync(join(tmpdir(), "hookstate-"));
    assert.equal(await runHook(dir, url, slowState, "s-default"), 0);
    assert.equal(JSON.parse(readFileSync(join(slowState, "tracker-pending.json"), "utf8"))[0].session_id, "s-default");
    const okState = mkdtempSync(join(tmpdir(), "hookstate-"));
    const t0 = Date.now();
    assert.equal(await runHook(dir, url, okState, "s-long", ["--budget-ms", "4000"]), 0);
    assert.ok(Date.now() - t0 < 4500, "stays within the budget");
    assert.equal(existsSync(join(okState, "tracker-pending.json")), false);
    assert.ok(taken >= 1, "the slow server answered the long-budget run");
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
});

test("hook does not retry other 409s", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hookcwd-"));
  const s = await scripted([conflict409("VERSION")]);
  try {
    assert.equal(await runHook(dir, s.url), 0);
    assert.equal(s.posts.length, 1);
  } finally {
    s.close();
  }
});

test("hook keeps a log the server did not take (5xx, unreachable) and resends it as a note on the next run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hookcwd-"));
  writeFileSync(join(dir, "session.md"), "# session");
  const stateDir = mkdtempSync(join(tmpdir(), "hookstate-"));
  const file = join(stateDir, "tracker-pending.json");
  // 409 → note retry → 503: kept
  const down = await scripted([conflict409("GATE_LOCKED"), [503, { error: "unavailable" }]]);
  try {
    assert.equal(await runHook(dir, down.url, stateDir, "s-lost"), 0);
  } finally {
    down.close();
  }
  let pending = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].session_id, "s-lost");
  assert.equal(pending[0].note, true);
  assert.equal(pending[0].context_files, undefined); // files are re-read on the next run
  // unreachable: kept as well
  assert.equal(await runHook(dir, "http://127.0.0.1:9", stateDir, "s-offline"), 0);
  pending = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(
    pending.map((e) => e.session_id),
    ["s-lost", "s-offline"],
  );
  // next run: the current log first, then the pending ones as notes without session_id
  const up = await scripted([]);
  try {
    assert.equal(await runHook(dir, up.url, stateDir, "s-now"), 0);
    assert.equal(up.posts[0].session_id, "s-now");
    const resent = up.posts.slice(1);
    assert.ok(resent.length >= 1, "at least one pending entry resent within the budget");
    for (const r of resent) (assert.equal(r.note, true), assert.equal(r.session_id, undefined));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).length, 2 - resent.length);
  } finally {
    up.close();
  }
});

test("T24: a 429 or an Access redirect keeps the log; credentials in an https remote are never sent or kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hookcwd-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://someone:tok-123@example.com/o/r.git"]);
  const stateDir = mkdtempSync(join(tmpdir(), "hookstate-"));
  const file = join(stateDir, "tracker-pending.json");
  const busy = await scripted([
    [429, { error: "rate_limited" }],
    [302, {}],
  ]);
  try {
    assert.equal(await runHook(dir, busy.url, stateDir, "s-429"), 0);
    assert.equal(await runHook(dir, busy.url, stateDir, "s-302"), 0);
  } finally {
    busy.close();
  }
  // (git has a 300 ms budget in the hook; under heavy load it may give no facts, then only the spool part is checked)
  for (const p of busy.posts) if (p.repo_url) assert.equal(p.repo_url, "https://example.com/o/r.git");
  const text = readFileSync(file, "utf8");
  assert.doesNotMatch(text, /tok-123/);
  assert.deepEqual(
    JSON.parse(text).map((e) => e.session_id),
    ["s-429", "s-302"],
  );
});
