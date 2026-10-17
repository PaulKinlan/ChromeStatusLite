import { createHandler } from "../src/handler.ts";
import { equal, fixtureClient, includes } from "./fixture.ts";

Deno.test("release page selects version and preserves canonical query", async () => {
  const calls: unknown[] = [];
  const handler = createHandler(fixtureClient({ getFeaturesForVersion: async (version) => {
    calls.push(version);
    return { "Enabled by default": [{ id: 123, name: "Fixture feature", summary: "Fixture summary", resources: { docs: [], samples: [] } }] };
  } }));
  const response = await handler(new Request("https://chromestatuslite.com/?version=112"));
  equal(response.status, 200);
  equal(calls[0], "112");
  const html = await response.text();
  includes(html, '<link rel="canonical" href="https://chromestatuslite.com/?version=112">');
  includes(html, '<a href="?version=112" class="current" aria-current="page">112</a>');
  includes(html, "Fixture feature");
  includes(html, '<details class="more-versions"');
});

Deno.test("release page defaults to latest fixture milestone", async () => {
  const html = await (await createHandler(fixtureClient())(new Request("https://chromestatuslite.com/"))).text();
  includes(html, "Chrome Release 120");
});
