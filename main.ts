import { createHandler } from "./src/handler.ts";

// Import-safe entrypoint: importing this module must not bind a port, so the
// fixture-backed smoke suite can load it on every gate (chrome-status-lite-74e).
export function main(port = Number(Deno.env.get("PORT")) || 8000) {
  // Deno Deploy injects PORT; local development defaults to 8000.
  return Deno.serve({ port }, createHandler());
}

if (import.meta.main) main();
