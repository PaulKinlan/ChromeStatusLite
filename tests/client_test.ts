import { test } from "vitest";
import {
  ChromeStatusAPI,
  formatStableDate,
  UpstreamFetchBudgetError,
} from "../src/lib/utils.ts";
import { StripStream } from "../src/stream-utils.ts";
import { equal } from "./fixture.ts";

test("isolated API client caches responses until the fixture clock expires", async () => {
  let now = 1000;
  let calls = 0;
  const entries = new Map<string, { value: unknown; expires: number }>();
  const cache = {
    get(path: string) {
      const entry = entries.get(path);
      return entry && now < entry.expires ? entry.value : undefined;
    },
    set(path: string, value: unknown) {
      entries.set(path, { value, expires: now + 60 });
      return this;
    },
  };
  const client = new ChromeStatusAPI({
    cache,
    fetcher: async (input) => {
      equal(String(input), "https://chromestatus.com/api/v0/features/123");
      calls++;
      return new Response(
        `)]}'\n${JSON.stringify({ id: 123, name: `fixture-${calls}` })}`,
      );
    },
  });
  equal((await client.getFeature(123)).name, "fixture-1");
  now += 59;
  equal((await client.getFeature(123)).name, "fixture-1");
  equal(calls, 1);
  now++;
  equal((await client.getFeature(123)).name, "fixture-2");
  equal(calls, 2);
});

test("fetchJson throws on non-2xx HTTP responses", async () => {
  const client = new ChromeStatusAPI({
    fetcher: async () =>
      new Response(JSON.stringify({ error: "Internal Server Error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
  });

  let caught = false;
  try {
    await client.getFeature(999);
  } catch (err) {
    caught = true;
    equal((err as Error).message.includes("Upstream HTTP 500"), true);
  }
  equal(caught, true);
});

test("retryable upstream failures are negative-cached: N requests make one upstream call", async () => {
  let calls = 0;
  const client = new ChromeStatusAPI({
    negativeCacheMaxAge: 60_000,
    fetcher: async () => {
      calls++;
      return new Response("boom", { status: 503 });
    },
  });
  for (let i = 0; i < 5; i++) {
    let caught: Error | undefined;
    try {
      await client.getFeature(123);
    } catch (err) {
      caught = err as Error;
    }
    equal(caught instanceof Error, true);
    equal(caught!.message.includes("Upstream HTTP 503"), true);
  }
  equal(calls, 1);
});

test("fetch-throw (network/timeout) failures are negative-cached too", async () => {
  let calls = 0;
  const client = new ChromeStatusAPI({
    negativeCacheMaxAge: 60_000,
    fetcher: async () => {
      calls++;
      throw new Error("connection refused");
    },
  });
  for (let i = 0; i < 3; i++) {
    let caught = false;
    try {
      await client.getFeature(123);
    } catch (err) {
      caught = true;
      equal((err as Error).message.includes("Upstream fetch failed"), true);
    }
    equal(caught, true);
  }
  equal(calls, 1);
});

test("a negative-cache entry expires and the path is re-fetched upstream", async () => {
  let now = 1000;
  let calls = 0;
  const client = new ChromeStatusAPI({
    now: () => now,
    negativeCacheMaxAge: 30,
    fetcher: async () => {
      calls++;
      if (calls === 1) return new Response("boom", { status: 500 });
      return new Response(`)]}'\n${JSON.stringify({ id: 123 })}`);
    },
  });
  let caught = false;
  try {
    await client.getFeature(123);
  } catch {
    caught = true;
  }
  equal(caught, true);
  caught = false;
  try {
    await client.getFeature(123);
  } catch {
    caught = true;
  }
  equal(caught, true);
  equal(calls, 1);
  now += 60;
  equal((await client.getFeature(123)).id, 123);
  equal(calls, 2);
});

test("client errors (404) are not negative-cached", async () => {
  let calls = 0;
  const client = new ChromeStatusAPI({
    negativeCacheMaxAge: 60_000,
    fetcher: async () => {
      calls++;
      return new Response("not found", { status: 404 });
    },
  });
  for (let i = 0; i < 3; i++) {
    let caught = false;
    try {
      await client.getFeature(123);
    } catch (err) {
      caught = true;
      equal((err as Error).message.includes("Upstream HTTP 404"), true);
    }
    equal(caught, true);
  }
  equal(calls, 3);
});

test("concurrent requests to one failing path share one upstream call (chrome-status-lite-9da)", async () => {
  let calls = 0;
  const client = new ChromeStatusAPI({
    fetcher: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response("down", { status: 503 });
    },
  });
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () => client.getFeature(123)),
  );
  equal(calls, 1);
  for (const result of results) equal(result.status, "rejected");
  let caught = false;
  try {
    await client.getFeature(123);
  } catch {
    caught = true;
  }
  equal(caught, true);
  equal(calls, 1);
});

test("concurrent requests to one healthy path share one upstream call", async () => {
  let calls = 0;
  const client = new ChromeStatusAPI({
    fetcher: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return new Response(`)]}'\n${JSON.stringify({ id: 123 })}`);
    },
  });
  const results = await Promise.all(
    Array.from({ length: 10 }, () => client.getFeature(123)),
  );
  equal(calls, 1);
  for (const result of results) equal(result.id, 123);
});

test("getFeaturesForVersion sends the milestone as one encoded upstream parameter", async () => {
  const seen: string[] = [];
  const client = new ChromeStatusAPI({
    fetcher: async (input) => {
      seen.push(String(input));
      return new Response(`)]}'\n${JSON.stringify({ features_by_type: {} })}`);
    },
  });
  await client.getFeaturesForVersion("120&num=1&q=foo");
  equal(seen[0], "https://chromestatus.com/api/v0/features?milestone=120");
});

test("getFeaturesForVersion canonicalises the cache key per integer milestone", async () => {
  let calls = 0;
  const client = new ChromeStatusAPI({
    fetcher: async () => {
      calls++;
      return new Response(`)]}'\n{"features_by_type":{}}`);
    },
  });
  await client.getFeaturesForVersion("120&num=1");
  await client.getFeaturesForVersion(120);
  equal(calls, 1);
});

test("getChannels sends the range as two encoded upstream parameters", async () => {
  const seen: string[] = [];
  const client = new ChromeStatusAPI({
    fetcher: async (input) => {
      seen.push(String(input));
      return new Response(`)]}'\n${JSON.stringify({})}`);
    },
  });
  await client.getChannels("120&num=1&q=foo", "121");
  equal(seen[0], "https://chromestatus.com/api/v0/channels?start=120&end=121");
});

test("getChannels canonicalises the cache key per integer range", async () => {
  let calls = 0;
  const client = new ChromeStatusAPI({
    fetcher: async () => {
      calls++;
      return new Response(`)]}'\n{}`);
    },
  });
  await client.getChannels("120&num=1", "121");
  await client.getChannels(120, 121);
  equal(calls, 1);
});

test("getChannels rejects bounds that are not integers", async () => {
  const client = new ChromeStatusAPI({
    fetcher: async () => new Response("{}"),
  });
  let caught = false;
  try {
    await client.getChannels("<script>alert(1)</script>", "121");
  } catch (err) {
    caught = true;
    equal((err as Error).message.includes("Invalid channel range"), true);
  }
  equal(caught, true);
});

test("getChannels without both bounds keeps requesting the bare channels path", async () => {
  const urlFor = async (
    run: (client: ChromeStatusAPI) => Promise<unknown>,
  ): Promise<string> => {
    const seen: string[] = [];
    const client = new ChromeStatusAPI({
      fetcher: async (input) => {
        seen.push(String(input));
        return new Response(
          `)]}'\n${JSON.stringify({ dev: { version: "5" } })}`,
        );
      },
    });
    await run(client);
    return seen[0];
  };
  equal(
    await urlFor((client) => client.getChannels()),
    "https://chromestatus.com/api/v0/channels",
  );
  equal(
    await urlFor((client) => client.getChannels(120, undefined)),
    "https://chromestatus.com/api/v0/channels",
  );
});

test("getFeaturesForVersion rejects milestones that are not integers", async () => {
  const client = new ChromeStatusAPI({
    fetcher: async () => new Response("{}"),
  });
  let caught = false;
  try {
    await client.getFeaturesForVersion("<script>alert(1)</script>");
  } catch (err) {
    caught = true;
    equal((err as Error).message.includes("Invalid milestone"), true);
  }
  equal(caught, true);
});

test("fetchJson passes an AbortSignal to the fetcher", async () => {
  let seenSignal: AbortSignal | undefined;
  const client = new ChromeStatusAPI({
    fetcher: async (_input, init) => {
      seenSignal = init?.signal ?? undefined;
      return new Response(`)]}'\n{}`);
    },
  });
  await client.getFeature(1);
  equal(seenSignal instanceof AbortSignal, true);
});

test("a stalled upstream times out and surfaces as a thrown error, not a hang", async () => {
  const started = Date.now();
  const client = new ChromeStatusAPI({
    timeoutMs: 5,
    fetcher: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation timed out", "TimeoutError"))
        );
      }),
  });
  let caught: Error | undefined;
  try {
    await client.getFeature(123);
  } catch (err) {
    caught = err as Error;
  }
  const elapsed = Date.now() - started;
  equal(caught instanceof Error, true);
  equal(caught!.message.includes("Upstream fetch failed"), true);
  equal(elapsed < 5000, true);
});

test("an upstream body past the byte cap is rejected", async () => {
  const big = "x".repeat(1024);
  const client = new ChromeStatusAPI({
    maxBodyBytes: 64,
    fetcher: async () => new Response(`)]}'\n${big}`),
  });
  let caught: Error | undefined;
  try {
    await client.getFeature(123);
  } catch (err) {
    caught = err as Error;
  }
  equal(caught instanceof Error, true);
  equal(caught!.message.includes("Upstream body read failed"), true);
  equal(caught!.message.includes("exceeded 64 bytes"), true);
});

test("an upstream response with no body throws instead of hanging", async () => {
  const client = new ChromeStatusAPI({
    fetcher: async () => new Response(null),
  });
  let caught: Error | undefined;
  try {
    await client.getFeature(123);
  } catch (err) {
    caught = err as Error;
  }
  equal(caught instanceof Error, true);
  equal(caught!.message.includes("no body"), true);
});

test("getVersions returns a bounded descending list for a well-formed channels payload", async () => {
  const client = new ChromeStatusAPI({
    fetcher: async (input) => {
      equal(String(input), "https://chromestatus.com/api/v0/channels");
      return new Response(
        `)]}'\n${
          JSON.stringify({ dev: { version: "5" }, stable: { version: "3" } })
        }`,
      );
    },
  });
  equal(
    JSON.stringify(await client.getVersions()),
    JSON.stringify([4, 3, 2, 1, 0]),
  );
});

test("getVersions rejects malformed dev.version with a plain error, not a RangeError", async () => {
  const payloads = [
    {},
    { dev: {} },
    { dev: { version: "not-a-number" } },
    { dev: { version: "-3" } },
    null,
  ];
  for (const payload of payloads) {
    const client = new ChromeStatusAPI({
      fetcher: async () => new Response(`)]}'\n${JSON.stringify(payload)}`),
    });
    let caught = false;
    try {
      await client.getVersions();
    } catch (err) {
      caught = true;
      equal(
        (err as Error).message.includes("implausible dev.version"),
        true,
      );
      equal(err instanceof RangeError, false);
    }
    equal(caught, true, `payload ${JSON.stringify(payload)} must reject`);
  }
});

test("getVersions rejects an implausibly large dev.version instead of materialising it", async () => {
  const client = new ChromeStatusAPI({
    fetcher: async () =>
      new Response(`)]}'\n${JSON.stringify({ dev: { version: 1e9 } })}`),
  });
  let caught = false;
  try {
    await client.getVersions();
  } catch (err) {
    caught = true;
    equal((err as Error).message.includes("implausible dev.version"), true);
  }
  equal(caught, true);
});

test("getVersions evicts a malformed cached channels body so the next request re-fetches", async () => {
  let fetches = 0;
  const client = new ChromeStatusAPI({
    fetcher: async () => {
      fetches++;
      const payload = fetches === 1
        ? { dev: { version: "not-a-number" } }
        : { dev: { version: "120" } };
      return new Response(`)]}'\n${JSON.stringify(payload)}`);
    },
  });
  let caught = false;
  try {
    await client.getVersions();
  } catch {
    caught = true;
  }
  equal(caught, true);
  const versions = await client.getVersions();
  equal(fetches, 2);
  equal(versions.length, 120);
});

test("getVersions still rejects with a plain error on a cache without del", async () => {
  const client = new ChromeStatusAPI({
    cache: {
      get: () => undefined,
      set: () => {},
    },
    fetcher: async () =>
      new Response(`)]}'\n${JSON.stringify({ dev: {} })}`),
  });
  let caught = false;
  try {
    await client.getVersions();
  } catch (err) {
    caught = true;
    equal((err as Error).message.includes("implausible dev.version"), true);
  }
  equal(caught, true);
});

test("uncached feature-detail fetches are budgeted, cached ones are free (chrome-status-lite-d9s)", async () => {
  let now = 0;
  let calls = 0;
  const client = new ChromeStatusAPI({
    now: () => now,
    featureFetchBudget: { burst: 3, refillPerSecond: 1 },
    fetcher: async () => {
      calls++;
      return new Response(`)]}'\n${JSON.stringify({ id: calls })}`);
    },
  });

  for (const id of ["101", "102", "103"]) await client.getFeature(id);
  equal(calls, 3);

  let caught: Error | undefined;
  try {
    await client.getFeature("104");
  } catch (err) {
    caught = err as Error;
  }
  equal(caught instanceof UpstreamFetchBudgetError, true);
  equal((caught as UpstreamFetchBudgetError).retryAfterMs, 1000);
  equal(calls, 3);

  const cache = new Map<string, unknown>();
  const cachedClient = new ChromeStatusAPI({
    now: () => now,
    featureFetchBudget: { burst: 1, refillPerSecond: 1 },
    cache: {
      get: (path: string) => cache.get(path),
      set: (path: string, value: unknown) => {
        cache.set(path, value);
        return true;
      },
    },
    fetcher: async () => new Response(`)]}'\n${JSON.stringify({ id: 7 })}`),
  });
  await cachedClient.getFeature("7");
  equal((await cachedClient.getFeature("7")).id, 7);

  now += 1000;
  await client.getFeature("105");
  equal(calls, 4);
  caught = undefined;
  try {
    await client.getFeature("106");
  } catch (err) {
    caught = err as Error;
  }
  equal(caught instanceof UpstreamFetchBudgetError, true);
  equal(calls, 4);
});

test("a live negative cache entry does not consume the fetch budget (chrome-status-lite-d9s)", async () => {
  let now = 0;
  let calls = 0;
  const client = new ChromeStatusAPI({
    now: () => now,
    negativeCacheMaxAge: 60_000,
    featureFetchBudget: { burst: 1, refillPerSecond: 1 },
    fetcher: async () => {
      calls++;
      return new Response("boom", { status: 503 });
    },
  });
  for (let i = 0; i < 4; i++) {
    let caught: Error | undefined;
    try {
      await client.getFeature("999");
    } catch (err) {
      caught = err as Error;
    }
    equal(caught instanceof UpstreamFetchBudgetError, false);
  }
  equal(calls, 1);
});

test("L2 edgeCache serves cached JSON without charging the feature budget or hitting upstream", async () => {
  let upstreamCalls = 0;
  const edgeStore = new Map<string, Response>();
  const edgeCache = {
    match: async (req: Request | string) => {
      const key = typeof req === "string" ? req : req.url;
      return edgeStore.get(key)?.clone();
    },
    put: async (req: Request | string, res: Response) => {
      const key = typeof req === "string" ? req : req.url;
      edgeStore.set(key, res.clone());
    },
  };
  const pending: Promise<unknown>[] = [];
  const firstClient = new ChromeStatusAPI({
    edgeCache,
    waitUntil: (p) => pending.push(p),
    fetcher: async () => {
      upstreamCalls++;
      return new Response(`)]}'\n${JSON.stringify({ id: 42, name: "Edge" })}`);
    },
  });
  equal((await firstClient.getFeature("42")).name, "Edge");
  await Promise.all(pending);
  equal(upstreamCalls, 1);

  // Fresh isolate client (empty L1 cache, burst 0) must still serve from L2 edgeCache.
  const secondClient = new ChromeStatusAPI({
    edgeCache,
    featureFetchBudget: { burst: 0, refillPerSecond: 0 },
    fetcher: async () => {
      upstreamCalls++;
      throw new Error("must not call upstream on L2 hit");
    },
  });
  equal((await secondClient.getFeature("42")).name, "Edge");
  equal(upstreamCalls, 1);
});

test("getWebStatusFeature validates slugs, caches results, and fails open on errors", async () => {
  let calls = 0;
  const client = new ChromeStatusAPI({
    fetcher: async (input) => {
      calls++;
      equal(
        String(input),
        "https://api.webstatus.dev/v1/features/anchor-positioning",
      );
      return new Response(
        JSON.stringify({
          feature_id: "anchor-positioning",
          baseline: { status: "newly", low_date: "2026-09-14" },
        }),
      );
    },
  });

  // Invalid slugs are rejected without touching the network.
  equal(await client.getWebStatusFeature("../etc/passwd"), null);
  equal(await client.getWebStatusFeature("Missing feature"), null);
  equal(calls, 0);

  const first = await client.getWebStatusFeature("anchor-positioning");
  equal(first?.baseline?.status, "newly");
  const second = await client.getWebStatusFeature("anchor-positioning");
  equal(second?.baseline?.low_date, "2026-09-14");
  equal(calls, 1);

  // Network/HTTP failures fail open (return null).
  const failing = new ChromeStatusAPI({
    fetcher: async () => new Response("err", { status: 503 }),
  });
  equal(await failing.getWebStatusFeature("anchor-positioning"), null);
});

test("formatStableDate always formats in UTC regardless of timezone", () => {
  equal(formatStableDate("2024-01-01T00:00:00Z"), "2024-01-01");
  equal(formatStableDate("2024-03-15T23:59:59Z"), "2024-03-15");
  equal(formatStableDate("unknown"), null);
  equal(formatStableDate(""), null);
  equal(formatStableDate(null), null);
});

test("StripStream drops the XSSI prefix across chunk boundaries, and only at the body start (chrome-status-lite-95fa)", async () => {
  const encoder = new TextEncoder();
  const strip = async (chunks: (string | Uint8Array)[]): Promise<string> => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(
            typeof chunk === "string" ? encoder.encode(chunk) : chunk,
          );
        }
        controller.close();
      },
    });
    const bytes = await new Response(
      stream.pipeThrough(new StripStream()),
    ).arrayBuffer();
    return new TextDecoder().decode(bytes);
  };

  equal(
    await strip([`)]}'\n${'{"name":"Chrome ✓"}'}`]),
    '{"name":"Chrome ✓"}',
  );
  equal(await strip([")", "]}'\n{\"a\":1}"]), '{"a":1}');
  equal(await strip([")]", "}'\n{\"a\":1}"]), '{"a":1}');
  equal(await strip([")]}'", "\n{\"a\":1}"]), '{"a":1}');
  equal(await strip([")", "]", "}", "'", "\n{\"a\":1}"]), '{"a":1}');
  equal(await strip(['{"a":1}']), '{"a":1}');
  equal(await strip(["{}"]), "{}");
  equal(await strip(["{", '"a":1}']), '{"a":1}');
  equal(await strip(['{"a":1}', ")]}'\n"]), `{"a":1})]}'\n`);
  equal(await strip([")]}'\n"]), "");
  equal(await strip([]), "");
  equal(await strip([")]}'\n", '{"a":', "1}"]), '{"a":1}');
});
