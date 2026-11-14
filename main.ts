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
// The hostname parameter exists for the deploy-wiring test
// (chrome-status-lite-knek): the smoke gate's sandbox is loopback-only
// (--allow-net=127.0.0.1) and Deno.serve's 0.0.0.0 default would be rejected
// there, so the suite binds main() to 127.0.0.1 explicitly. Production keeps
// the default: Deno Deploy injects PORT and expects a wildcard listener.
export function main(
  port = Number(Deno.env.get("PORT")) || 8000,
  hostname = "0.0.0.0",
) {
  return Deno.serve(
    { port, hostname },
    createHandler(undefined, undefined, snapshotStore()),
  );
}

if (import.meta.main) main();
