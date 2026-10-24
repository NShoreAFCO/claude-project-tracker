// Runs the project's own wrangler with extra environment and optional stdin; returns { code, stdout, stderr }.
// Node starts wrangler.js directly (no shell), so arguments arrive unchanged; secret values are passed through stdin.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const wranglerBin = (root) => join(root, "node_modules", "wrangler", "bin", "wrangler.js");

export const MISSING_WRANGLER = "wrangler is not installed in this folder. Run npm install, then try again.";

export function wranglerRunner(root) {
  return (args, { input, env = {} } = {}) =>
    new Promise((resolve) => {
      const bin = wranglerBin(root);
      if (!existsSync(bin)) return resolve({ code: 1, stdout: "", stderr: MISSING_WRANGLER });
      const child = spawn(process.execPath, [bin, ...args], {
        cwd: root,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false", ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.on("error", (e) => resolve({ code: 1, stdout, stderr: String(e.message) }));
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    });
}
