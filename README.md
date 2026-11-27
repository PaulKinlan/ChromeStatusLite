# ChromeStatusLite

A fast, lightweight view over [chromestatus.com](https://chromestatus.com) that turns the
Chrome Platform Status API into a readable **release log** — what shipped, what's behind a
flag, what's in origin trial, and what's being deprecated or removed in each Chrome version.

**Live:** [chromestatuslite.com](https://chromestatuslite.com)

## What it does

ChromeStatusLite fetches data from the public Chrome Platform Status v0 API (plus optional
[webstatus.dev](https://webstatus.dev) Baseline status lookups) and renders plain,
server-rendered HTML. Zero client-side JavaScript, zero runtime npm dependencies — just
Cloudflare Workers, D1 (serverless SQLite), Static Assets, and a streaming tagged-template
renderer.

### Pages

- **`/`** — Release summary for a Chrome version. Features are grouped into:
  - Enabled by default
  - Origin trial
  - Behind a flag (developer trial)
  - Deprecated
  - Removed

  Defaults to the latest dev milestone. Use `?version=N` to view any release (e.g. `/?version=120`).
  Milestones 130+ also link directly to [chrome-platform-showcase.com](https://chrome-platform-showcase.com).

- **`/deprecations`** — A deprecation calendar: every feature flagged for deprecation/removal,
  sorted by Chrome version with its estimated UTC stable date and intent stage; each feature name
  links to the local `/feature/:id` page.

- **`/feature/:id`** — Detail page for a single feature: summary, motivation, standards position,
  [webstatus.dev](https://webstatus.dev) Baseline status & browser support versions (when the
  feature carries an official `web_feature` slug), cross-browser signals (Firefox, Safari, web
  developers), tracking bug, ecosystem links (WPT, [chrome-platform-showcase.com](https://chrome-platform-showcase.com),
  [gendn.dev](https://gendn.dev), `chrome.dev`, `web.dev`, MDN, `webstatus.dev`), and linked docs,
  samples, and explainers. If too many distinct, uncached feature pages are requested at once, the
  server returns `429 Too Many Requests` with a `Retry-After` header.

- **`/feature/:id/history`** — Snapshot history for a feature: every capture, newest first, with the
  tracked fields that changed since the previous capture. Up to 25 captures are listed; older ones
  are counted but not shown.

- **`/feature/:id/diff`** — Field-by-field diff between two captures (added, removed and changed
  lines). Takes `?from=<capture timestamp>&to=<capture timestamp>`; with no parameters it diffs the
  **oldest and newest** captures and normalizes older → newer.

- **`/diff`** — Compare two Chrome releases side by side, grouped by status with per-group counts.
  Defaults to the latest milestone and the one before it; `?from=N&to=N` picks any two available
  milestones.

- **`/breaking`** — Breaking changes and deprecations timeline across recent milestones with
  enterprise impact, intent stage, and migration guidance.

- **`/origin-trials`** — Origin trials tracker: active, upcoming, and historical trials across
  recent milestones.

- **`/feed.xml`** — An RSS 2.0 feed of recent releases (`?limit=N`, default 10, clamped to 1–25).
  Every HTML page also advertises `<link rel="alternate" type="application/rss+xml" href="/feed.xml">`.

- **`/wiki`** — Topic wiki index grouping related features (WebGPU, CSS anchor positioning,
  built-in AI, storage, privacy, …) with feature counts. Backed by D1 and refreshed incrementally
  by a Cloudflare Cron Trigger so the directory renders in a single D1 query.

- **`/wiki/:topic`** — One topic page: cross-browser consensus tallies, features grouped by stage,
  and a shipping timeline. An unknown topic returns `404`.

- **`/api/version/:version`** — Public JSON for one milestone (`version`, `stable_date`,
  `total_features`, `features_by_type`, `features`). Accepts `latest` or an integer milestone and
  sets `access-control-allow-origin: *`.

- **`/about`** — Background on Paul Kinlan, why ChromeStatusLite was built, and links to related
  projects.

- **`/llms.txt`** — Live `llmstxt.org`-style agent index documenting every page, all topic wiki
  slugs, direct Markdown links to features in the latest Chrome release, `Accept: text/markdown`,
  `.md` URLs, and machine-readable endpoints.

### Agent & Markdown support (`Accept: text/markdown` & `.md` URLs)

Every HTML page — including every individual `/feature/:id` page, snapshot history, and diff —
supports RFC-compliant `Accept: text/markdown` content negotiation as well as direct `.md` URLs
for tools that cannot set custom headers:

```sh
curl https://chromestatuslite.com/llms.txt
curl -H "Accept: text/markdown" https://chromestatuslite.com/
curl -H "Accept: text/markdown" https://chromestatuslite.com/feature/5160724576993280
curl https://chromestatuslite.com/feature/5160724576993280.md
curl https://chromestatuslite.com/deprecations.md
```

Markdown responses return `Content-Type: text/markdown; charset=utf-8`, `Vary: Accept`, and
`X-Markdown-Tokens`, extracting `<main>` into clean Markdown with absolute canonical links and GFM
tables while stripping navigation chrome and interactive form pickers. Cloudflare's edge cache
keys HTML and Markdown variants separately so browsers never receive cached Markdown.

## Snapshot history & Wiki cache (Cloudflare D1)

Both durable features share a single Cloudflare D1 database (`migrations/0001_init.sql`):

- **Lazy snapshot history (`feature_index`, `feature_snapshots`)**: Viewing `/feature/:id` captures
  a slim snapshot asynchronously via `ctx.waitUntil()` (zero added TTFB latency) only when tracked
  fields differ from the newest stored snapshot. Retention is bounded atomically in SQLite
  (`MAX_SNAPSHOTS_PER_FEATURE = 25`, `MAX_TRACKED_FEATURES = 5000` with O(log N) LRU eviction and
  24-hour throttled recency touches).
- **Topic wiki cache (`wiki_topic_cache`)**: A Cloudflare Cron Trigger (`*/15 * * * *`) refreshes
  the 3 stalest topics per run — staying safely under the Workers Free plan 50 external subrequests
  limit while cycling through all 15 topics every ~75 minutes. `/wiki` serves all cached topics in
  a single D1 query.

## Caching & performance

- **L1 isolate cache**: Zero-dependency `TTLCache` storing plain parsed JSON (100 entries, 1h TTL;
  never shares in-flight `fetch()` Promises across requests).
- **L2 Cloudflare Cache API (`caches.default`)**: Upstream ChromeStatus JSON (1h), `webstatus.dev`
  Baseline payloads (6h), and read-only GET HTML/RSS/JSON responses (with `Cache-Control: no-store`
  on every error notice, 404, 429, and 500 so outages are never edge-cached).
- **Zero-JS navigation speedup**: Healthy HTML pages send `Speculation-Rules: "/speculation-rules.json"`
  (moderate prefetch on read-only routes, excluding `/feature/*`) without adding any `<script>` tags
  or weakening CSP, and below-the-fold repeated sections use CSS `content-visibility: auto`.

## How it works

- **`src/worker.ts`** — Cloudflare Workers entry point (`fetch` + `scheduled` Cron handler),
  wiring `env.ASSETS`, `env.DB` (D1), `caches.default`, and `ctx.waitUntil()`.
- **`src/handler.ts`** — Runtime-agnostic request router, explicit static asset allowlist,
  RFC 9110 streaming `HEAD` handler, and total security-header gate.
- **`src/routes/`** — One module per page (`index`, `deprecations`, `diff`, `breaking`,
  `origin-trials`, `feature`, `feature-history`, `wiki`, `wiki-topic`, `about`, `llms`, `feed`,
  `api-version`).
- **`src/lib/markdown.ts`** — Zero-dependency `Accept: text/markdown` negotiation and single-pass
  HTML-to-Markdown converter.
- **`src/ui-components/`** — Shared HTML shell (`layout.ts`), zero-JS popover nav (`nav.ts`), and
  feature metadata badges (`feature-metadata.ts`).
- **`src/lib/utils.ts`** — `ChromeStatusAPI` client (fixed origins `chromestatus.com` and
  `api.webstatus.dev`, timeout + byte cap, per-request singleflight, negative caching, feature fetch
  budget, L1 + L2 Cache API).
- **`src/lib/snapshots.ts`** — `D1SnapshotStore`, `MemorySnapshotStore`, `captureSnapshot`, and
  `diffSnapshots`.
- **`src/lib/wiki-data.ts`** — Paginated topic query assembler, `D1WikiTopicStore`, and
  `refreshStaleWikiTopics` for Cron Triggers.
- **`src/flora.ts`** — Zero-dependency streaming tagged-template HTML renderer with auto-escaping.
- **`src/stream-utils.ts`** — `StripStream` removing chromestatus.com's `)]}'\n` XSSI prefix.

## Local development

Requires Node.js 20+ (tested on Node 25).

```sh
npm install
npm run db:migrate:local
npm run dev
```

Then open <http://localhost:8787>. To trigger the local Cron wiki refresh:

```sh
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"
```

## Tests and gates

```sh
npm run typecheck   # strict TypeScript check (tsc --noEmit)
npm test            # all 13 Cloudflare Workers suites in workerd (Miniflare + real D1 + Assets)
npm run test:smoke  # real HTTP + headless Chrome CDP style/a11y/contrast smoke test
npm run test:gate   # gate harness behavioural tests
npm run test:fast   # affected suites + tsc + smoke
npm run test:full   # tsc + all Workers suites + browser smoke
```

See [gate budget](docs/speed.md).

## Deploying to Cloudflare

1. Authenticate Wrangler once:
   ```sh
   npx wrangler login
   ```
2. Create the production D1 database and copy its `database_id` into [wrangler.jsonc](wrangler.jsonc):
   ```sh
   npx wrangler d1 create chromestatuslite-db
   ```
3. Apply the D1 schema remotely:
   ```sh
   npm run db:migrate:remote
   ```
4. Deploy the Worker + Static Assets + Cron Trigger:
   ```sh
   npm run deploy
   ```
5. Preview on `*.workers.dev`, then attach your custom domain (`chromestatuslite.com`) in the
   Cloudflare dashboard (or uncomment `routes` in `wrangler.jsonc`). Once live on the custom domain,
   set `"workers_dev": false` or set `REDIRECT_WORKERS_DEV = "true"` in `wrangler.jsonc` vars to
   301-redirect `*.workers.dev` to `https://chromestatuslite.com`.

## Data sources

All Chrome release data comes from the public Chrome Platform Status API at
`https://chromestatus.com/api/v0`, with optional Baseline status enrichment from
`https://api.webstatus.dev/v1`. ChromeStatusLite is an independent reader and is not affiliated with
the chromestatus.com project or Google.
