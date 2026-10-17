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
