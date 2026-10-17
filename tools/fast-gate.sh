#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
base="${GATE_BASE:-$(git merge-base HEAD origin/main)}"
mapfile -t paths < <( { git diff --name-only "$base" HEAD; git diff --name-only; git diff --cached --name-only; git ls-files --others --exclude-standard; } | sort -u )
declare -A selected=()
add() { selected["$1"]=1; }
for path in "${paths[@]}"; do
  case "$path" in
    static/*.html) add tests/handler_test.ts ;;
    src/routes/index.ts|static/scripts/index.js) add tests/index_test.ts ;;
    src/routes/feature.ts) add tests/feature_test.ts ;;
    src/lib/utils.ts|src/stream-utils.ts|tests/client_test.ts) add tests/client_test.ts; add tests/index_test.ts; add tests/feature_test.ts; add tests/deprecations_test.ts ;;
    src/routes/deprecations.ts|static/scripts/deprecations.js) add tests/deprecations_test.ts ;;
    main.ts|src/handler.ts|src/flora.ts|src/types.ts|src/ui-components/*|static/styles/*|README.md|deno.json|deno.lock|docs/speed.md|tools/*|tests/fixture.ts|tests/http_smoke_test.ts)
      add tests/handler_test.ts; add tests/index_test.ts; add tests/feature_test.ts; add tests/deprecations_test.ts; add tests/client_test.ts ;;
    tests/index_test.ts|tests/feature_test.ts|tests/deprecations_test.ts|tests/handler_test.ts) add "$path" ;;
    *) echo "Unmapped changed path: $path" >&2; exit 1 ;;
  esac
done
# No diff must still prove nonzero test coverage (e.g. an installed host gate).
if (( ${#selected[@]} == 0 )); then
  add tests/handler_test.ts; add tests/index_test.ts; add tests/feature_test.ts; add tests/deprecations_test.ts; add tests/client_test.ts
fi
mapfile -t suites < <(printf '%s\n' "${!selected[@]}" | sort)
printf 'Fast gate: %s\n' "${suites[*]}"
deno test --no-check --cached-only --allow-read=static "${suites[@]}"
