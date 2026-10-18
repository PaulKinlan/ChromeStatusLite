// Behavioural test for the gate harness (chrome-status-lite-74e): drives
// tools/fast-gate.sh and tools/full-gate.sh in scratch git repos with a stubbed
// `deno` that records every invocation, and pins .fleet/coverage-contract.json
// to the fast gate's path -> suite mapping.
//
// Deliberately self-contained (no imports): importing tests/fixture.ts would
// make this suite a covering candidate for fixture.ts, and fixture.ts changes
// would then report PARTIAL coverage whenever this suite did not run.

const repoRoot = Deno.cwd();

const ROUTE_SUITES = [
  "tests/client_test.ts",
  "tests/deprecations_test.ts",
  "tests/diff_test.ts",
  "tests/feature_test.ts",
  "tests/handler_test.ts",
  "tests/index_test.ts",
];
const SMOKE = "tests/http_smoke_test.ts";
const GATE = "tests/gate_test.ts";

function fail(message: string): never {
  throw new Error(message);
}

function equal<T>(actual: T, expected: T, context: string): void {
  if (actual !== expected) {
    fail(`${context}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function includes(haystack: string, needle: string, context: string): void {
  if (!haystack.includes(needle)) {
    fail(`${context}: expected ${JSON.stringify(haystack)} to include ${JSON.stringify(needle)}`);
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
  const out = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: opts.cwd,
    env: opts.env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

interface Scratch {
  dir: string;
  env: Record<string, string>;
}

// A scratch repo holding copies of both gate scripts and a stub `deno` (first on
// PATH) that appends every invocation to deno.log, one space-joined line per call.
async function makeScratch(): Promise<Scratch> {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/tools`, { recursive: true });
    await Deno.copyFile(`${repoRoot}/tools/fast-gate.sh`, `${dir}/tools/fast-gate.sh`);
    await Deno.copyFile(`${repoRoot}/tools/full-gate.sh`, `${dir}/tools/full-gate.sh`);
    await Deno.writeTextFile(`${dir}/.gitignore`, "bin/\ndeno.log\n");
    await Deno.mkdir(`${dir}/bin`);
    await Deno.writeTextFile(
      `${dir}/bin/deno`,
      `#!/usr/bin/env bash\necho "$*" >> "${dir}/deno.log"\n[[ " $* " == *" $GATE_FAIL_SUITE "* ]] && exit 1\nexit 0\n`,
    );
    await Deno.chmod(`${dir}/bin/deno`, 0o755);
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
        PATH: `${dir}/bin:${Deno.env.get("PATH") || ""}`,
        GATE_BASE: base,
        GATE_FAIL_SUITE: "__no_such_suite__",
      },
    };
  } catch (error) {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    throw error;
  }
}

// An untracked change the gate's diff collection will pick up.
async function touch(dir: string, rel: string): Promise<void> {
  const slash = rel.lastIndexOf("/");
  if (slash > 0) await Deno.mkdir(`${dir}/${rel.slice(0, slash)}`, { recursive: true });
  await Deno.writeTextFile(`${dir}/${rel}`, "changed\n");
}

// Stage a tracked deletion against the scratch baseline so the gate sees the
// same git diff shape as a real removed file (not merely an absent path).
async function removeTracked(scratch: Scratch, rel: string): Promise<void> {
  await touch(scratch.dir, rel);
  for (const args of [["add", rel], ["commit", "-qm", "add tracked path"], ["rm", "-q", rel]]) {
    const result = await run(["git", ...args], { cwd: scratch.dir });
    equal(result.code, 0, `git ${args.join(" ")}: ${result.stderr}`);
  }
  scratch.env.GATE_BASE = (await run(["git", "rev-parse", "HEAD"], { cwd: scratch.dir })).stdout.trim();
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
  const result = await run(["bash", "tools/fast-gate.sh"], { cwd: scratch.dir, env: scratch.env });
  const log = await Deno.readTextFile(`${scratch.dir}/deno.log`).catch(() => "");
  const invocations = log.split("\n").filter((line) => line.length > 0);
  return { code: result.code, stderr: result.stderr, invocations, suites: suitesOf(invocations) };
}

async function withScratch(fn: (scratch: Scratch) => Promise<void>): Promise<void> {
  const scratch = await makeScratch();
  try {
    await fn(scratch);
  } finally {
    await Deno.remove(scratch.dir, { recursive: true });
  }
}

Deno.test("fast gate maps a static page change to the handler suite plus the always-on smoke", () =>
  withScratch(async (scratch) => {
    await touch(scratch.dir, "static/index.html");
    const gate = await fastGate(scratch);
    equal(gate.code, 0, "exit code");
    setEqual(gate.suites, ["tests/handler_test.ts", SMOKE], "selected suites");
    includes(gate.invocations[1], "--allow-net=127.0.0.1", "smoke sandbox");
  }));

Deno.test("fast gate maps a route change to its own suite plus the smoke", () =>
  withScratch(async (scratch) => {
    await touch(scratch.dir, "src/routes/feature.ts");
    const gate = await fastGate(scratch);
    equal(gate.code, 0, "exit code");
    setEqual(gate.suites, ["tests/feature_test.ts", SMOKE], "selected suites");
  }));

Deno.test("fast gate maps diff route to its focused suite", () =>
  withScratch(async (scratch) => {
    await touch(scratch.dir, "src/routes/diff.ts");
    const gate = await fastGate(scratch);
    equal(gate.code, 0, "exit code");
    setEqual(gate.suites, ["tests/diff_test.ts", SMOKE], "selected suites");
  }));

Deno.test("fast gate maps a deleted route even in a mixed diff, and surfaces its suite failure", () =>
  withScratch(async (scratch) => {
    await removeTracked(scratch, "src/routes/feature.ts");
    await touch(scratch.dir, "src/routes/index.ts");
    scratch.env.GATE_FAIL_SUITE = "tests/feature_test.ts";
    const gate = await fastGate(scratch);
    equal(gate.code, 1, "deleted route's suite failure must fail the gate");
    setEqual(gate.suites, ["tests/feature_test.ts", "tests/index_test.ts"], "selected suites");
    includes(gate.invocations[0], "tests/feature_test.ts", "deleted route's suite ran");
    equal(gate.invocations.length, 1, "gate stops after failed route suites");
  }));

Deno.test("fast gate refuses an unmapped deleted path", () =>
  withScratch(async (scratch) => {
    await removeTracked(scratch, "src/unknown_widget.ts");
    const gate = await fastGate(scratch);
    equal(gate.code, 1, "exit code");
    includes(gate.stderr, "Unmapped changed path: src/unknown_widget.ts", "refusal");
    equal(gate.invocations.length, 0, "no suite ran after refusal");
  }));

Deno.test("fast gate maps shared modules and the smoke test itself to all suites", () =>
  withScratch(async (scratch) => {
    for (const rel of ["src/stream-utils.ts", "tests/http_smoke_test.ts", "main.ts"]) {
      await touch(scratch.dir, rel);
    }
    const gate = await fastGate(scratch);
    equal(gate.code, 0, "exit code");
    setEqual(gate.suites, [...ROUTE_SUITES, SMOKE], "selected suites");
    equal(gate.invocations.length, 2, "route + smoke invocations");
  }));

Deno.test("fast gate runs this harness test when gate tooling changes", () =>
  withScratch(async (scratch) => {
    await touch(scratch.dir, "tools/extra.sh");
    const gate = await fastGate(scratch);
    equal(gate.code, 0, "exit code");
    setEqual(gate.suites, [...ROUTE_SUITES, SMOKE, GATE], "selected suites");
    equal(gate.invocations.length, 3, "route + smoke + harness invocations");
  }));

Deno.test("fast gate refuses an unmapped path", () =>
  withScratch(async (scratch) => {
    await touch(scratch.dir, "src/unknown_widget.ts");
    const gate = await fastGate(scratch);
    equal(gate.code, 1, "exit code");
    includes(gate.stderr, "Unmapped changed path: src/unknown_widget.ts", "refusal");
    equal(gate.invocations.length, 0, "no suite ran after refusal");
  }));

Deno.test("fast gate with no diff still runs every suite", () =>
  withScratch(async (scratch) => {
    const gate = await fastGate(scratch);
    equal(gate.code, 0, "exit code");
    setEqual(gate.suites, [...ROUTE_SUITES, SMOKE], "selected suites");
  }));

Deno.test("full gate runs the offline suites, then the smoke in a wider sandbox", () =>
  withScratch(async (scratch) => {
    const result = await run(["bash", "tools/full-gate.sh"], { cwd: scratch.dir, env: scratch.env });
    equal(result.code, 0, "exit code");
    const log = await Deno.readTextFile(`${scratch.dir}/deno.log`);
    const invocations = log.split("\n").filter((line) => line.length > 0);
    equal(invocations.length, 2, "offline + smoke invocations");
    for (const suite of ROUTE_SUITES) includes(invocations[0], suite, "offline invocation");
    if (invocations[0].includes(SMOKE)) fail("smoke must run in the second, wider invocation");
    includes(invocations[1], SMOKE, "smoke invocation");
    includes(invocations[1], "--allow-net=127.0.0.1", "smoke sandbox");
  }));

Deno.test("coverage contract declares only transitively loaded paths and matches the gate mapping", () =>
  withScratch(async (scratch) => {
    const contract = JSON.parse(await Deno.readTextFile(`${repoRoot}/.fleet/coverage-contract.json`));
    const keys = Object.keys(contract).filter((key) => !key.startsWith("//")).sort();
    // Updating the contract without updating this test fails here on purpose.
    setEqual(keys, ["src/flora.ts", "src/lib/snapshots.ts", "src/routes/feature-history.ts", "src/stream-utils.ts", "src/ui-components/*"], "contract keys");
    const samples: Record<string, string> = {
      "src/flora.ts": "src/flora.ts",
      "src/lib/snapshots.ts": "src/lib/snapshots.ts",
      "src/routes/feature-history.ts": "src/routes/feature-history.ts",
      "src/stream-utils.ts": "src/stream-utils.ts",
      "src/ui-components/*": "src/ui-components/probe.ts",
    };
    for (const key of keys) {
      const probe = await makeScratch();
      try {
        await touch(probe.dir, samples[key]);
        const gate = await fastGate(probe);
        equal(gate.code, 0, `exit code for ${key}`);
        setEqual(gate.suites, contract[key], `suites declared for ${key}`);
      } finally {
        await Deno.remove(probe.dir, { recursive: true });
      }
    }
  }));
