import { defineConfig } from "vitest/config";

// Node-environment Vitest config for suites that spawn local processes
// (headless Chrome CDP smoke probe and scratch-git gate harness).
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/http_smoke_test.ts", "tests/gate_test.ts"],
    testTimeout: 60_000,
  },
});
