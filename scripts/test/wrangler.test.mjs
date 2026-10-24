import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wranglerBin, wranglerRunner } from "../lib/wrangler.mjs";

// a stand-in for wrangler.js that reports what it received
function fakeRoot() {
  const r = mkdtempSync(join(tmpdir(), "wr space & co-"));
  const bin = join(r, "node_modules", "wrangler", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "wrangler.js"),
    `let input = ""; process.stdin.on("data", (d) => (input += d)); process.stdin.on("end", () =>
       console.log(JSON.stringify({ args: process.argv.slice(2), input, metrics: process.env.WRANGLER_SEND_METRICS, extra: process.env.EXTRA })));`,
  );
  return r;
}

test("wranglerBin points at the local wrangler.js", () => {
  assert.equal(wranglerBin("/x"), join("/x", "node_modules", "wrangler", "bin", "wrangler.js"));
});

test("wranglerRunner passes arguments unchanged, without a shell", async () => {
  const r = fakeRoot();
  const args = ["d1", "execute", "my db", "--command", 'SELECT "a" & 1; echo hi', "C:\\Users\\Jane Doe\\x.sql", "*"];
  const res = await wranglerRunner(r)(args, { input: "secret-value", env: { EXTRA: "1" } });
  assert.equal(res.code, 0, res.stderr);
  const got = JSON.parse(res.stdout);
  assert.deepEqual(got.args, args);
  assert.equal(got.input, "secret-value");
  assert.equal(got.metrics, "false");
  assert.equal(got.extra, "1");
  assert.doesNotMatch(res.stderr, /DEP0190/);
});

test("wranglerRunner reports a missing wrangler install plainly", async () => {
  const r = mkdtempSync(join(tmpdir(), "wr-none-"));
  const res = await wranglerRunner(r)(["--version"]);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /npm install/);
});
