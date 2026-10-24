// Runs `npx wrangler <args>` with extra environment and optional stdin; returns { code, stdout, stderr }.
// Arguments are our own names and paths only; secret values are passed through stdin.
import { spawn } from "node:child_process";

export function wranglerRunner(root) {
  return (args, { input, env = {} } = {}) =>
    new Promise((resolve) => {
      const quoted = args.map((a) => (/[\s"*()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
      const child = spawn("npx", ["wrangler", ...quoted], {
        cwd: root,
        shell: true,
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
