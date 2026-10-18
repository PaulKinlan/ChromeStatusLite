import { createHandler } from "./src/handler.ts";
import { KvSnapshotStore } from "./src/lib/snapshots.ts";

// Snapshot history via Deno KV (GA on Deno Deploy). openKv is lazy: a KV
// failure surfaces on first use and the history routes degrade to a notice.
function snapshotStore() {
  try {
    return new KvSnapshotStore();
  } catch {
    return null;
  }
}

// Import-safe entrypoint: importing this module must not bind a port, so the
// fixture-backed smoke suite can load it on every gate (chrome-status-lite-74e).
export function main(port = Number(Deno.env.get("PORT")) || 8000) {
  // Deno Deploy injects PORT; local development defaults to 8000.
  return Deno.serve({ port }, createHandler(undefined, undefined, snapshotStore()));
}

if (import.meta.main) main();
