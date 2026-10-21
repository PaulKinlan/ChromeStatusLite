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
