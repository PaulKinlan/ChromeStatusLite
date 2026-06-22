# ChromeStatusLite

A fast, lightweight view over [chromestatus.com](https://chromestatus.com) that turns the
Chrome Platform Status API into a readable **release log** — what shipped, what's behind a
flag, what's in origin trial, and what's being deprecated or removed in each Chrome version.

**Live:** [chromestatuslite.com](https://chromestatuslite.com)

## What it does

ChromeStatusLite fetches data from the public Chrome Platform Status v0 API and renders plain,
server-rendered HTML. No client framework, no build step — just Deno and a streaming
tagged-template renderer.

### Pages

- **`/`** — Release summary for a Chrome version. Features are grouped into:
  - Enabled by default
  - Origin trial
  - Behind a flag (developer trial)
  - Deprecated
  - Removed

  Defaults to the latest dev milestone. Use `?version=N` to view any release (e.g. `/?version=120`).

- **`/deprecations`** — A deprecation calendar: every feature flagged for deprecation/removal,
  sorted by Chrome version with its estimated stable date, intent stage, and a link back to
  chromestatus.com.

- **`/feature/:id`** — Detail page for a single feature: summary, motivation, standards position,
  cross-browser signals (Firefox, Safari, web developers), tracking bug, and links to docs,
  samples, and explainers. `:id` is the chromestatus feature id.

## How it works

- **`main.ts`** — Entry point. A `Deno.serve` handler matches requests against `URLPattern`
  routes and falls through to a static file handler for anything under `static/`.
- **`src/routes/`** — One module per page (`index`, `deprecations`, `feature`).
- **`src/lib/utils.ts`** — `ChromeStatusAPI`, a singleton client over the chromestatus.com
  `/api/v0/*` endpoints (`channels`, `features?milestone=`, `features/:id`,
  `features?q=feature_type=`). Responses are cached in an LRU (100 entries, 1 hour TTL) to keep
  the upstream API happy.
- **`src/flora.ts`** — A small streaming tagged-template literal (``template`...` ``) that builds
  HTML as a `ReadableStream` and resolves nested promises/arrays inline.
- **`src/stream-utils.ts`** — `StripStream`, which strips the `)]}'` XSSI prefix that the
  chromestatus API prepends to its JSON responses.

## Run locally

Requires [Deno](https://deno.com/).

```sh
deno run --allow-net --allow-read=. main.ts
```

Then open <http://localhost:8000>. The server reads the `PORT` env var (used by Deno Deploy) and
falls back to `8000` for local development.

- `--allow-net` — to call the chromestatus.com API and bind the server.
- `--allow-read=.` — to serve files from `static/`.

## Deploying

Hosted on [Deno Deploy](https://deno.com/deploy) behind [chromestatuslite.com](https://chromestatuslite.com).
Deno Deploy injects `PORT` and expects the server to bind `0.0.0.0`, which `Deno.serve` handles by
default — no extra configuration needed.

## Data source

All data comes from the public Chrome Platform Status API at `https://chromestatus.com/api/v0`.
ChromeStatusLite is an independent reader for that data and is not affiliated with the
chromestatus.com project or Google.
