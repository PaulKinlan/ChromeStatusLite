import { test } from "vitest";
import { createHandler } from "../src/handler.ts";
import { equal, fixtureClient, includes } from "./fixture.ts";

test("deprecation calendar renders sorted fixture and stable date", async () => {
  const response = await createHandler({ client: fixtureClient() })(
    new Request("https://chromestatuslite.com/deprecations?view=all"),
  );
  equal(response.status, 200);
  const html = await response.text();
  includes(html, 'href="https://chromestatuslite.com/deprecations?view=all"');
  includes(html, "Deprecated fixture");
  includes(html, "2024-01-01");
  includes(html, "Intent to Deprecate");
});

test("deprecation calendar renders features without a browsers property instead of serving the error notice", async () => {
  const client = fixtureClient({
    getFeaturesByType: async () => ({
      features: [
        {
          id: 1,
          name: "Feature 1",
          intent_stage: "Stage 1",
          browsers: { chrome: { desktop: "120" } },
        },
        { id: 2, name: "Feature 2", intent_stage: "Stage 2" },
        { id: 3, name: "Feature 3", intent_stage: "Stage 3" },
      ],
    }),
  });
  const response = await createHandler({ client })(
    new Request("https://chromestatuslite.com/deprecations"),
  );
  equal(response.status, 200);
  const html = await response.text();
  equal(html.includes("error-notice"), false);
  includes(html, "Feature 1");
  includes(html, "Feature 2");
  includes(html, "Feature 3");
  const feature1 = html.indexOf("Feature 1");
  const feature2 = html.indexOf("Feature 2");
  const feature3 = html.indexOf("Feature 3");
  if (!(feature1 < feature2 && feature1 < feature3)) {
    throw new Error(
      `Expected versioned feature first; got order at ${feature1}, ${feature2}, ${feature3}`,
    );
  }
});

test("versionless deprecations render N/A, not an empty ?version= anchor (chrome-status-lite-5i3)", async () => {
  const client = fixtureClient({
    getFeaturesByType: async () => ({
      features: [
        {
          id: 1,
          name: "Versioned",
          intent_stage: "Intent to Deprecate",
          browsers: { chrome: { desktop: "120" } },
        },
        { id: 2, name: "Versionless", intent_stage: "Intent to Deprecate" },
      ],
    }),
  });
  const html = await (await createHandler({ client })(
    new Request("https://chromestatuslite.com/deprecations"),
  )).text();
  includes(html, 'href="/?version=120"');
  equal(html.includes('href="/?version="'), false);
});

test("deprecation with an empty desktop milestone renders N/A instead of the error notice (chrome-status-lite-b6s)", async () => {
  const client = fixtureClient({
    getFeaturesByType: async () => ({
      features: [
        {
          id: 1,
          name: "Normal",
          intent_stage: "Intent to Deprecate",
          browsers: { chrome: { desktop: "120" } },
        },
        {
          id: 2,
          name: "Pending",
          intent_stage: "Intent to Deprecate",
          browsers: { chrome: { desktop: "" } },
        },
      ],
    }),
  });
  const response = await createHandler({ client })(
    new Request("https://chromestatuslite.com/deprecations"),
  );
  equal(response.status, 200);
  const html = await response.text();
  equal(html.includes("error-notice"), false);
  includes(html, "Normal");
  includes(html, "Pending");
  includes(html, 'href="/?version=120"');
  equal(html.includes('href="/?version="'), false);
});

test("calendar of only empty-desktop deprecations renders every row without the error notice (chrome-status-lite-b6s)", async () => {
  const client = fixtureClient({
    getFeaturesByType: async () => ({
      features: [
        {
          id: 1,
          name: "Pending A",
          intent_stage: "Intent to Deprecate",
          browsers: { chrome: { desktop: "" } },
        },
        {
          id: 2,
          name: "Pending B",
          intent_stage: "Intent to Deprecate",
          browsers: { chrome: { desktop: "" } },
        },
      ],
    }),
  });
  const response = await createHandler({ client })(
    new Request("https://chromestatuslite.com/deprecations"),
  );
  equal(response.status, 200);
  const html = await response.text();
  equal(html.includes("error-notice"), false);
  includes(html, "Pending A");
  includes(html, "Pending B");
});

test("deprecation calendar feature name links to the local /feature/:id route", async () => {
  const response = await createHandler({ client: fixtureClient() })(
    new Request("https://chromestatuslite.com/deprecations?view=all"),
  );
  equal(response.status, 200);
  const html = await response.text();
  includes(html, '<td><a href="/feature/123">Deprecated fixture</a></td>');
  equal(html.includes('href="https://chromestatus.com/feature/'), false);
});

test("deprecation calendar falls back to N/A for an unparseable stable_date", async () => {
  const client = fixtureClient({
    getChannels: async () => ({ "120": { stable_date: "unknown" } }),
  });
  const response = await createHandler({ client })(
    new Request("https://chromestatuslite.com/deprecations?view=all"),
  );
  equal(response.status, 200);
  const html = await response.text();
  includes(html, "Deprecated fixture");
  includes(html, "N/A");
  equal(html.includes("NaN-NaN-NaN"), false);
});

test("deprecation calendar ships no client script: the version picker is gone (chrome-status-lite-3ux)", async () => {
  const html = await (await createHandler({ client: fixtureClient() })(
    new Request("https://chromestatuslite.com/deprecations"),
  )).text();
  equal(html.includes("/scripts/deprecations.js"), false);
  equal(html.includes("<script"), false);
  includes(html, "Deprecation Calendar");
});
