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

Deno.test("feature detail renders ecosystem cross-links from the feature name", async () => {
  const client = fixtureClient({ getFeature: async () => ({
    id: 123, name: "View Transitions", summary: "A fixture summary",
    resources: { docs: [], samples: [] },
  }) });
  const html = await (await createHandler(client)(new Request("https://chromestatuslite.com/feature/123"))).text();
  includes(html, 'href="https://wpt.fyi/results/?q=view-transitions"');
  includes(html, 'href="https://chrome-platform-showcase.paulkinlan-ea.deno.net/features"');
  includes(html, 'href="https://gendn.paulkinlan-ea.deno.net/features"');
  includes(html, 'href="https://www.google.com/search?q=site%3Achrome.dev+View%20Transitions"');
  includes(html, 'href="https://developer.mozilla.org/en-US/search?q=View%20Transitions"');
  includes(html, 'href="https://webstatus.dev/?q=View%20Transitions"');
  equal((html.match(/rel="noopener noreferrer"/g) || []).length >= 6, true);
});

Deno.test("feature detail omits the ecosystem section when the feature has no name", async () => {
  const client = fixtureClient({ getFeature: async () => ({
    id: 124, name: "", summary: "Anonymous",
    resources: { docs: [], samples: [] },
  }) });
  const html = await (await createHandler(client)(new Request("https://chromestatuslite.com/feature/124"))).text();
  equal(html.includes("<h2>Ecosystem</h2>"), false);
  equal(html.includes("wpt.fyi/results/?q="), false);
});
