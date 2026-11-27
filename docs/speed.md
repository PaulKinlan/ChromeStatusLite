# Gate speed and coverage

- Fast budget: <=60 s. `tools/fast-gate.sh` maps changed paths (including deletions) to affected Cloudflare Workers route/client suites; unmapped paths fail closed. Deleting a mapped path reruns its former suites so an unsafe removal fails; deleting a required test suite fails until the gate's suite list is updated. Handler, worker, config, migration, or static style changes select all suites. A zero-diff tree still runs all suites.
- Every gate run starts with strict TypeScript typechecking (`npx tsc --noEmit`), followed by `npx vitest run` inside `@cloudflare/vitest-pool-workers` (real `workerd` runtime + Miniflare D1 with `migrations/0001_init.sql` + real `env.ASSETS` static binding).
- The fast gate then ALWAYS runs `tests/http_smoke_test.ts` under Node (`vitest.node.config.ts`), which imports `src/worker.ts` (verifying the deploy entrypoint is import-safe), runs real HTTP checks, and executes headless Chrome DOM, screenshot, and DevTools CDP style/a11y/contrast/focus-ring probes.
- When `tools/*`, `.fleet/*`, or `tests/gate_test.ts` changes, the fast gate also runs `tests/gate_test.ts`, which drives both gate scripts in scratch git repos with a stubbed `npx` and pins `.fleet/coverage-contract.json` and the `src/lib/utils.ts` importer graph to the fast-gate mapping.
- Full budget: <=300 s. `tools/full-gate.sh` runs `npx tsc --noEmit`, all 13 Cloudflare Workers suites, and `tests/http_smoke_test.ts`.
- All route, client, D1, and browser smoke tests are 100% offline and fixture-backed: no test calls `chromestatus.com` or `api.webstatus.dev`.
