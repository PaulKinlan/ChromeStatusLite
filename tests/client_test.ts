import { ChromeStatusAPI } from "../src/lib/utils.ts";
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
