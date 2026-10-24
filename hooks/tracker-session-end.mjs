#!/usr/bin/env node
// Claude Code SessionEnd hook → project tracker (SPEC §10). No dependencies; Windows-safe; always exits 0.
//
// Reads the hook JSON from stdin (session_id, cwd, reason), collects git facts for cwd, attaches <cwd>/session.md
// (≤ 256 KB) and POSTs to ${TRACKER_URL}/api/hooks/claude-code with the Access service-token headers.
// SessionEnd hooks share a ~1.5 s budget, so every step has a deadline. Set TRACKER_DEBUG=1 to see errors on stderr.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
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
  const repo_url = git(cwd, ["config", "--get", "remote.origin.url"]);
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

function sessionFile(cwd) {
  const file = join(cwd, "session.md");
  try {
    if (statSync(file).size > MAX_CONTEXT_BYTES) return null;
    return { name: "session.md", content: readFileSync(file, "utf8") };
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
  const ctx = sessionFile(cwd);
  if (ctx) body.context_file = ctx;

  const timeout = Math.max(100, Math.min(FETCH_MAX_MS, BUDGET_MS - elapsed()));
  const res = await fetch(`${TRACKER_URL.replace(/\/+$/, "")}/api/hooks/claude-code`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Access-Client-Id": TRACKER_CF_CLIENT_ID,
      "CF-Access-Client-Secret": TRACKER_CF_CLIENT_SECRET,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
    redirect: "manual", // an Access login redirect means the service token was rejected
  });
  log("POST", res.status, `${elapsed()} ms`);
  const text = await res.text().catch(() => ""); // drain the body so the socket is released before exit
  if (debug) log(text);
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
