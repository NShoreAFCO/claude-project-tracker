// --status-late must stay overridable by a theme: no :root default in app.css, the fallback sits at the point of use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const css = read("public/app.css");
const gantt = read("public/js/gantt.js");

test("--status-late has no default in app.css, so a theme value wins", () => {
  assert.doesNotMatch(css, /^\s*--status-late\s*:/m);
});

test("--status-late is always used with a fallback", () => {
  for (const src of [css, gantt]) {
    assert.doesNotMatch(src, /var\(--status-late\)/);
    assert.match(src, /var\(--status-late, var\(--status-blocked/);
  }
});

test("the Gantt legend has a late entry in both locales", () => {
  assert.match(gantt, /legend-late/);
  assert.match(read("public/js/locales/en.js"), /ganttLegendLate:/);
  assert.match(read("public/js/locales/de.js"), /ganttLegendLate:/);
});
