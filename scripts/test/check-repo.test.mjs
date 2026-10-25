import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { migrationProblems, denylistHits, commitLogHits } from "../../tools/lib/repo-checks.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// The word is assembled here so it never appears literally in a tracked file outside tools/check-repo.mjs.
const WORD = "fixture-" + "label";
const DENY = /(^|[^a-z])fixture-denied-word/i;
const mem = (files) => (p) => {
  if (!(p in files)) throw new Error("ENOENT");
  return files[p];
};

test("contiguous migrations pass", () => {
  assert.deepEqual(migrationProblems(["0001_init.sql", "0002_readability.sql", "0003_x.sql"]), []);
  assert.deepEqual(migrationProblems(["0002_b.sql", "0001_a.sql"]), []);
});

test("gap in migrations fails", () => {
  const p = migrationProblems(["0001_init.sql", "0003_x.sql"]);
  assert.equal(p.length, 1);
  assert.match(p[0], /0002/);
});

test("migrations must start at 0001", () => {
  assert.ok(migrationProblems(["0002_b.sql"]).some((p) => p.includes("0001")));
});

test("duplicate migration number fails", () => {
  assert.ok(migrationProblems(["0001_a.sql", "0001_b.sql"]).some((p) => p.includes("duplicate")));
});

test("misnamed migration fails", () => {
  assert.ok(migrationProblems(["0001_a.sql", "notes.sql"]).some((p) => p.includes("notes.sql")));
});

test("denylisted word in .github fails", () => {
  const files = {
    ".github/workflows/ci.yml": "name: ci\njobs:\n  test:\n    name: fixture-denied-word\n",
    "README.md": "clean\n",
  };
  assert.deepEqual(denylistHits(Object.keys(files), mem(files), DENY), [".github/workflows/ci.yml:4"]);
});

test("denylist skips the file that holds the pattern and unreadable files", () => {
  const files = { "tools/check-repo.mjs": "fixture-denied-word" };
  assert.deepEqual(denylistHits(["tools/check-repo.mjs", "missing.txt"], mem(files), DENY, ["tools/check-repo.mjs"]), []);
});

test("the real denylist in check-repo.mjs catches the media-category label", () => {
  const src = readFileSync(join(root, "tools", "check-repo.mjs"), "utf8");
  const m = /const DENY = \/(.+)\/i;/.exec(src);
  assert.ok(m, "DENY not found");
  const deny = new RegExp(m[1], "i");
  const files = { ".github/workflows/ci.yml": `label: ${WORD}\n` };
  assert.deepEqual(denylistHits(Object.keys(files), mem(files), deny), [".github/workflows/ci.yml:1"]);
});

test("commit log: GitHub merge subjects are skipped, real content is not", () => {
  const log = [
    "Merge branch 'main' into fixture-denied-word-branch",
    "Merge pull request #7 from fixture-denied-word/feature",
    "feat: something fine",
    "chore: fixture-denied-word in a subject",
  ].join("\n");
  assert.deepEqual(commitLogHits(log, DENY), ["chore: fixture-denied-word in a subject"]);
});
