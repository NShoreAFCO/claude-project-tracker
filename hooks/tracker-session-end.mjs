#!/usr/bin/env node
// Claude Code SessionEnd hook → project tracker (SPEC §10). No dependencies; Windows-safe; always exits 0.
//
// Reads the hook JSON from stdin (session_id, cwd, reason), collects git facts for cwd, attaches the host name and <cwd>/session.md
// and <cwd>/HANDOFF.md (each ≤ 256 KB) and POSTs to ${TRACKER_URL}/api/hooks/claude-code with the Access service-token headers.
// SessionEnd hooks share a ~1.5 s budget, so every step has a deadline. Set TRACKER_DEBUG=1 to see errors on stderr.
// A 409 GATE_LOCKED / WP_DONE is retried once as a note. A log the server could not take (network error, 5xx, 429) is kept
// in a pending file in the hook's state folder (TRACKER_HOOK_STATE_DIR, default ~/.claude/hooks) and resent on a later run.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

const started = Date.now();
const elapsed = () => Date.now() - started;
const debug = process.env.TRACKER_DEBUG === "1";
const log = (...a) => debug && console.error("[tracker-hook]", ...a);

const BUDGET_MS = 750; // incl. ~150 ms node start-up this keeps the hook under 1 s (Claude Code allows ~1.5 s)
const GIT_TIMEOUT_MS = 300;
const GIT_PHASE_MS = 600; // no new git call after this point
const FETCH_MAX_MS = 800;
const MAX_CONTEXT_BYTES = 256 * 1024;
const PENDING_MAX = 50; // oldest entries beyond this are dropped
const RESEND_MIN_MS = 200; // resend a pending entry only with at least this much budget left

function readStdin(timeoutMs) {
  return new Promise((done) => {
    if (process.stdin.isTTY) return done("");
    let data = "";
    const timer = setTimeout(() => done(data), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => (clearTimeout(timer), done(data)));
    process.stdin.on("error", () => (clearTimeout(timer), done(data)));
  });
}

/** git -C cwd ...args → trimmed stdout, or null on error/timeout/over budget. */
function git(cwd, args) {
  if (elapsed() > GIT_PHASE_MS) return null;
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  } catch (e) {
    log("git", args.join(" "), "failed:", e.code || e.message);
    return null;
  }
}

function gitFacts(cwd) {
  // one call for branch + both git dirs; a failure here means "not a repo" → skip the rest
  const rp = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD", "--absolute-git-dir", "--git-common-dir"]);
  if (!rp) return {};
  const [branch, gitDir, commonDir] = rp.split(/\r?\n/);
  const worktree = !!gitDir && !!commonDir && resolve(gitDir).toLowerCase() !== resolve(cwd, commonDir).toLowerCase();
  // Credentials in an https remote (https://user:token@host/...) are never sent or kept in the pending file.
  const repo_url = git(cwd, ["config", "--get", "remote.origin.url"])?.replace(/^(https?:\/\/)[^@/]*@/i, "$1");
  const last_commit = git(cwd, ["log", "-1", "--format=%h %s"]);
  // "origin/main" → "main"; absent without a remote (the server then treats main/master as default)
  const originHead = repo_url ? git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) : null;
  return {
    branch: branch && branch !== "HEAD" ? branch : null,
    worktree,
    repo_url: repo_url || null,
    last_commit: last_commit || null,
    default_branch: originHead ? originHead.replace(/^origin\//, "") : null,
  };
}

/** <cwd>/<name> as {name, content}; null when missing, unreadable or over 256 KB. */
function contextFile(cwd, name) {
  const file = join(cwd, name);
  try {
    if (statSync(file).size > MAX_CONTEXT_BYTES) return null;
    return { name, content: readFileSync(file, "utf8") };
  } catch {
    return null;
  }
}

function hostName() {
  try {
    return hostname().trim().slice(0, 64) || null; // the server accepts up to 100; 64 is the Linux HOST_NAME_MAX
  } catch {
    return null;
  }
}

async function main() {
  const { TRACKER_URL, TRACKER_CF_CLIENT_ID, TRACKER_CF_CLIENT_SECRET } = process.env;
  if (!TRACKER_URL || !TRACKER_CF_CLIENT_ID || !TRACKER_CF_CLIENT_SECRET)
    return log("TRACKER_URL / TRACKER_CF_CLIENT_ID / TRACKER_CF_CLIENT_SECRET not set");

  let input = {};
  try {
    input = JSON.parse((await readStdin(200)) || "{}");
  } catch {
    log("stdin is not JSON");
  }
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();

  const body = {
    session_id: input.session_id ?? null,
    cwd,
    reason: input.reason ?? null,
    ...gitFacts(cwd),
  };
  const host = hostName();
  if (host) body.host = host;
  const files = ["session.md", "HANDOFF.md"].map((n) => contextFile(cwd, n)).filter(Boolean);
  if (files.length) body.context_files = files;

  const base = TRACKER_URL.replace(/\/+$/, "");
  const headers = { "CF-Access-Client-Id": TRACKER_CF_CLIENT_ID, "CF-Access-Client-Secret": TRACKER_CF_CLIENT_SECRET };
  const pending = readPending();
  let res = await post(base, headers, body);
  // A log the rules refuse (gate-locked or done work package) is kept as a note instead.
  if (res.status === 409 && ["GATE_LOCKED", "WP_DONE"].includes(res.code)) res = await post(base, headers, { ...body, note: true });
  // Not taken for now (network error, timeout, 5xx, rate limit, Access refused the token): keep it for a later
  // run, without the files (they are re-read then). Only a refusal by the tracker's rules (other 4xx) drops a log.
  if (!res.ok && transient(res.status)) {
    const { context_files, ...entry } = body;
    pending.push({ ...entry, note: true });
    return writePending(pending);
  }
  // Server reachable: resend the oldest pending entry while the budget allows. Without session_id, so the
  // project keeps the current session; as a note, so it changes no work package.
  let changed = false;
  while (res.ok && pending.length && BUDGET_MS - elapsed() >= RESEND_MIN_MS) {
    const { session_id, ...old } = pending[0];
    res = await post(base, headers, { ...old, note: true });
    if (res.ok || !transient(res.status)) (pending.shift(), (changed = true)); // other 4xx: will never be taken
  }
  if (changed) writePending(pending);
}

/** No response, a redirect (Access login), 401/403 (token refused), 408, 429 or 5xx: worth sending again later. */
const transient = (status) => status === 0 || (status >= 300 && status < 400) || [401, 403, 408, 429].includes(status) || status >= 500;

/** POST one hook body → {ok, status (0 = no response), code (409 current.code)}. */
async function post(base, headers, body) {
  try {
    const res = await fetch(`${base}/api/hooks/claude-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(100, Math.min(FETCH_MAX_MS, BUDGET_MS - elapsed()))),
      redirect: "manual", // an Access login redirect means the service token was rejected
    });
    log("POST", res.status, `${elapsed()} ms`);
    const text = await res.text().catch(() => ""); // drain the body so the socket is released before exit
    if (debug) log(text);
    let code = null;
    try {
      code = JSON.parse(text)?.current?.code ?? null;
    } catch {}
    return { ok: res.ok, status: res.status, code };
  } catch (e) {
    log("POST failed:", e?.name || "", e?.message || e);
    return { ok: false, status: 0, code: null };
  }
}

function pendingFile() {
  return join(process.env.TRACKER_HOOK_STATE_DIR || join(homedir(), ".claude", "hooks"), "tracker-pending.json");
}
function readPending() {
  try {
    const list = JSON.parse(readFileSync(pendingFile(), "utf8"));
    return Array.isArray(list) ? list.filter((e) => e && typeof e === "object") : [];
  } catch {
    return [];
  }
}
function writePending(list) {
  try {
    const file = pendingFile();
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(list.slice(-PENDING_MAX)));
  } catch (e) {
    log("pending file not written:", e?.message || e);
  }
}

// No process.exit() on the normal path: on Windows, exiting while undici is still closing its TLS socket aborts
// node with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)". Let the event loop drain instead; the
// unref'd timer is only a fallback if something keeps the process alive.
setTimeout(() => process.exit(0), 1200).unref();
main()
  .catch((e) => log("failed:", e?.name || "", e?.message || e))
  .finally(() => {
    process.exitCode = 0;
    process.stdin.destroy();
  });
