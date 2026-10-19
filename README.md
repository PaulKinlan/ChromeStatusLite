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

- **`/feature/:id/history`** — Snapshot history for a feature: every capture, newest first, with the
  tracked fields that changed since the previous capture. Up to 25 captures are listed; older ones
  are counted but not shown.

- **`/feature/:id/diff`** — Field-by-field diff between two captures (added, removed and changed
  lines). Takes `?from=<capture timestamp>&to=<capture timestamp>`; with no parameters it diffs the
  **oldest and newest** captures — the full range, not just the latest pair — and it always renders
  older → newer, so a swapped pair is normalised rather than shown backwards. If either timestamp
  does not match a stored capture the page says so and falls back to the full range. Timestamps are
  full ISO strings including milliseconds; the links on the history page carry them ready to copy.

## Snapshot history

History builds up lazily from reader traffic — there is no cron or background job. Viewing
`/feature/:id` records the tracked display fields, and a capture is only appended when they differ
from the newest stored capture (content-based dedupe), so repeated views add nothing and history
stays proportional to real changes and attention. When a store is configured the `/feature/:id` page
links to its history ("Snapshot history", above the details); on a store-less deployment the link is
omitted rather than pointing at a "not configured" page.

Captures live in [Deno KV](https://docs.deno.com/deploy/kv/manual/), which is generally available
on Deno Deploy and needs `--unstable-kv` under Deno 2.x locally (see [Run locally](#run-locally)).
The two routes distinguish three states:

- **Store configured, captures exist** — the history list or the diff.
- **Store configured, no captures for this feature** — "No snapshots captured yet"; the diff page
  asks for two different captures.
- **No usable store** — the routes render "Snapshot history is not configured on this deployment."
  (no KV available at all) or "Snapshot history is temporarily unavailable" (a store that exists but
  fails to read). Capture attempts on a failing store are logged to the server console, not surfaced
  in the page.

## How it works

- **`main.ts`** — Entry point, starts `Deno.serve`. The import-safe `src/handler.ts`
  handles routes and static assets with an injectable Chrome Status client.
- **`src/routes/`** — One module per page (`index`, `deprecations`, `feature`, `feature-history`,
  plus the feed, wiki and compatibility pages).
- **`src/lib/utils.ts`** — `ChromeStatusAPI`, a singleton client over the chromestatus.com
  `/api/v0/*` endpoints (`channels`, `features?milestone=`, `features/:id`,
  `features?q=feature_type=`). Responses are cached in an LRU (100 entries, 1 hour TTL) to keep
  the upstream API happy.
- **`src/lib/snapshots.ts`** — `SnapshotStore` and `captureSnapshot` (the lazy, content-deduped
  capture described above), `KvSnapshotStore` over Deno KV, an in-memory store for tests, and the
  field-level `diffSnapshots` used by the diff page.
- **`src/flora.ts`** — A small streaming tagged-template literal (``template`...` ``) that builds
  HTML as a `ReadableStream` and resolves nested promises/arrays inline.
- **`src/stream-utils.ts`** — `StripStream`, which strips the `)]}'` XSSI prefix that the
  chromestatus API prepends to its JSON responses.

## Run locally

Requires [Deno](https://deno.com/) 2.x.

```sh
deno run --allow-net --allow-read=. --allow-env main.ts
```

Then open <http://localhost:8000>. The server reads the `PORT` env var (used by Deno Deploy) and
falls back to `8000` for local development.

- `--allow-net` — to call the chromestatus.com API and bind the server.
- `--allow-read=.` — to serve files from `static/`.
- `--allow-env` — to read `PORT`. Without it the server exits at startup with
  `NotCapable: Requires env access to "PORT"`, before it binds a port.

That command runs every page except snapshot history: Deno 2.x refuses `Deno.openKv` without
`--unstable-kv` and write access to its KV file (a SQLite database under Deno's cache directory), so
the two history routes report "not configured". To run them locally:

```sh
deno run --allow-net --allow-read=. --allow-env --unstable-kv --allow-write="$HOME/.cache/deno" main.ts
```

Then visit `/feature/:id`, followed by `/feature/:id/history` — the first view captures a snapshot;
before any capture the page says "No snapshots captured yet". On Deno Deploy KV is generally
available and the deployed site needs no extra flags.

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
