#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

base="${GATE_BASE:-$(git merge-base HEAD origin/main)}"
paths=()
while IFS= read -r line; do
  [[ -n "$line" ]] && paths+=("$line")
done < <(
  {
    git diff --name-only "$base" HEAD
    git diff --name-only
    git diff --cached --name-only
    git ls-files --others --exclude-standard
  } | sort -u
)

selected=()
add() {
  local item="$1"
  local existing
  for existing in "${selected[@]+"${selected[@]}"}"; do
    [[ "$existing" == "$item" ]] && return 0
  done
  selected+=("$item")
}

add_app() {
  add tests/handler_test.ts
  add tests/shell_test.ts
  add tests/feed_test.ts
  add tests/api_version_test.ts
  add tests/timeline_test.ts
  add tests/index_test.ts
  add tests/feature_test.ts
  add tests/deprecations_test.ts
  add tests/diff_test.ts
  add tests/wiki_test.ts
  add tests/history_test.ts
}

add_all() {
  add_app
  add tests/flora_test.ts
  add tests/client_test.ts
}

gate=0
for path in "${paths[@]+"${paths[@]}"}"; do
  # Map deleted paths too: their former suites must verify that the removal is safe.
  case "$path" in
    THREAT_MODEL.md)
      add tests/handler_test.ts ;;
    static/*.html|static/robots.txt|static/llms.txt|static/favicon.svg|static/speculation-rules.json)
      add tests/handler_test.ts; add tests/shell_test.ts ;;
    src/routes/about.ts)
      add tests/handler_test.ts; add tests/shell_test.ts ;;
    src/routes/llms.ts)
      add tests/handler_test.ts ;;
    src/lib/markdown.ts)
      add_app ;;
    src/routes/index.ts|static/scripts/index.js)
      add tests/index_test.ts; add tests/handler_test.ts ;;
    src/routes/feature.ts)
      add tests/feature_test.ts; add tests/handler_test.ts ;;
    src/lib/linkify.ts)
      add tests/feature_test.ts; add tests/index_test.ts; add tests/diff_test.ts; add tests/timeline_test.ts; add tests/wiki_test.ts ;;
    src/lib/url.ts)
      add tests/feature_test.ts; add tests/index_test.ts; add tests/handler_test.ts; add tests/timeline_test.ts ;;
    src/lib/snapshots.ts|src/routes/feature-history.ts|tests/history_test.ts)
      add tests/feature_test.ts; add tests/history_test.ts ;;
    src/lib/buckets.ts)
      add tests/index_test.ts; add tests/handler_test.ts; add tests/feed_test.ts ;;
    src/routes/diff.ts)
      add tests/diff_test.ts; add tests/handler_test.ts ;;
    src/lib/utils.ts|src/lib/lru.ts|tests/client_test.ts)
      add tests/client_test.ts; add tests/index_test.ts; add tests/feature_test.ts; add tests/deprecations_test.ts; add tests/handler_test.ts; add tests/history_test.ts; add tests/feed_test.ts; add tests/api_version_test.ts; add tests/timeline_test.ts ;;
    src/routes/deprecations.ts|static/scripts/deprecations.js)
      add tests/deprecations_test.ts; add tests/handler_test.ts ;;
    src/routes/feed.ts)
      add tests/feed_test.ts; add tests/handler_test.ts ;;
    src/routes/api-version.ts)
      add tests/api_version_test.ts; add tests/handler_test.ts ;;
    src/routes/breaking.ts|src/routes/origin-trials.ts)
      add tests/timeline_test.ts ;;
    src/routes/wiki.ts|src/routes/wiki-topic.ts|src/lib/wiki.ts|src/lib/wiki-data.ts)
      add tests/wiki_test.ts ;;
    src/flora.ts)
      add_app; add tests/flora_test.ts ;;
    src/stream-utils.ts)
      add_app; add tests/client_test.ts ;;
    src/ui-components/*)
      add_app ;;
    main.ts|src/worker.ts|src/handler.ts|static/styles/*|migrations/*|README.md|wrangler.jsonc|package.json|package-lock.json|tsconfig.json|vitest.config.ts|vitest.node.config.ts|deno.json|deno.lock|.gitignore|docs/*|tests/fixture.ts|tests/apply-migrations.ts|tests/env.d.ts|tests/http_smoke_test.ts)
      add_all ;;
    tools/*|.fleet/*|tests/gate_test.ts)
      add_all; gate=1 ;;
    tests/index_test.ts|tests/feature_test.ts|tests/deprecations_test.ts|tests/handler_test.ts|tests/shell_test.ts|tests/feed_test.ts|tests/api_version_test.ts|tests/timeline_test.ts|tests/flora_test.ts|tests/diff_test.ts|tests/wiki_test.ts|tests/history_test.ts)
      add "$path" ;;
    *)
      echo "Unmapped changed path: $path" >&2; exit 1 ;;
  esac
done

if (( ${#selected[@]} == 0 )); then
  add_all
fi

suites=()
while IFS= read -r line; do
  [[ -n "$line" ]] && suites+=("$line")
done < <(printf '%s\n' "${selected[@]}" | sort)

printf 'Fast gate: tsc --noEmit + %s + tests/http_smoke_test.ts' "${suites[*]}"
if (( gate )); then printf ' + tests/gate_test.ts'; fi
printf '\n'

npx tsc --noEmit
npx vitest run "${suites[@]}"
npx vitest run --config vitest.node.config.ts tests/http_smoke_test.ts
if (( gate )); then
  npx vitest run --config vitest.node.config.ts tests/gate_test.ts
fi
