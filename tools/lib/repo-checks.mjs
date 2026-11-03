// Pure helpers for tools/check-repo.mjs, kept separate so they can be tested without a fixture repository.

/**
 * Migration file names must be NNNN_name.sql, numbered contiguously from 0001, no gaps, no duplicates.
 * @param {string[]} names file names inside migrations/
 * @returns {string[]} problems (empty when fine)
 */
export function migrationProblems(names) {
  const problems = [];
  const nums = [];
  for (const n of names.filter((n) => n.endsWith(".sql"))) {
    const m = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(n);
    if (!m) problems.push(`${n}: name must look like 0001_name.sql`);
    else nums.push(Number(m[1]));
  }
  nums.sort((a, b) => a - b);
  const seen = new Set();
  for (const n of nums) {
    if (seen.has(n)) problems.push(`duplicate number ${String(n).padStart(4, "0")}`);
    seen.add(n);
  }
  const max = nums.length ? nums[nums.length - 1] : 0;
  for (let i = 1; i <= max; i++) if (!seen.has(i)) problems.push(`gap: ${String(i).padStart(4, "0")} is missing`);
  return problems;
}

/**
 * Builds the identity denylist. The terms are kept out of the repository: they come from the
 * IDENTITY_DENYLIST environment variable (a CI secret) or, locally, from an untracked `.denylist` file.
 * One regular-expression fragment per line; blank lines and lines starting with `#` are ignored.
 * @param {string | undefined} envValue value of IDENTITY_DENYLIST
 * @param {string | null} fileText contents of `.denylist`, or null when there is none
 * @returns {RegExp | null} case-insensitive pattern, or null when no terms are configured
 */
export function loadDenylist(envValue, fileText) {
  const text = envValue && envValue.trim() ? envValue : (fileText ?? "");
  const terms = text
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter((t) => t && !t.startsWith("#"));
  return terms.length ? new RegExp(terms.join("|"), "i") : null;
}

/**
 * `owner/name` of the published repository, from package.json `repository` (string or { url }).
 * @returns {string | null}
 */
export function ownRepoSlug(pkg) {
  const url = typeof pkg?.repository === "string" ? pkg.repository : pkg?.repository?.url;
  const m = url && /github\.com[/:]([^/\s]+\/[^/\s#]+?)(?:\.git)?(?:#.*)?$/i.exec(url);
  return m ? m[1] : null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Lines of text files matching the denylist, as "path:line". Unreadable files are skipped.
 * @param {string[]} files tracked paths to scan
 * @param {(path: string) => string} read returns the file text (throws when unreadable)
 * @param {RegExp} deny
 * @param {string[]} [skip] paths not to scan
 * @param {string[]} [allow] literal strings removed from each line before matching (the repo's own address)
 */
export function denylistHits(files, read, deny, skip = [], allow = []) {
  const allowRe = allow.length ? new RegExp(allow.map(escapeRe).join("|"), "gi") : null;
  const hits = [];
  for (const f of files.filter((f) => !skip.includes(f))) {
    let s;
    try {
      s = read(f);
    } catch {
      continue;
    }
    s.split("\n").forEach((line, i) => deny.test(allowRe ? line.replace(allowRe, "") : line) && hits.push(`${f}:${i + 1}`));
  }
  return hits;
}

/**
 * Commit-message lines (from `git log --format=%s%n%b`) that match the denylist.
 * Skips subjects GitHub writes itself: "Merge pull request #N from <owner>/<branch>" (the owner is the
 * hosting account) and "Merge branch 'main' into <branch>" (the branch-update button).
 */
export function commitLogHits(log, deny, ownSlug = null) {
  // GitHub adds "Co-authored-by: <login> <id+login@users.noreply.github.com>" for the repo owner on squash
  // merges; the owner login is already public in the repo slug, so exactly that trailer is skipped
  const owner = ownSlug ? ownSlug.split("/")[0] : null;
  const ownerTrailer = owner
    ? new RegExp(`^Co-authored-by: ${escapeRe(owner)} <\\d+\\+${escapeRe(owner)}@users\\.noreply\\.github\\.com>$`, "i")
    : null;
  return log
    .split("\n")
    .filter((l) => !/^Merge branch '[^']+' into \S+$/.test(l))
    .filter((l) => !(ownerTrailer && ownerTrailer.test(l.trim())))
    .filter((l) => deny.test(l.replace(/^Merge pull request #\d+ from [^/\s]+\//, "")));
}

export const UNDERLAY_TOKENS = ["underlay-wp", "underlay-milestone", "underlay-gate"];

const channel = (hex, i) => {
  const v = parseInt(hex.slice(i, i + 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);

/** Problems of the underlay tokens in a parsed theme ({ name: value }): missing, not #rrggbb, or --color-text-strong below 7:1. */
export function underlayProblems(vars, min = 7) {
  const fg = vars["color-text-strong"];
  const hexRe = /^#[0-9a-fA-F]{6}$/;
  const problems = [];
  for (const k of UNDERLAY_TOKENS) {
    const bg = vars[k];
    if (bg === undefined) problems.push(`${k}: missing`);
    else if (!hexRe.test(bg) || !hexRe.test(fg ?? "")) problems.push(`${k}: not a #rrggbb colour`);
    else {
      const [x, y] = [luminance(fg), luminance(bg)].sort((p, q) => q - p);
      const ratio = (x + 0.05) / (y + 0.05);
      if (ratio < min - 0.02) problems.push(`${k}: text-strong ${ratio.toFixed(2)}:1 < ${min}:1`);
    }
  }
  return problems;
}
