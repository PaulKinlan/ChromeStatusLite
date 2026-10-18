import { createHandler } from "../src/handler.ts";
import { equal, fixtureClient, includes } from "./fixture.ts";

Deno.test("feature detail renders fixture and canonical URL", async () => {
  const response = await createHandler(fixtureClient())(new Request("https://chromestatuslite.com/feature/123?ref=nav"));
  equal(response.status, 200);
  const html = await response.text();
  includes(html, "Fixture feature");
  includes(html, 'href="https://chromestatuslite.com/feature/123?ref=nav"');
  includes(html, "A fixture summary");
});

Deno.test("feature detail exposes impact, flag, WPT and spec maturity", async () => {
  const client = fixtureClient({ getFeature: async () => ({
    id: 123, name: "Metadata feature", summary: "Summary", resources: { docs: [], samples: [] },
    breaking_change: false, enterprise_impact: 2, flag_name: 'test-flag',
    wpt: true, wpt_descr: '<unsafe>test coverage',
    standards: { maturity: { short_text: "Published standard" } },
  }) });
  const html = await (await createHandler(client)(new Request("https://chromestatuslite.com/feature/123"))).text();
  includes(html, "Breaking change:</strong> No");
  includes(html, "Enterprise impact:</strong> Low");
  includes(html, "Chromium flag:</strong> test-flag");
  includes(html, "Web Platform Tests:</strong> Yes");
  includes(html, "Spec maturity:</strong> Published standard");
  includes(html, "WPT details: &lt;unsafe&gt;test coverage");
});

Deno.test("invalid and absent feature ids return 404 without an upstream call", async () => {
  const handler = createHandler(fixtureClient({ getFeature: async () => { throw Error("missing"); } }));
  equal((await handler(new Request("https://chromestatuslite.com/feature/not-a-number"))).status, 404);
  const missing = await handler(new Request("https://chromestatuslite.com/feature/456"));
  equal(missing.status, 404);
  includes(await missing.text(), "Feature not found");
});
