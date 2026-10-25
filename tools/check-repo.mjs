// Repo checks that are not runtime behaviour: no secrets in git, and the theme contract
// (app.css holds tokens only; the instance theme defines all of them with enough contrast).
// Usage: npm run check  (exit code 1 on any failure)
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadInstance } from "../scripts/lib/instance.mjs";
import { migrationProblems, denylistHits, commitLogHits } from "./lib/repo-checks.mjs";

const failures = [];
const ok = [];
const check = (name, pass, detail = "") => (pass ? ok : failures).push(detail ? `${name}: ${detail}` : name);
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

// ---- secrets
const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
check(".dev.vars is not tracked", !tracked.some((f) => /(^|\/)\.dev\.vars/.test(f)));
for (const f of [".gitignore", ".claudeignore"]) check(`${f} lists .dev.vars`, read(f).split("\n").includes(".dev.vars"));
const SECRET_PATTERNS = [
  [/ghp_[A-Za-z0-9]{30,}/, "GitHub classic token"],
  [/github_pat_[A-Za-z0-9_]{40,}/, "GitHub fine-grained token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/CF-Access-Client-Secret["']?\s*[:=]\s*["'][0-9a-f]{32,}/i, "Access service-token secret"],
  [/(COOKIE_ENCRYPTION_KEY|GITHUB_WEBHOOK_SECRET|AUDIT_GITHUB_TOKEN|ACCESS_CLIENT_SECRET)\s*=\s*["']?[0-9a-f]{32,}/i, "secret assignment"],
];
const textFiles = tracked.filter((f) => !/\.(webp|png|jpg|ico|lock)$/.test(f) && f !== "package-lock.json");
for (const f of textFiles) {
  let s;
  try {
    s = read(f);
  } catch {
    continue;
  }
  for (const [re, what] of SECRET_PATTERNS) if (re.test(s)) check("no secrets in tracked files", false, `${what} in ${f}`);
}
check("no secrets in tracked files", true, `${textFiles.length} files scanned`);

// ---- migrations are numbered contiguously from 0001, no gaps or duplicates
const migProblems = migrationProblems(readdirSync("migrations"));
check("migrations numbered contiguously from 0001", migProblems.length === 0, migProblems.join("; "));

// ---- theme contract (docs/THEMING.md): app.css uses tokens only; the instance theme defines them all
const CONTRACT = [
  "color-primary", "color-primary-strong", "color-on-primary", "color-accent", "color-accent-strong",
  "color-surface", "color-tint", "color-border", "color-text", "color-text-strong", "color-text-muted",
  "color-link", "color-danger",
  "status-active", "status-doing", "status-idea", "status-hold", "status-done", "status-dropped", "status-blocked", "status-waiting",
  "font", "font-heading", "font-size-base", "weight-heading", "heading-transform", "button-transform",
  "button-letter-spacing", "radius", "header-rule",
];
const css = read("public/app.css");
const { dir: instDir, config: inst } = loadInstance(".");
const theme = read(join(instDir, "theme.css"));

const hexInCss = [...new Set([...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]))];
check("app.css has no hex colours", hexInCss.length === 0, hexInCss.join(", "));
const localDefs = new Set([...css.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const used = [...new Set([...css.matchAll(/var\(--([a-z0-9-]+)/g)].map((m) => m[1]))];
const offContract = used.filter((v) => !CONTRACT.includes(v) && !localDefs.has(v) && !/^cat-[pw]-/.test(v) && v !== "stripe");
check("app.css uses only contract tokens", offContract.length === 0, offContract.join(", "));

const themeVars = Object.fromEntries([...theme.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const missing = CONTRACT.filter((k) => !(k in themeVars));
check("theme defines every contract token", missing.length === 0, missing.join(", "));
const hexOf = (name, seen = new Set()) => {
  const v = themeVars[name];
  if (!v || seen.has(name)) return null;
  const ref = /^var\(--([a-z0-9-]+)\)$/.exec(v);
  if (ref) return hexOf(ref[1], new Set([...seen, name]));
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
};

const lum = (hex) => {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** Each [fg, bg, min] pair must resolve to hex colours and reach the ratio. */
const pairCheck = (name, pairs) => {
  const weak = [];
  for (const [fg, bg, min] of pairs) {
    const [f, b] = [hexOf(fg), hexOf(bg)];
    if (!f || !b) weak.push(`${fg} on ${bg}: not a #rrggbb colour`);
    else if (contrast(f, b) < min - 0.02) weak.push(`${fg} on ${bg} ${contrast(f, b).toFixed(2)}:1 < ${min}:1`);
  }
  check(name, weak.length === 0, weak.join("; "));
};
const TEXT = ["color-text", "color-text-strong", "color-text-muted", "color-link", "color-primary-strong", "color-danger"];
pairCheck("text tokens ≥ 7:1 on surface", TEXT.map((t) => [t, "color-surface", 7]));
pairCheck("text tokens ≥ 7:1 on tint", ["color-text", "color-text-strong", "color-primary-strong"].map((t) => [t, "color-tint", 7]));
pairCheck("on-primary ≥ 7:1 on its fills", ["color-primary", "color-primary-strong", "color-danger", "color-text-strong"].map((b) => ["color-on-primary", b, 7]));
pairCheck("status marks ≥ 3:1 on surface", CONTRACT.filter((k) => k.startsWith("status-")).map((k) => [k, "color-surface", 3]));
const surface = hexOf("color-surface");
const weakCat = [...inst.categories.project, ...inst.categories.workpackage].filter((c) => surface && contrast(c.color.toLowerCase(), surface) < 3);
check("category colours ≥ 3:1 on surface", weakCat.length === 0, weakCat.map((c) => `${c.key} ${c.color}`).join(", "));
const catTextUse = [...css.matchAll(/(?:^|[\s;{])color:\s*var\(--cat-/g)].length;
check("category colours never used for text", catTextUse === 0, `${catTextUse} color: var(--cat-*) declarations`);
check("no italic text", !/font-style:\s*italic/.test(css));

// ---- identity: the neutral package carries no organisation, person or account names (checks.denylist)
if (inst.checks?.denylist !== false) {
  const DENY = /(?!)/i; // identity terms are kept out of the repository
  // this file holds the pattern itself; .github/** is core and scanned like every other tracked file
  const hits = denylistHits(textFiles, read, DENY, ["tools/check-repo.mjs"]);
  check("denylist: no identity in tracked files", hits.length === 0, hits.slice(0, 20).join(", "));
  let log = "";
  try {
    log = execFileSync("git", ["log", "--format=%s%n%b"], { encoding: "utf8" });
  } catch {}
  // GitHub writes "Merge pull request #N from <owner>/<branch>" and "Merge branch 'main' into <branch>" itself
  const logHits = commitLogHits(log, DENY);
  check("denylist: no identity in commit messages", logHits.length === 0, logHits.slice(0, 5).join(" | "));
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const ALLOWED_EMAIL = /@(example\.com|example\.org|users\.noreply\.github\.com)$/i;
  const badMail = [];
  for (const f of textFiles.filter((f) => f !== "package.json")) {
    let s;
    try {
      s = read(f);
    } catch {
      continue;
    }
    for (const m of s.matchAll(EMAIL)) if (!ALLOWED_EMAIL.test(m[0]) && m[0] !== "git@github.com" && !/@\d/.test(m[0])) badMail.push(`${f}: ${m[0]}`);
  }
  check("emails are example/noreply only", badMail.length === 0, [...new Set(badMail)].slice(0, 10).join(", "));
}
if (inst.upstream) check("instance/ is not tracked in the upstream repo", !tracked.some((f) => f.startsWith("instance/")));
for (const f of [".gitignore", ".claudeignore"]) check(`${f} lists secrets/`, read(f).split("\n").includes("secrets/"));

// dashboard formats dates and numbers only through i18n.js (locale from the instance config)
const hardLocale = tracked.filter((f) => /^public\/js\/.*\.js$/.test(f) && f !== "public/js/i18n.js" && /Intl\.[A-Za-z]+\(\s*["']/.test(read(f)));
check("no hard-coded Intl locale outside i18n.js", hardLocale.length === 0, hardLocale.join(", "));

// every `npm run <x>` named in the docs exists in package.json
const scripts = JSON.parse(read("package.json")).scripts;
const missingCmds = [];
for (const f of tracked.filter((f) => f.endsWith(".md")))
  for (const m of read(f).matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) if (!scripts[m[1]]) missingCmds.push(`${f}: npm run ${m[1]}`);
check("commands named in the docs exist", missingCmds.length === 0, [...new Set(missingCmds)].join(", "));

// no inline script/style in the HTML shell (CSP has no 'unsafe-inline')
const html = read("public/index.html");
check("index.html has no inline script or style", !/<script(?![^>]*\bsrc=)/i.test(html) && !/<style|style="/i.test(html));

for (const l of ok) console.log(`ok   ${l}`);
for (const l of failures) console.log(`FAIL ${l}`);
process.exit(failures.length ? 1 : 0);
