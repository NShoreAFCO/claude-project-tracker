// Node-side helper for vitest.config.ts (kept as .mjs so the Worker typecheck needs no Node types).
// The acceptance test seeds from the example seed, whatever instance/ is built: this runs the real seed
// generator on a temp root that holds only instance.example/seed.json and returns the SQL.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSeed } from "../seed/build-seed.mjs";

export function exampleSeedSql() {
  const root = mkdtempSync(join(tmpdir(), "tracker-example-seed-"));
  try {
    mkdirSync(join(root, "seed"));
    mkdirSync(join(root, "instance.example"));
    cpSync("instance.example/seed.json", join(root, "instance.example", "seed.json"));
    buildSeed(root);
    return readFileSync(join(root, "seed", "seed.sql"), "utf8");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
