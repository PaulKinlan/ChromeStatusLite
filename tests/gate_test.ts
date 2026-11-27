// Behavioural test for the gate harness: drives tools/fast-gate.sh and
// tools/full-gate.sh in scratch git repos with a stubbed `npx` that records
// every invocation, and pins .fleet/coverage-contract.json to the fast gate's
// path -> suite mapping.
//
// Deliberately self-contained (no imports from tests/fixture.ts).

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();

const ROUTE_SUITES = [
  "tests/api_version_test.ts",
  "tests/client_test.ts",
  "tests/deprecations_test.ts",
  "tests/diff_test.ts",
  "tests/feature_test.ts",
  "tests/feed_test.ts",
  "tests/flora_test.ts",
  "tests/handler_test.ts",
  "tests/history_test.ts",
  "tests/index_test.ts",
  "tests/shell_test.ts",
  "tests/timeline_test.ts",
  "tests/wiki_test.ts",
];
const SMOKE = "tests/http_smoke_test.ts";
const GATE = "tests/gate_test.ts";

function fail(message: string): never {
  throw new Error(message);
}

function equal<T>(actual: T, expected: T, context: string): void {
  if (actual !== expected) {
    fail(
      `${context}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function includes(haystack: string, needle: string, context: string): void {
  if (!haystack.includes(needle)) {
    fail(
      `${context}: expected ${JSON.stringify(haystack)} to include ${
        JSON.stringify(needle)
      }`,
    );
  }
}

function setEqual(actual: string[], expected: string[], context: string): void {
  const a = JSON.stringify([...actual].sort());
  const e = JSON.stringify([...expected].sort());
  if (a !== e) fail(`${context}: expected ${e}, got ${a}`);
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd[0], cmd.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
    });
    return { code: 0, stdout, stderr };
  } catch (err: any) {
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? ""),
    };
  }
}

interface Scratch {
  dir: string;
  env: Record<string, string>;
}

async function makeScratch(): Promise<Scratch> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "csl-gate-"));
  try {
    await fs.mkdir(path.join(dir, "tools"), { recursive: true });
    await fs.copyFile(
      path.join(repoRoot, "tools/fast-gate.sh"),
      path.join(dir, "tools/fast-gate.sh"),
    );
    await fs.copyFile(
      path.join(repoRoot, "tools/full-gate.sh"),
      path.join(dir, "tools/full-gate.sh"),
    );
    await fs.writeFile(path.join(dir, ".gitignore"), "bin/\nnpx.log\n");
    await fs.mkdir(path.join(dir, "bin"));
    await fs.writeFile(
      path.join(dir, "bin/npx"),
      `#!/usr/bin/env bash
echo "$*" >> "${dir}/npx.log"
[[ " $* " == *" $GATE_FAIL_SUITE "* ]] && exit 1
if [[ -n "$GATE_CHECK_SUITE_EXISTS" && " $* " == *" $GATE_CHECK_SUITE_EXISTS "* && ! -f "$GATE_CHECK_SUITE_EXISTS" ]]; then exit 1; fi
exit 0
`,
    );
    await fs.chmod(path.join(dir, "bin/npx"), 0o755);

    const git = async (args: string[]): Promise<string> => {
      const result = await run(["git", ...args], { cwd: dir });
      if (result.code !== 0) fail(`git ${args.join(" ")}: ${result.stderr}`);
      return result.stdout.trim();
    };
    await git(["init", "-q"]);
    await git(["config", "user.email", "gate-test@example.invalid"]);
    await git(["config", "user.name", "gate-test"]);
    await git(["add", "-A"]);
    await git(["commit", "-qm", "init"]);
    const base = await git(["rev-parse", "HEAD"]);
    return {
      dir,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
        PATH: `${path.join(dir, "bin")}:${process.env.PATH || ""}`,
        GATE_BASE: base,
        GATE_FAIL_SUITE: "__no_such_suite__",
        GATE_CHECK_SUITE_EXISTS: "",
      },
    };
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function utilsImportRegex(): RegExp {
  return /from "(?:[.]{1,2}\/)+lib\/utils\.ts"|from "[.]\/utils\.ts"/;
}

async function utilsImporters(): Promise<string[]> {
  const importRe = utilsImportRegex();
  const found: string[] = [];
  async function scan(dir: string): Promise<void> {
    const entries = await fs.readdir(path.join(repoRoot, dir), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (entry.isDirectory()) await scan(`${dir}/${entry.name}`);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const relPath = `${dir}/${entry.name}`;
        const text = await fs.readFile(path.join(repoRoot, relPath), "utf8");
        if (importRe.test(text)) found.push(relPath);
      }
    }
  }
  await scan("src");
  return found.sort();
}

async function touch(dir: string, rel: string): Promise<void> {
  const full = path.join(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, "changed\n");
}

async function removeTracked(scratch: Scratch, rel: string): Promise<void> {
  await touch(scratch.dir, rel);
  for (
    const args of [
      ["add", rel],
      ["commit", "-qm", "add tracked path"],
      ["rm", "-q", rel],
    ]
  ) {
    const result = await run(["git", ...args], { cwd: scratch.dir });
    equal(result.code, 0, `git ${args.join(" ")}: ${result.stderr}`);
  }
  scratch.env.GATE_BASE = (
    await run(["git", "rev-parse", "HEAD"], { cwd: scratch.dir })
  ).stdout.trim();
}

interface GateRun {
  code: number;
  stderr: string;
  invocations: string[];
  suites: string[];
}

function suitesOf(invocations: string[]): string[] {
  const suites = new Set<string>();
  for (const line of invocations) {
    for (const token of line.split(/\s+/)) {
      if (token.startsWith("tests/")) suites.add(token);
    }
  }
  return [...suites].sort();
}

async function fastGate(scratch: Scratch): Promise<GateRun> {
  const result = await run(["bash", "tools/fast-gate.sh"], {
    cwd: scratch.dir,
    env: scratch.env,
  });
  const log = await fs
    .readFile(path.join(scratch.dir, "npx.log"), "utf8")
    .catch(() => "");
  const invocations = log.split("\n").filter((line) => line.length > 0);
  return {
    code: result.code,
    stderr: result.stderr,
    invocations,
    suites: suitesOf(invocations),
  };
}

async function withScratch(
  fn: (scratch: Scratch) => Promise<void>,
): Promise<void> {
  const scratch = await makeScratch();
  try {
    await fn(scratch);
  } finally {
    await fs.rm(scratch.dir, { recursive: true, force: true });
  }
}

test("fast gate maps a static page change to the shell and handler suites plus smoke and runs tsc", () =>
  withScratch(async (scratch) => {
    await touch(scratch.dir, "static/robots.txt");
    const gate = await fastGate(scratch);
    equal(gate.code, 0, "exit code");
    setEqual(
      gate.suites,
      ["tests/handler_test.ts", "tests/shell_test.ts", SMOKE],
      "selected suites",
    );
    equal(gate.invocations[0], "tsc --noEmit", "runs strict typecheck first");
    includes(gate.invocations[2], "vitest.node.config.ts", "smoke node config");
  }));

test("fast gate maps a feature change to its suite and cross-route policy", () =>
  withScratch(async (scratch) => {
    await touch(scratch.dir, "src/routes/feature.ts");
    const gate = await fastGate(scratch);
    equal(gate.code, 0, "exit code");
    setEqual(
      gate.suites,
      ["tests/feature_test.ts", "tests/handler_test.ts", SMOKE],
      "selected suites",
    );
  }));

test("fast gate maps diff route to its focused suite", () =>
  withScratch(async (scratch) => {
    await touch(scratch.dir, "src/routes/diff.ts");
    const gate = await fastGate(scratch);
    equal(gate.code, 0, "exit code");
    setEqual(
      gate.suites,
      ["tests/diff_test.ts", "tests/handler_test.ts", SMOKE],
      "selected suites",
    );
  }));

test("fast gate runs focused suites and cross-route policy where asserted", () =>
  withScratch(async () => {
    const routes: Array<[string, string, boolean]> = [
      ["src/routes/feed.ts", "tests/feed_test.ts", true],
      ["src/routes/api-version.ts", "tests/api_version_test.ts", true],
      ["src/routes/index.ts", "tests/index_test.ts", true],
      ["src/routes/deprecations.ts", "tests/deprecations_test.ts", true],
      ["src/routes/breaking.ts", "tests/timeline_test.ts", false],
      ["src/routes/origin-trials.ts", "tests/timeline_test.ts", false],
    ];
    for (const [route, suite, hasHandlerPolicy] of routes) {
      await withScratch(async (probe) => {
        await touch(probe.dir, route);
        const gate = await fastGate(probe);
        equal(gate.code, 0, `exit code for ${route}`);
        setEqual(
          gate.suites,
          [suite, ...(hasHandlerPolicy ? ["tests/handler_test.ts"] : []), SMOKE],
          `selected suites for ${route}`,
        );
      });
    }
  }));

test("fast gate fails on the cross-route policy suite for feed and API changes", () =>
  withScratch(async () => {
    for (const route of ["src/routes/feed.ts", "src/routes/api-version.ts"]) {
      await withScratch(async (probe) => {
        await touch(probe.dir, route);
        probe.env.GATE_FAIL_SUITE = "tests/handler_test.ts";
        const gate = await fastGate(probe);
        equal(gate.code, 1, `handler policy failure fails fast gate for ${route}`);
        includes(
          gate.invocations[1],
          "tests/handler_test.ts",
          `handler suite ran for ${route}`,
        );
        equal(gate.invocations.length, 2, "gate stops before smoke on failure");
      });
    }
  }));

test("fast gate fails closed when a suite is deleted", () =>
  withScratch(async (scratch) => {
    await removeTracked(scratch, "tests/feed_test.ts");
    scratch.env.GATE_CHECK_SUITE_EXISTS = "tests/feed_test.ts";
    const gate = await fastGate(scratch);
    equal(gate.code, 1, "deleted suite must fail the gate");
    setEqual(gate.suites, ["tests/feed_test.ts"], "selected suite");
    equal(gate.invocations.length, 2, "gate stops after missing suite");
  }));

test("fast gate maps a deleted route even in a mixed diff, and surfaces its suite failure", () =>
  withScratch(async (scratch) => {
    await removeTracked(scratch, "src/routes/feature.ts");
    await touch(scratch.dir, "src/routes/index.ts");
    scratch.env.GATE_FAIL_SUITE = "tests/feature_test.ts";
    const gate = await fastGate(scratch);
    equal(gate.code, 1, "deleted route's suite failure must fail the gate");
    setEqual(
      gate.suites,
      ["tests/feature_test.ts", "tests/handler_test.ts", "tests/index_test.ts"],
      "selected suites",
    );
    includes(
      gate.invocations[1],
      "tests/feature_test.ts",
      "deleted route's suite ran",
    );
    equal(gate.invocations.length, 2, "gate stops after failed route suites");
  }));

test("fast gate refuses an unmapped deleted path", () =>
  withScratch(async (scratch) => {
    await removeTracked(scratch, "src/unknown_widget.ts");
    const gate = await fastGate(scratch);
    equal(gate.code, 1, "exit code");
    includes(
      gate.stderr,
      "Unmapped changed path: src/unknown_widget.ts",
      "refusal",
    );
    equal(gate.invocations.length, 0, "no suite ran after refusal");
  }));

test("fast gate maps shared modules, worker entrypoint and smoke test to all suites", () =>
  withScratch(async (scratch) => {
    for (
      const rel of [
        "src/stream-utils.ts",
        "tests/http_smoke_test.ts",
        "src/worker.ts",
      ]
    ) {
      await touch(scratch.dir, rel);
    }
    const gate = await fastGate(scratch);
    equal(gate.code, 0, "exit code");
    setEqual(gate.suites, [...ROUTE_SUITES, SMOKE], "selected suites");
    equal(gate.invocations.length, 3, "tsc + route + smoke invocations");
  }));

test("fast gate maps threat-model documentation without selecting unrelated route suites", () =>
  withScratch(async (scratch) => {
    await touch(scratch.dir, "THREAT_MODEL.md");
    const gate = await fastGate(scratch);
    equal(gate.code, 0, "exit code");
    setEqual(
      gate.suites,
      ["tests/handler_test.ts", SMOKE],
      "policy and smoke suites",
    );
    equal(gate.invocations.length, 3, "tsc + route + smoke invocations");
  }));

test("fast gate runs this harness test when gate tooling changes", () =>
  withScratch(async (scratch) => {
    await touch(scratch.dir, "tools/extra.sh");
    const gate = await fastGate(scratch);
    equal(gate.code, 0, "exit code");
    setEqual(gate.suites, [...ROUTE_SUITES, SMOKE, GATE], "selected suites");
    equal(
      gate.invocations.length,
      4,
      "tsc + route + smoke + harness invocations",
    );
  }));

test("fast gate refuses an unmapped path", () =>
  withScratch(async (scratch) => {
    await touch(scratch.dir, "src/unknown_widget.ts");
    const gate = await fastGate(scratch);
    equal(gate.code, 1, "exit code");
    includes(
      gate.stderr,
      "Unmapped changed path: src/unknown_widget.ts",
      "refusal",
    );
    equal(gate.invocations.length, 0, "no suite ran after refusal");
  }));

test("fast gate with no diff still runs every suite", () =>
  withScratch(async (scratch) => {
    const gate = await fastGate(scratch);
    equal(gate.code, 0, "exit code");
    setEqual(gate.suites, [...ROUTE_SUITES, SMOKE], "selected suites");
  }));

test("full gate runs tsc, all Workers suites, then the Node smoke suite", () =>
  withScratch(async (scratch) => {
    const result = await run(["bash", "tools/full-gate.sh"], {
      cwd: scratch.dir,
      env: scratch.env,
    });
    equal(result.code, 0, "exit code");
    const log = await fs.readFile(path.join(scratch.dir, "npx.log"), "utf8");
    const invocations = log.split("\n").filter((line) => line.length > 0);
    equal(invocations.length, 3, "tsc + workers suites + smoke invocations");
    equal(invocations[0], "tsc --noEmit", "runs strict typecheck");
    const workerSuites = invocations[1]
      .split(/\s+/)
      .filter((token) => token.startsWith("tests/"));
    setEqual(
      workerSuites,
      ROUTE_SUITES,
      "full gate workers suite list is exactly the pinned set",
    );
    if (invocations[1].includes(SMOKE)) {
      fail("smoke must run in the third, Node invocation");
    }
    includes(invocations[2], SMOKE, "smoke invocation");
    includes(invocations[2], "vitest.node.config.ts", "smoke node config");
  }));

test("fast gate covers every src route that imports the shared lib/utils.ts", () =>
  withScratch(async (scratch) => {
    await touch(scratch.dir, "src/lib/utils.ts");
    const base = await fastGate(scratch);
    equal(base.code, 0, "exit code");
    setEqual(
      base.suites,
      [
        "tests/api_version_test.ts",
        "tests/client_test.ts",
        "tests/deprecations_test.ts",
        "tests/feature_test.ts",
        "tests/feed_test.ts",
        "tests/handler_test.ts",
        "tests/history_test.ts",
        "tests/http_smoke_test.ts",
        "tests/index_test.ts",
        "tests/timeline_test.ts",
      ],
      "suites selected for src/lib/utils.ts",
    );
    const importers = (await utilsImporters()).filter((rel) =>
      rel.startsWith("src/routes/")
    );
    if (importers.length === 0) {
      fail(
        "discovery found no src/routes importer of lib/utils.ts — the scan is broken",
      );
    }
    for (const importer of importers) {
      await withScratch(async (probe) => {
        await touch(probe.dir, importer);
        const gate = await fastGate(probe);
        equal(gate.code, 0, `exit code for ${importer}`);
        const uncovered = gate.suites.filter(
          (suite) => !base.suites.includes(suite),
        );
        if (uncovered.length > 0) {
          fail(
            `${importer} imports lib/utils.ts, but its suites (${uncovered.join(", ")}) are not selected when the shared util changes`,
          );
        }
      });
    }
  }));

test("coverage contract declares only transitively loaded paths and matches the gate mapping", async () => {
  const contract = JSON.parse(
    await fs.readFile(
      path.join(repoRoot, ".fleet/coverage-contract.json"),
      "utf8",
    ),
  ) as Record<string, string[]>;
  const keys = Object.keys(contract)
    .filter((key) => !key.startsWith("//"))
    .sort();
  setEqual(
    keys,
    [
      "src/flora.ts",
      "src/lib/buckets.ts",
      "src/lib/linkify.ts",
      "src/lib/lru.ts",
      "src/lib/snapshots.ts",
      "src/lib/url.ts",
      "src/routes/feature-history.ts",
      "src/stream-utils.ts",
      "src/ui-components/*",
    ],
    "contract keys",
  );
  const samples: Record<string, string> = {
    "src/flora.ts": "src/flora.ts",
    "src/lib/linkify.ts": "src/lib/linkify.ts",
    "src/lib/lru.ts": "src/lib/lru.ts",
    "src/lib/url.ts": "src/lib/url.ts",
    "src/lib/buckets.ts": "src/lib/buckets.ts",
    "src/lib/snapshots.ts": "src/lib/snapshots.ts",
    "src/routes/feature-history.ts": "src/routes/feature-history.ts",
    "src/stream-utils.ts": "src/stream-utils.ts",
    "src/ui-components/*": "src/ui-components/probe.ts",
  };
  for (const key of keys) {
    await withScratch(async (probe) => {
      await touch(probe.dir, samples[key]);
      const gate = await fastGate(probe);
      equal(gate.code, 0, `exit code for ${key}`);
      setEqual(gate.suites, contract[key], `suites declared for ${key}`);
    });
  }
});
