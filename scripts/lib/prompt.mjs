// Terminal questions for the setup scripts. Secret input is masked and never echoed.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const std = () => ({ input: process.stdin, output: process.stdout });

/** Ask a question; Enter returns the default. */
export async function ask(question, def = "", { input, output } = std()) {
  const rl = createInterface({ input, output });
  try {
    const answer = await new Promise((res) => rl.question(def ? `${question} [${def}] ` : `${question} `, res));
    return answer.trim() || def;
  } finally {
    rl.close();
  }
}

/** Yes/no question. */
export async function confirm(question, def = false, io = std()) {
  const a = await ask(`${question} (${def ? "Y/n" : "y/N"})`, "", io);
  return a ? /^y(es)?$/i.test(a) || /^j(a)?$/i.test(a) : def;
}

/**
 * Read a secret without showing it: each character prints as "*". Refuses to run without an interactive
 * terminal, so a secret is never read from a pipe or an AI tool's shell by accident.
 */
export function askSecret(question, { input, output } = std()) {
  if (!input.isTTY || typeof input.setRawMode !== "function")
    return Promise.reject(
      new Error(
        "Secret input needs an interactive terminal. Run this command yourself in a terminal window (not through an AI assistant).",
      ),
    );
  return new Promise((res, rej) => {
    let value = "";
    output.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const done = (fn) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      output.write("\n");
      fn();
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done(() => res(value.trim()));
        if (ch === "\u0003") return done(() => rej(new Error("Cancelled.")));
        if (ch === "\u007f" || ch === "\b") {
          if (value.length) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
        } else if (ch >= " ") {
          value += ch;
          output.write("*");
        }
      }
    };
    input.on("data", onData);
  });
}

/** Open a URL in the default browser (best effort). */
export async function openUrl(url) {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* the URL is printed as well */
  }
}

export const terminalIo = { ask: (q, d) => ask(q, d), askSecret: (q) => askSecret(q), confirm: (q, d) => confirm(q, d), openUrl };

// `node scripts/lib/prompt.mjs --selftest`: checks that masked input works in this terminal.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes("--selftest")) {
  askSecret("Type any test text and press Enter (it must show as *): ").then(
    (v) =>
      console.log(`Received ${v.length} characters. If the text you typed is visible anywhere above, use a separate terminal for setup.`),
    (e) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}
