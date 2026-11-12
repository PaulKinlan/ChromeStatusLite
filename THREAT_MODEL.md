# ChromeStatusLite threat model

This is the review rubric for the current source, not a claim that every abuse case is eliminated. Re-check the cited paths when routes, dependencies, or deployment change.

## 1. System and architecture

A public, read-only Deno HTTP site serves Chrome feature pages, wiki topics, diffs, RSS and a JSON milestone API. `main.ts` starts `Deno.serve`; `src/handler.ts` routes requests and serves an explicit set of static assets. `src/lib/utils.ts` fetches ChromeStatus API JSON from a fixed `https://chromestatus.com` origin and shares an in-memory LRU across requests. `src/lib/wiki-data.ts` assembles paginated search results. Viewing a feature can lazily record a slim snapshot in Deno KV (`src/routes/feature.ts`, `src/lib/snapshots.ts`); history and diffs read that store. HTML is streamed by `src/flora.ts`.

## 2. Actors and trust boundaries

- The site operator controls deployed source, static files and KV configuration; maintainers and the dependency supply chain are privileged. The local test fixtures are not public endpoints.
- Anonymous visitors control HTTP method, path and query strings. They can trigger upstream fetches and **indirect KV writes** via GET `/feature/:id`, even though there is no user-facing write API. `/api/version/:version` deliberately allows cross-origin reads (`Access-Control-Allow-Origin: *`).
- ChromeStatus API responses are external data, **not trusted HTML or URLs**. They cross the network boundary into cache, templates, feed/XML and snapshots; Deno KV persists selected fields. Third-party links in that data lead visitors off-site. No user login, secrets API, browser extension IPC or MCP server is implemented here.

## 3. Explicitly trusted (non-threats)

- Source-controlled static markup/assets, the route table, and operator-controlled deployment/KV configuration are trusted unless a separate repository or deployment compromise is in scope. Fixture clients in `tests/` are test data, not independently reachable attackers.
- A read-only `GET`/`HEAD` API and public CORS on `/api/version/:version` are intentional: do not report missing authentication or wildcard CORS alone. Do not infer a secure local-only listener: `main.ts` binds a public service in deployment.
- The `staticRoot` and `staticFs` arguments of `createHandler` are trusted test/deployment seams, not user-supplied file paths.

## 4. Untrusted surfaces and existing controls

- **Inbound HTTP:** `src/handler.ts` admits GET/HEAD plus OPTIONS on the JSON API, redirects known Deno hostnames to the canonical site, and restricts static paths to explicit asset patterns. All responses, including caught route errors, pass through the CSP/nosniff/referrer/frame header gate. Path/query-derived feature IDs, milestones, feed limits, diff endpoints and wiki topics must not cause unbounded work or be interpreted as filesystem paths.
- **Upstream API:** `src/lib/utils.ts` builds requests against a fixed origin, canonicalizes numeric query values, limits fetch time and body bytes, strips the upstream XSSI prefix, coalesces identical in-flight requests, and caches success or brief retryable failures. `src/lib/wiki-data.ts` limits continuation pages and their shared concurrency. New fetch paths must keep those bounds and avoid caller-controlled origins, arbitrary query expansion or cache-key explosions.
- **HTML and links:** `src/flora.ts` escapes interpolated values by default; `raw()` bypasses that protection. `src/lib/url.ts` admits only parsed, serialized HTTP(S) hrefs for upstream links; `src/lib/linkify.ts` builds escaped markup from prose. Review any new raw HTML, attribute, URL, script, CSS or XML sink separately; HTML escaping alone is not URL-scheme validation. `src/routes/feed.ts` escapes XML and filters illegal XML characters.
- **Persistent state:** `src/lib/snapshots.ts` stores read-triggered snapshots under feature IDs with per-feature and tracked-feature retention caps, recency throttling and bounded eviction retries. `src/routes/feature-history.ts` reads snapshots. Feature IDs must be validated before upstream access or KV key construction; anonymous requests must not bypass retention or turn store errors into unhandled failures.

## 5. Historical bug shapes to retest

- Escaping/link safety: `src/flora.ts` switched to escaped interpolation (including object `toString`); `src/lib/url.ts` validates serialized HTTP(S) URLs. Check every new template interpolation, `raw()` call and upstream-derived href, not just text nodes.
- Work amplification: `src/lib/utils.ts` added timeout/body caps, singleflight, negative caching, feature-detail fetch budget and numeric parameter bounds; `src/lib/wiki-data.ts` capped pagination/concurrency. Ask whether a new route creates a fresh uncached upstream key or unbounded fan-out per anonymous request.
- Stateful GET and failure paths: `src/lib/snapshots.ts` gained retention/concurrency controls; `src/handler.ts` gained a total security-header gate for rejected routes and verb restrictions. Ask whether every new rejection retains the shared headers and whether a read path can still trigger unchecked KV growth.

## 6. Security invariants for auditors

- Never promote client-controlled paths or upstream fields into a fetch origin, filesystem path, unsanitized executable URL, or unescaped HTML/XML. `raw()` requires proof that the string is already trusted markup; URLs require scheme validation **as well as** context-appropriate output escaping.
- Validate feature IDs and milestones at the route seam before upstream/cache/KV work. Bound new query cardinality, concurrent requests, response sizes, processing time and persistent writes; check both cold-cache bursts and upstream failures.
- Preserve the GET/HEAD/OPTIONS policy and shared security headers on successes, redirects, missing assets, thrown routes and HEAD responses. HEAD may render but must not capture/touch KV snapshots; do not leak internal error details to clients.
- Treat ChromeStatus data as malformed or hostile until shape-checked; never assume dates, counts, field types or complete pagination. Failure handling should not falsely assert an empty/not-found result or poison a long-lived cache.

## 7. Explicit exclusions and residual risks

- Public unauthenticated reads, cross-origin milestone JSON reads and bounded read-triggered KV snapshot capture are product decisions, not authorization bugs by themselves. The per-process feature-fetch budget is not a global distributed rate limit; high-volume distributed traffic can still consume compute, upstream quota and KV capacity. Report a concrete bypass or impact, rather than treating the absence of login as a finding.
- External HTTP(S) links may leave the site by design; the URL allowlist prevents script schemes, not malicious content at an otherwise valid web destination. Deno runtime, deployment access controls and third-party dependency compromise require separate supply-chain/operations review.
