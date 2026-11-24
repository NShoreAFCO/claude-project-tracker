// Work package tree indent guides: every line of a sub-package or task row sits right of its guides, and dependency
// lists read "WP1, WP2". Static checks on app.css (the vitest fake DOM has no layout and blanks CSS imports).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const css = readFileSync(join(root, "public/app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const narrowAt = css.indexOf("@container (max-width: 720px)");

/** Declarations of every rule at or after `from` whose selector list contains `selector`, joined. */
function rule(selector, from = 0, to = css.length) {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  re.lastIndex = from;
  const out = [];
  for (let m = re.exec(css); m && m.index < to; m = re.exec(css)) {
    if (m[1].split(",").map((s) => s.trim()).includes(selector)) out.push(m[2]);
  }
  return out.join("\n");
}
const wide = (sel) => rule(sel, 0, narrowAt);
const narrow = (sel) => rule(sel, narrowAt);

test("each nested tier sets one indent that its title and the line below both use", () => {
  assert.match(wide(".tw-row.tier-2"), /--tw-ind:\s*18px/);
  assert.match(wide(".tw-row.tier-3"), /--tw-ind:\s*36px/);
  assert.match(wide(".tw-ttl"), /padding-left:\s*var\(--tw-ind,\s*0px\)/);
  assert.match(wide(".tw-below"), /padding-left:\s*var\(--tw-ind,\s*0px\)/);
});

test("the guides sit inside that indent (tier 2 at +6 px of 18, tier 3 at +6 and +24 px of 36)", () => {
  assert.match(wide(".tw-row.tier-2"), /background-position:\s*calc\(var\(--tw-x\) \+ 6px\) 0/);
  assert.match(wide(".tw-row.tier-3"), /calc\(var\(--tw-x\) \+ 24px\) 0/);
});

test("narrow: the guide origin moves with the title column, on the rows (a container query cannot style its container)", () => {
  assert.ok(narrowAt > 0, "container query present");
  assert.match(narrow(".tw-row"), /--tw-x:\s*122px/);
  assert.doesNotMatch(narrow(".tw-tree"), /--tw-x/);
});

test("narrow: nested rows start dates, progress and the line below at the indented title", () => {
  assert.match(narrow(".tw-row.tier-2"), /--tw-ind:\s*12px/);
  assert.match(narrow(".tw-row.tier-3"), /--tw-ind:\s*24px/);
  for (const tier of ["tier-2", "tier-3"]) {
    const dt = narrow(`.${tier} .tw-dt`);
    assert.match(dt, /grid-column:\s*ttl \/ st/, `${tier} dates`);
    assert.match(dt, /padding-left:\s*var\(--tw-ind\)/, `${tier} dates`);
    for (const part of ["tw-pct", "tw-below"]) {
      const r = narrow(`.${tier} .${part}`);
      assert.match(r, /grid-column:\s*ttl \/ -1/, `${tier} ${part}`);
      assert.match(r, /padding-left:\s*var\(--tw-ind\)/, `${tier} ${part}`);
    }
  }
});

test("the dependency line is a text line, so each comma follows its code", () => {
  assert.match(rule(".tw-row .dep-line"), /display:\s*block/);
});
