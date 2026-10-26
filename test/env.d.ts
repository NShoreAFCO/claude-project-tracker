import type { D1Migration } from "@cloudflare/vitest-plugin";
import type { Env as WorkerEnv } from "../src/types";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

/** Injected by vitest.config.ts: SQL generated from instance.example/seed.json. */
declare global {
  const __EXAMPLE_SEED_SQL__: string;
}
