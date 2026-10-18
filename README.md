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

- **`/feature/:id/history`** — Snapshot history for a feature. Each time a reader views a feature
  page, a slim snapshot of its tracked fields (summary, intent stage, status + milestone, spec
  link, WPT note, vendor positions) is stored when they differ from the newest capture.
- **`/feature/:id/diff`** — Visual field-level diff between two snapshots (oldest → newest by
  default; pick a pair with `?from=<ISO>&to=<ISO>`, or follow the links on the history page).

Snapshots are stored in Deno KV (enabled by default on Deno Deploy). Locally, `Deno.openKv`
needs the KV flag and write access:

```sh
deno run --allow-net --allow-read=. --unstable-kv --allow-write main.ts
```

Without a working KV store the pages degrade to a "not configured" notice and capture is
skipped — the rest of the site is unaffected.

Known limits of lazy capture: history starts empty at deploy and only grows when features are
viewed, so changes that happen while nobody views a feature are invisible (the diff shows one
jump, not intermediate steps), and there is currently no way to delete a bad capture.

## How it works

- **`main.ts`** — Entry point, starts `Deno.serve`. The import-safe `src/handler.ts`
  handles routes and static assets with an injectable Chrome Status client.
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

## Tests and gates

```sh
deno task test:fast  # offline affected route/client tests; rejects unmapped changed paths
deno task test:full  # all tests plus local HTTP and headless Chrome smoke
```

The fast gate uses `git merge-base HEAD origin/main` (override with `GATE_BASE`) and
includes unstaged/untracked changes. Remote Deno modules must be cached once before
offline gates run (`deno cache src/handler.ts tests/http_smoke_test.ts`). Full smoke
requires `google-chrome` or `CHROME_BIN`. See [gate budget](docs/speed.md).

## Deploying

Hosted on [Deno Deploy](https://deno.com/deploy) behind [chromestatuslite.com](https://chromestatuslite.com).
Deno Deploy injects `PORT` and expects the server to bind `0.0.0.0`, which `Deno.serve` handles by
default — no extra configuration needed.

## Data source

All data comes from the public Chrome Platform Status API at `https://chromestatus.com/api/v0`.
ChromeStatusLite is an independent reader for that data and is not affiliated with the
chromestatus.com project or Google.
