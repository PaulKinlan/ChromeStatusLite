import type { D1Migration } from "@cloudflare/vitest-pool-workers/config";
import type { Env } from "../src/worker.ts";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}
