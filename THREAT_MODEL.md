# ChromeStatusLite threat model

This is the review rubric for the current source, not a claim that every abuse case is eliminated. Re-check the cited paths when routes, dependencies, or deployment change.

## 1. System and architecture

A public, read-only Cloudflare Workers site serves Chrome feature pages, wiki topics, diffs, RSS, and a JSON milestone API with zero third-party runtime dependencies. `src/worker.ts` exports the Cloudflare `fetch` and `scheduled` handlers; `src/handler.ts` routes requests and serves an explicit allowlist of static assets via `env.ASSETS` (`run_worker_first: true`). `src/lib/utils.ts` fetches ChromeStatus API JSON from a fixed `https://chromestatus.com` origin and optional Baseline metadata from a fixed `https://api.webstatus.dev` origin, combining an isolate-local plain-JSON L1 `TTLCache` with Cloudflare's L2 `caches.default` (while keeping in-flight singleflight Promises strictly request-scoped). `src/lib/wiki-data.ts` assembles paginated search results and caches them in Cloudflare D1 (`wiki_topic_cache`), refreshed incrementally by a Cron Trigger. Viewing a feature lazily records a slim snapshot in D1 (`src/routes/feature.ts`, `src/lib/snapshots.ts`) via `ctx.waitUntil()`; history and diffs read that store. HTML is streamed by `src/flora.ts`.

## 2. Actors and trust boundaries

- The site operator controls deployed source, static files, D1 database, and Cloudflare configuration; maintainers and dev/build tooling are privileged. Local test fixtures are not public endpoints.
- Anonymous visitors control HTTP method, path, and query strings. They can trigger upstream fetches and **indirect D1 writes**: GET `/feature/:id` can capture snapshots, GET `/feature/:id/history` and `/feature/:id/diff` can refresh durable D1 recency markers, and cold `/wiki` / `/wiki/:topic` misses can populate bounded D1 wiki cache rows. There is no user-facing write API; HEAD skips snapshot/recency writes. `/api/version/:version` deliberately allows cross-origin reads (`Access-Control-Allow-Origin: *`).
- ChromeStatus API and WebStatus API responses are external data, **not trusted HTML or URLs**. They cross the network boundary into cache, templates, feed/XML, and D1 tables. Third-party links in that data lead visitors off-site. No user login, secrets API, browser extension IPC, or MCP server is implemented here.

## 3. Explicitly trusted (non-threats)

- Source-controlled static markup/assets, the route table, D1 migrations, and operator-controlled Wrangler/Cloudflare configuration are trusted unless a separate repository or account compromise is in scope. Fixture clients in `tests/` are test data, not independently reachable attackers.
- A read-only `GET`/`HEAD` API and public CORS on `/api/version/:version` are intentional: do not report missing authentication or wildcard CORS alone.
- The `assets`, `store`, and `wikiStore` options of `createHandler` are trusted deployment/test seams, not user-supplied inputs.

## 4. Untrusted surfaces and existing controls

- **Inbound HTTP:** `src/handler.ts` admits GET/HEAD plus OPTIONS on the JSON API, redirects legacy Deno hostnames (and optionally `*.workers.dev` / `*.pages.dev`) to `https://chromestatuslite.com`, and restricts static paths to an explicit allowlist regex (including `/llms.txt`, `/robots.txt`, `/favicon.svg`, `/speculation-rules.json`, and site verification HTML) before forwarding to `env.ASSETS`. HTML routes advertise `Vary: Accept` and convert to `text/markdown; charset=utf-8` via `src/lib/markdown.ts` (O(n) single-pass HTML tokenizer, no regex ReDoS, never converting static verification HTML or non-HTML endpoints); `src/worker.ts` keys Cloudflare `caches.default` separately for HTML vs Markdown. With `assets.run_worker_first: true`, all responses — including static assets, redirects, 404s, 405s, 429s, and caught route errors — pass through the total CSP/nosniff/referrer/frame header gate. Error responses always emit `Cache-Control: no-store` so Cloudflare edge cache never caches transient outages.
- **Upstream APIs:** `src/lib/utils.ts` builds requests against fixed origins (`https://chromestatus.com` and `https://api.webstatus.dev`), validates feature IDs (1–16 digits), milestone integers (`[1, 2000]`), and `web_feature` slugs (`^[a-z0-9][a-z0-9-]{0,127}$`), limits fetch time and body bytes, strips the upstream XSSI prefix, coalesces in-flight requests within a request without sharing I/O Promises across requests, caches positive responses in L1 + L2 `caches.default`, negative-caches brief retryable failures, and budgets uncached `/feature/:id` lookups. `src/lib/wiki-data.ts` caps pagination, continuation concurrency, and cold D1 fallback breadth.
- **HTML, CSS, and links:** `src/flora.ts` escapes interpolated values by default (including custom-`toString` objects); `raw()` is the explicit opt-out. `src/lib/url.ts` admits only parsed, serialized HTTP(S) hrefs for upstream links; `src/lib/linkify.ts` builds escaped markup from prose. `src/routes/feed.ts` escapes XML and filters XML-1.0-illegal codepoints. Speculation Rules are served via the `Speculation-Rules` HTTP header pointing to static `/speculation-rules.json` (excluding `/feature/*`, `/api/*`, and `/feed.xml`) with zero `<script>` tags in HTML so `default-src 'self'` remains unbroken.
- **Persistent state (Cloudflare D1):** `src/lib/snapshots.ts` stores read-triggered snapshots in SQLite (`feature_index`, `feature_snapshots`) using parameterized queries, per-feature retention trimming (`MAX_SNAPSHOTS_PER_FEATURE = 25`), indexed O(log N) LRU eviction (`MAX_TRACKED_FEATURES = 5000`), atomic `db.batch()` cap enforcement preventing orphan rows under concurrent bursts, and 24-hour SQL-enforced recency throttling. `src/routes/feature-history.ts` reads snapshots and refreshes recency on GET only; HEAD skips both capture and touch. Store errors degrade gracefully to an uncached notice.

## 5. Historical bug shapes to retest

- Escaping/link safety: `src/flora.ts` escapes strings and object `toString` by default; `src/lib/url.ts` validates serialized HTTP(S) URLs. Check every new template interpolation, `raw()` call, and upstream-derived href.
- Work amplification & Workers limits: `src/lib/utils.ts` bounds timeouts, body bytes, negative caching, feature fetch budget, and numeric parameters; `src/lib/wiki-data.ts` bounds pagination, continuation concurrency, and cold D1 fallbacks; `src/worker.ts` avoids cross-request I/O promise sharing and caches read-only responses without caching `no-store` errors.
- Stateful GET and failure paths: `src/lib/snapshots.ts` enforces atomic D1 retention caps; `src/handler.ts` enforces the total security-header gate and verb restrictions on every success, redirect, static asset, thrown route, and HEAD response.

## 6. Security invariants for auditors

- Never promote client-controlled paths or upstream fields into a fetch origin, SQL string interpolation, unsanitized executable URL, or unescaped HTML/XML. `raw()` requires proof the string is already trusted markup; URLs require scheme validation **as well as** context-appropriate output escaping.
- Validate feature IDs, milestones, and `web_feature` slugs at the route/client seam before upstream, cache, or D1 work. Never share pending `fetch()` Promises or `Response` streams across Cloudflare Worker requests.
- Preserve the GET/HEAD/OPTIONS policy, `Cache-Control: no-store` on error views, and shared security headers on successes, redirects, static assets, missing assets, thrown routes, and HEAD responses. HEAD may render but must not capture/touch D1 snapshots; do not leak internal error details to clients.
- Treat ChromeStatus and WebStatus data as malformed or hostile until shape-checked; never assume dates, counts, field types, or complete pagination.

## 7. Explicit exclusions and residual risks

- Public unauthenticated reads, cross-origin milestone JSON reads, and bounded read-triggered D1 snapshot capture are product decisions, not authorization bugs by themselves. The isolate-local feature-fetch budget is not a strict global distributed rate limit across all Cloudflare PoPs; high-volume distributed traffic can still consume compute, upstream quota, and D1 writes (Cloudflare's native `ratelimits` binding or WAF rules can be layered on top if abuse emerges).
- External HTTP(S) links lead visitors off-site by design; the URL allowlist prevents script schemes, not malicious content at an otherwise valid web destination. Cloudflare platform access controls and dev/build toolchain supply-chain security require separate operations review.
