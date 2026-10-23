import { createHandler } from "../src/handler.ts";
import { equal, fixtureClient, includes } from "./fixture.ts";

Deno.test("deprecation calendar renders sorted fixture and stable date", async () => {
  const response = await createHandler(fixtureClient())(new Request("https://chromestatuslite.com/deprecations?view=all"));
  equal(response.status, 200);
  const html = await response.text();
  includes(html, 'href="https://chromestatuslite.com/deprecations?view=all"');
  includes(html, "Deprecated fixture");
  includes(html, "2024-01-01");
  includes(html, "Intent to Deprecate");
});

Deno.test("deprecation calendar falls back to N/A for an unparseable stable_date", async () => {
  const client = fixtureClient({
    getChannels: async () => ({ "120": { stable_date: "unknown" } }),
  });
  const response = await createHandler(client)(new Request("https://chromestatuslite.com/deprecations?view=all"));
  equal(response.status, 200);
  const html = await response.text();
  includes(html, "Deprecated fixture");
  includes(html, "N/A");
  equal(html.includes("NaN-NaN-NaN"), false);
});
