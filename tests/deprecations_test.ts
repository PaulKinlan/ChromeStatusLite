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

Deno.test("deprecation calendar renders features without a browsers property instead of serving the error notice", async () => {
  const client = fixtureClient({
    getFeaturesByType: async () => ({
      features: [
        { id: 1, name: "Feature 1", intent_stage: "Stage 1", browsers: { chrome: { desktop: "120" } } },
        { id: 2, name: "Feature 2", intent_stage: "Stage 2" },
        { id: 3, name: "Feature 3", intent_stage: "Stage 3" },
      ],
    }),
  });
  const response = await createHandler(client)(new Request("https://chromestatuslite.com/deprecations"));
  equal(response.status, 200);
  const html = await response.text();
  equal(html.includes("error-notice"), false);
  includes(html, "Feature 1");
  includes(html, "Feature 2");
  includes(html, "Feature 3");
  // Features without a desktop version sort to the end of the table.
  const feature1 = html.indexOf("Feature 1");
  const feature2 = html.indexOf("Feature 2");
  const feature3 = html.indexOf("Feature 3");
  if (!(feature1 < feature2 && feature1 < feature3)) {
    throw new Error(`Expected versioned feature first; got order at ${feature1}, ${feature2}, ${feature3}`);
  }
});

Deno.test("deprecation calendar feature name links to the local /feature/:id route", async () => {
  const response = await createHandler(fixtureClient())(new Request("https://chromestatuslite.com/deprecations?view=all"));
  equal(response.status, 200);
  const html = await response.text();
  includes(html, '<td><a href="/feature/123">Deprecated fixture</a></td>');
  equal(html.includes('href="https://chromestatus.com/feature/'), false);
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
