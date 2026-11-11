import { ChromeStatusAPI, UpstreamFetchBudgetError } from "../src/lib/utils.ts";
import { StripStream } from "../src/stream-utils.ts";
import { equal } from "./fixture.ts";

Deno.test("isolated API client caches responses until the fixture clock expires", async () => {
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
      return new Response(`)]}'\n${JSON.stringify({ id: 123, name: `fixture-${calls}` })}`);
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

Deno.test("fetchJson throws on non-2xx HTTP responses", async () => {
  const client = new ChromeStatusAPI({
    fetcher: async () => {
      return new Response(JSON.stringify({ error: "Internal Server Error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    },
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

Deno.test("retryable upstream failures are negative-cached: N requests make one upstream call", async () => {
  // A 5xx during an upstream outage used to be re-issued by every incoming
  // request, amplifying traffic 1:1 onto chromestatus.com. Inside the
  // negative-cache window the remembered error must be rethrown instead.
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

Deno.test("fetch-throw (network/timeout) failures are negative-cached too", async () => {
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

Deno.test("a negative-cache entry expires and the path is re-fetched upstream", async () => {
  let calls = 0;
  const client = new ChromeStatusAPI({
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
  // Still inside the window: remembered error, no new upstream call.
  caught = false;
  try {
    await client.getFeature(123);
  } catch {
    caught = true;
  }
  equal(caught, true);
  equal(calls, 1);
  // Past the TTL the entry must expire: the next request re-fetches and a
  // recovered upstream is served.
  await new Promise((resolve) => setTimeout(resolve, 60));
  equal((await client.getFeature(123)).id, 123);
  equal(calls, 2);
});

Deno.test("client errors (404) are not negative-cached", async () => {
  // A 404 reflects the path, not upstream health: every request must reach
  // upstream so a resource that appears later is picked up immediately.
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

Deno.test("concurrent requests to one failing path share one upstream call (chrome-status-lite-9da)", async () => {
  // Before coalescing, a burst overlapping the slow first attempt all missed
  // the (negative) cache and each issued its own upstream call: 20
  // concurrent requests during an outage made 20 upstream calls.
  let calls = 0;
  const client = new ChromeStatusAPI({
    fetcher: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response("down", { status: 503 });
    },
  });
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () => client.getFeature(123)),
  );
  equal(calls, 1);
  for (const result of results) equal(result.status, "rejected");
  // The shared rejection is also the negative-cached one: the next
  // sequential request is served from the negative cache.
  let caught = false;
  try {
    await client.getFeature(123);
  } catch {
    caught = true;
  }
  equal(caught, true);
  equal(calls, 1);
});

Deno.test("concurrent requests to one healthy path share one upstream call", async () => {
  let calls = 0;
  const client = new ChromeStatusAPI({
    fetcher: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(`)]}'\n${JSON.stringify({ id: 123 })}`);
    },
  });
  const results = await Promise.all(
    Array.from({ length: 10 }, () => client.getFeature(123)),
  );
  equal(calls, 1);
  for (const result of results) equal(result.id, 123);
});

Deno.test("getFeaturesForVersion sends the milestone as one encoded upstream parameter", async () => {
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

Deno.test("getFeaturesForVersion canonicalises the cache key per integer milestone", async () => {
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

Deno.test("getChannels sends the range as two encoded upstream parameters", async () => {
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

Deno.test("getChannels canonicalises the cache key per integer range", async () => {
  // Raw upstream-derived strings used to be interpolated into the shared LRU
  // key, so "120&num=1" and 120 minted two entries and an unbounded number
  // of distinct strings could flush the whole cache (chrome-status-lite-3tl).
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

Deno.test("getChannels rejects bounds that are not integers", async () => {
  const client = new ChromeStatusAPI({ fetcher: async () => new Response("{}") });
  let caught = false;
  try {
    await client.getChannels("<script>alert(1)</script>", "121");
  } catch (err) {
    caught = true;
    equal((err as Error).message.includes("Invalid channel range"), true);
  }
  equal(caught, true);
});

Deno.test("getChannels without both bounds keeps requesting the bare channels path", async () => {
  const urlFor = async (
    run: (client: ChromeStatusAPI) => Promise<unknown>,
  ): Promise<string> => {
    const seen: string[] = [];
    const client = new ChromeStatusAPI({
      fetcher: async (input) => {
        seen.push(String(input));
        return new Response(`)]}'\n${JSON.stringify({ dev: { version: "5" } })}`);
      },
    });
    await run(client);
    return seen[0];
  };
  // Missing bounds (getVersions(), origin-trials' unbounded call) and a
  // single bound must both keep the bare path, never a partial query.
  equal(
    await urlFor((client) => client.getChannels()),
    "https://chromestatus.com/api/v0/channels",
  );
  equal(
    await urlFor((client) => client.getChannels(120, undefined)),
    "https://chromestatus.com/api/v0/channels",
  );
});

Deno.test("getFeaturesForVersion rejects milestones that are not integers", async () => {
  const client = new ChromeStatusAPI({ fetcher: async () => new Response("{}") });
  let caught = false;
  try {
    await client.getFeaturesForVersion("<script>alert(1)</script>");
  } catch (err) {
    caught = true;
    equal((err as Error).message.includes("Invalid milestone"), true);
  }
  equal(caught, true);
});

Deno.test("fetchJson passes an AbortSignal to the fetcher", async () => {
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

Deno.test("a stalled upstream times out and surfaces as a thrown error, not a hang", async () => {
  // A fetcher that accepts the connection and then stalls forever, only
  // settling when the passed signal aborts — the chromestatus.com failure
  // mode that used to park route handlers indefinitely.
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
  // Generous bound: must be far below the production default (15 s), proving
  // the configured timeout fired rather than the test merely racing it.
  equal(elapsed < 5000, true);
});

Deno.test("an upstream body past the byte cap is rejected", async () => {
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

Deno.test("an upstream response with no body throws instead of hanging", async () => {
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

Deno.test("getVersions returns a bounded descending list for a well-formed channels payload", async () => {
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

Deno.test("getVersions rejects malformed dev.version with a plain error, not a RangeError", async () => {
  // Missing, non-numeric, negative and null-payload variants all used to hit
  // an unguarded Array(NaN | -3) and throw an uncatchable-shaped RangeError.
  const payloads = [
    {},
    { dev: {} },
    { dev: { version: "not-a-number" } },
    { dev: { version: "-3" } },
    null,
  ];
  for (const payload of payloads) {
    const client = new ChromeStatusAPI({
      fetcher: async () =>
        new Response(`)]}'\n${JSON.stringify(payload)}`),
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

Deno.test("getVersions rejects an implausibly large dev.version instead of materialising it", async () => {
  // Array(1e9) used to be materialised (~8 GB) before .reverse() — an OOM the
  // route-level try/catch can never run in.
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

Deno.test("getVersions evicts a malformed cached channels body so the next request re-fetches", async () => {
  // A malformed-but-parseable body used to stay cached for CACHE_MAX_AGE (1h),
  // so every version route stayed in error notices long after upstream fixed
  // itself. The invalid payload must be evicted: fetch #2 must actually happen
  // and a recovered payload must be served.
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

Deno.test("getVersions still rejects with a plain error on a cache without del", async () => {
  // get/set-only doubles (older fixtures) must keep working: eviction is
  // best-effort (the real LRU's delete-by-key is named `del`), the guard
  // itself is not conditional on it.
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

Deno.test("uncached feature-detail fetches are budgeted, cached ones are free (chrome-status-lite-d9s)", async () => {
  // Feature ids are shape-validated only (1-16 digits), so the accepted set
  // is ~10^16 and every distinct uncached id would otherwise cost an
  // upstream round trip: one client could drive chromestatus.com 1:1. The
  // bucket caps that aggregate rate at `burst`, and only for work that
  // really reaches upstream.
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
  // The refusal is local: no upstream call, and it must not be cached as an
  // error, so after the wait the same id is a clean fetch.
  equal(calls, 3);

  // A cache hit (the first client_test case above proves hits do not refetch)
  // must not be charged either: repeat an already-cached id while the bucket
  // is empty and it still resolves.
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
  // Bucket now empty; the cached id resolves without a token.
  equal((await cachedClient.getFeature("7")).id, 7);

  // Refill is time-based: one second later exactly one more uncached fetch
  // is allowed, and the bucket is empty again immediately after.
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

Deno.test("a live negative cache entry does not consume the fetch budget (chrome-status-lite-d9s)", async () => {
  // Only a genuine upstream round trip is charged: an id whose retryable
  // failure is remembered is answered from the negative cache, so repeat
  // requests inside the window must not burn tokens (they would otherwise
  // turn an upstream outage into a self-inflicted 429).
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

Deno.test("StripStream drops the XSSI prefix across chunk boundaries, and only at the body start (chrome-status-lite-95fa)", async () => {
  // chromestatus.com guards its JSON with ")]}'\n". The decision used to be
  // taken on chunk ONE alone, so a chunk boundary inside the prefix - legal, an
  // HTTP/2 frame or a proxy may deliver one to four bytes first - left the
  // prefix in the body, JSON.parse threw and fetchJson marked the whole read
  // failed. The stream now waits for five bytes (or the end of a shorter body)
  // before deciding.
  const encoder = new TextEncoder();
  const strip = async (chunks: (string | Uint8Array)[]): Promise<string> => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        }
        controller.close();
      },
    });
    return new TextDecoder().decode(await new Response(stream.pipeThrough(new StripStream())).bytes());
  };

  // Stripped, and the rest of the body survives byte for byte (UTF-8 included,
  // so the slice is by bytes and not by characters).
  equal(await strip([`)]}'\n${'{"name":"Chrome ✓"}'}`]), '{"name":"Chrome ✓"}');
  // ... and every way the prefix can be split across chunks.
  equal(await strip([")", "]}'\n{\"a\":1}"]), '{"a":1}');
  equal(await strip([")]", "}'\n{\"a\":1}"]), '{"a":1}');
  equal(await strip([")]}'", "\n{\"a\":1}"]), '{"a":1}');
  equal(await strip([")", "]", "}", "'", "\n{\"a\":1}"]), '{"a":1}');

  // No prefix: the body passes through untouched, including one shorter than
  // the prefix and one whose first chunk is a single byte.
  equal(await strip(['{"a":1}']), '{"a":1}');
  equal(await strip(["{}"]), "{}");
  equal(await strip(["{", '"a":1}']), '{"a":1}');
  // Only the body start is inspected, so a prefix-looking run later is data.
  equal(await strip(['{"a":1}', ")]}'\n"]), `{"a":1})]}'\n`);

  // A prefix with no body, and no body at all.
  equal(await strip([")]}'\n"]), "");
  equal(await strip([]), "");

  // After the decision every later chunk is forwarded untouched.
  equal(await strip([")]}'\n", '{"a":', "1}"]), '{"a":1}');
});
