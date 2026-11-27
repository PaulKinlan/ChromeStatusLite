#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Full gate runs strict TypeScript typechecking, the complete Cloudflare
# Workers (Miniflare + D1 + Assets) test suite, and the real HTTP + headless
# Chrome browser smoke suite.
npx tsc --noEmit
npx vitest run tests/{handler,shell,feed,api_version,timeline,flora,index,feature,deprecations,diff,client,wiki,history}_test.ts
npx vitest run --config vitest.node.config.ts tests/http_smoke_test.ts
