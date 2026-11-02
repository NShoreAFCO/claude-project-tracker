import { test } from "node:test";
import assert from "node:assert/strict";
import { migrationProblems, denylistHits, commitLogHits, loadDenylist, ownRepoSlug } from "../../tools/lib/repo-checks.mjs";

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

test("denylist skips listed and unreadable files", () => {
  const files = { "skipped.txt": "fixture-denied-word" };
  assert.deepEqual(denylistHits(["skipped.txt", "missing.txt"], mem(files), DENY, ["skipped.txt"]), []);
});

test("denylist ignores the repo's own address but not the word elsewhere", () => {
  const deny = /fixture-owner/i;
  const files = { "docs/INSTALL.md": "gh repo fork Fixture-Owner/claude-project-tracker\nfixture-owner elsewhere\n" };
  assert.deepEqual(denylistHits(Object.keys(files), mem(files), deny, [], ["fixture-owner/claude-project-tracker"]), ["docs/INSTALL.md:2"]);
});

test("loadDenylist: environment first, then file; comments, blanks and commas inside a fragment", () => {
  assert.equal(loadDenylist(undefined, null), null);
  assert.equal(loadDenylist("  ", "# only a comment, with a comma\n\n"), null);
  const fromFile = loadDenylist(undefined, "# comment, with a comma\n(^|[^a-z])fixture-a\r\nb{1,2}c\n");
  assert.equal(fromFile.source, "(^|[^a-z])fixture-a|b{1,2}c");
  assert.ok(fromFile.test("FIXTURE-A") && !fromFile.test("xfixture-a") && fromFile.test("abbc"));
  assert.equal(loadDenylist("fixture-env", "fixture-file").source, "fixture-env");
});

test("ownRepoSlug reads package.json repository", () => {
  assert.equal(
    ownRepoSlug({ repository: { type: "git", url: "git+https://github.com/some-owner/some-repo.git" } }),
    "some-owner/some-repo",
  );
  assert.equal(ownRepoSlug({ repository: "https://github.com/some-owner/some-repo" }), "some-owner/some-repo");
  assert.equal(ownRepoSlug({}), null);
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
