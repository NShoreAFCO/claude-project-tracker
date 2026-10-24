// Persists environment variables for the current user: setx on Windows, a managed block in ~/.zshrc or ~/.bashrc elsewhere.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

const BEGIN = "# project tracker hook (begin)";
const END = "# project tracker hook (end)";
const quote = (v) => `'${String(v).replace(/'/g, `'\''`)}'`;

export function profileBlock(existingText, vars) {
  const block = [BEGIN, ...Object.entries(vars).map(([k, v]) => `export ${k}=${quote(v)}`), END].join("\n");
  const lines = String(existingText ?? "").split("\n");
  const b = lines.indexOf(BEGIN);
  const e = lines.indexOf(END, b + 1);
  if (b !== -1 && e !== -1) return [...lines.slice(0, b), block, ...lines.slice(e + 1)].join("\n");
  const text = String(existingText ?? "");
  return text + (text && !text.endsWith("\n") ? "\n" : "") + block + "\n";
}

export async function setUserEnv(vars, { platform = process.platform, home = os.homedir(), shell = process.env.SHELL } = {}) {
  if (platform === "win32") {
    for (const [name, value] of Object.entries(vars)) {
      const r = spawnSync("setx", [name, value], { stdio: "ignore" });
      if (r.error || r.status !== 0) throw new Error(`Could not set the user environment variable ${name}.`);
    }
    return "user environment";
  }
  const file = join(home, String(shell ?? "").endsWith("zsh") ? ".zshrc" : ".bashrc");
  writeFileSync(file, profileBlock(existsSync(file) ? readFileSync(file, "utf8") : "", vars));
  return file;
}
