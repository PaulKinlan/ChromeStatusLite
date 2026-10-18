#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
base="${GATE_BASE:-$(git merge-base HEAD origin/main)}"
mapfile -t paths < <( { git diff --name-only "$base" HEAD; git diff --name-only; git diff --cached --name-only; git ls-files --others --exclude-standard; } | sort -u )
declare -A selected=()
add() { selected["$1"]=1; }
add_all() { add tests/handler_test.ts; add tests/index_test.ts; add tests/feature_test.ts; add tests/deprecations_test.ts; add tests/client_test.ts; }
gate=0
for path in "${paths[@]}"; do
  # A deleted file cannot be exercised; the suites that loaded it fail at module
  # resolution if the deletion breaks them, so the diff entry itself is skipped.
  [[ -e $path ]] || continue
  case "$path" in
    static/*.html) add tests/handler_test.ts ;;
    src/routes/index.ts|static/scripts/index.js) add tests/index_test.ts ;;
    src/routes/feature.ts) add tests/feature_test.ts ;;
    src/lib/utils.ts|tests/client_test.ts) add tests/client_test.ts; add tests/index_test.ts; add tests/feature_test.ts; add tests/deprecations_test.ts ;;
    src/routes/deprecations.ts|static/scripts/deprecations.js) add tests/deprecations_test.ts ;;
    # .fleet/coverage-contract.json declares suite attribution only for paths with a
    # real transitive import into the executed suites (chrome-status-lite-74e);
    # tests/gate_test.ts pins the contract and this mapping to each other.
    main.ts|src/handler.ts|src/flora.ts|src/stream-utils.ts|src/ui-components/*|static/styles/*|README.md|deno.json|deno.lock|docs/speed.md|tests/fixture.ts|tests/http_smoke_test.ts)
      add_all ;;
    tools/*|.fleet/*|tests/gate_test.ts) add_all; gate=1 ;;
    tests/index_test.ts|tests/feature_test.ts|tests/deprecations_test.ts|tests/handler_test.ts) add "$path" ;;
    *) echo "Unmapped changed path: $path" >&2; exit 1 ;;
  esac
done
# No diff must still prove nonzero test coverage (e.g. an installed host gate).
if (( ${#selected[@]} == 0 )); then
  add_all
fi
mapfile -t suites < <(printf '%s\n' "${!selected[@]}" | sort)
printf 'Fast gate: %s + tests/http_smoke_test.ts' "${suites[*]}"
if (( gate )); then printf ' + tests/gate_test.ts'; fi
printf '\n'
deno test --no-check --cached-only --allow-read=static "${suites[@]}"
# The fixture-backed HTTP + headless-browser smoke always runs (chrome-status-lite-tor):
# a changed test file is only 'placed' in fleet-check coverage by its own execution,
# and the shared modules every route suite imports (src/handler.ts, tests/fixture.ts)
# count the smoke suite as a covering candidate. Without it every fast verdict reads
# PARTIAL. Offline, fixture-backed, ~2 s. Same sandbox as the full gate's smoke run.
deno test --no-check --cached-only --allow-read=static,/tmp --allow-write --allow-net=127.0.0.1 --allow-run --allow-env=CHROME_BIN tests/http_smoke_test.ts
# Gate harness changes also run the behavioural gate test (chrome-status-lite-74e):
# it drives both gate scripts in scratch git repos with a stubbed deno and pins
# .fleet/coverage-contract.json to this mapping, so tools/* is covered by real
# execution rather than declared coverage.
if (( gate )); then
  deno test --no-check --cached-only --allow-read --allow-write --allow-run --allow-env tests/gate_test.ts
fi
