import { createHandler } from "./src/handler.ts";

// Deno Deploy injects PORT; local development defaults to 8000.
const port = Number(Deno.env.get("PORT")) || 8000;
Deno.serve({ port }, createHandler());
