#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Full includes the complete offline fast-test set on the merged union, then
# runs HTTP + real browser smoke against a local fixture-backed listener.
deno test --no-check --cached-only --allow-read=static tests/{handler,index,feature,deprecations,diff,client,wiki}_test.ts
deno test --no-check --cached-only --allow-read=static,/tmp --allow-write --allow-net=127.0.0.1 --allow-run --allow-env=CHROME_BIN tests/http_smoke_test.ts
