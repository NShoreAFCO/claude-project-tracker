import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderWrangler } from "../lib/instance.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const example = JSON.parse(readFileSync(join(root, "instance.example", "instance.config.json"), "utf8"));
const clone = (o) => JSON.parse(JSON.stringify(o));
const tpl = readFileSync(join(root, "wrangler.template.jsonc"), "utf8");

test("renderWrangler declares the BROWSER binding by default", () => {
  assert.match(renderWrangler(tpl, clone(example)), /"binding": "BROWSER"/);
});

test("renderWrangler omits the BROWSER binding when policy.report.pdf is false", () => {
  const c = clone(example);
  c.policy = { ...(c.policy ?? {}), report: { paper: "a4", pdf: false } };
  const out = renderWrangler(tpl, c);
  assert.doesNotMatch(out, /BROWSER/);
  assert.doesNotMatch(out, /@browser-/);
  assert.match(out, /"triggers"/);
});
