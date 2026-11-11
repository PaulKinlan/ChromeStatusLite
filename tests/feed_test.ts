import { createHandler } from "../src/handler.ts";
import feed from "../src/routes/feed.ts";
import { equal, fixtureClient, includes, sampleFeature } from "./fixture.ts";

Deno.test("feed route module executes directly with injected client", async () => {
  const res = await feed(new Request("https://chromestatuslite.com/feed.xml"), fixtureClient());
  equal(res.status, 200);
  includes(await res.text(), "Chrome 120");
});

Deno.test("feed.xml serves valid RSS 2.0 with milestones and feature summaries", async () => {
  const handler = createHandler(fixtureClient());
  const res = await handler(new Request("https://chromestatuslite.com/feed.xml"));
  equal(res.status, 200);
  includes(res.headers.get("content-type") || "", "application/rss+xml");
  includes(res.headers.get("cache-control") || "", "max-age=3600");
  const xml = await res.text();
  includes(xml, '<?xml version="1.0" encoding="UTF-8"?>');
  includes(xml, '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">');
  includes(xml, "<title>Chrome Status Lite</title>");
  includes(xml, "<link>https://chromestatuslite.com/</link>");
  includes(xml, '<atom:link href="https://chromestatuslite.com/feed.xml" rel="self" type="application/rss+xml"/>');
  includes(xml, "<title>Chrome 120</title>");
  includes(xml, "<link>https://chromestatuslite.com/?version=120</link>");
  includes(xml, '<guid isPermaLink="true">https://chromestatuslite.com/?version=120</guid>');
  includes(xml, "<pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>");
  includes(xml, "Enabled by default (1)");
  includes(xml, "Fixture feature");
  includes(xml, "https://chromestatuslite.com/feature/123");
});

Deno.test("feed.xml strips XML-1.0-illegal chars from upstream names and summaries", async () => {
  const client = fixtureClient({
    getFeaturesForVersion: async () => ({
      "Enabled by default": [{ ...sampleFeature, name: "Bad\u0001Na\u000Bme\uFFFEMid\uD800End", summary: "Summary\u000C with\u001F controls\uFFFF" }],
    }),
  });
  const res = await createHandler(client)(new Request("https://chromestatuslite.com/feed.xml"));
  equal(res.status, 200);
  const xml = await res.text();
  // Control chars, noncharacters and lone surrogates are all legal in JSON
  // (so they survive JSON.parse upstream) but illegal in XML 1.0 — and one
  // illegal codepoint anywhere makes every parser reject the whole feed, so
  // scan the entire document, not just the item.
  const illegal = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  equal(illegal.test(xml), false);
  // The legible text around the stripped chars survives.
  includes(xml, "BadNameMidEnd");
  includes(xml, "Summary with controls");
});

Deno.test("feed.xml omits pubDate for an unparseable stable_date", async () => {
  const handler = createHandler(fixtureClient({
    getVersions: async () => [120, 119],
    getChannels: async () => ({
      "120": { stable_date: "unknown" },
      "119": { stable_date: "2024-03-01T00:00:00Z" },
    }),
    getFeaturesForVersion: async (v) => ({ "Enabled by default": [{ id: v, name: `Feature ${v}` }] }),
  }));
  const res = await handler(new Request("https://chromestatuslite.com/feed.xml?limit=2"));
  equal(res.status, 200);
  const xml = await res.text();
  equal(xml.includes("Invalid Date"), false);
  includes(xml, "<pubDate>Fri, 01 Mar 2024 00:00:00 GMT</pubDate>");
  // The unparseable milestone item renders without any pubDate element.
  const item120 = xml.split("<item>").find((s) => s.includes("Chrome 120")) || "";
  equal(item120.includes("<pubDate>"), false);
});

Deno.test("feed.xml includes all dynamic upstream buckets like Stepped rollout", async () => {
  const client = fixtureClient({
    getVersions: async () => [157],
    getFeaturesForVersion: async () => ({
      "Enabled by default": [{ id: 1, name: "Default feature" }],
      "Stepped rollout": [{ id: 2, name: "Stepped feature" }],
    }),
  });
  const res = await (await createHandler(client)(new Request("https://chromestatuslite.com/feed.xml"))).text();
  includes(res, "includes 2 feature changes");
  includes(res, "Enabled by default (1)");
  includes(res, "Stepped rollout (1)");
  includes(res, "Stepped feature");
});

Deno.test("feed.xml sanitizes feature id and prevents attribute injection in CDATA", async () => {
  const client = fixtureClient({
    getVersions: async () => [120],
    getFeaturesForVersion: async () => ({
      "Enabled by default": [{ id: '9" onmouseover="alert(1)', name: "Hostile ID" }],
    }),
  });
  const xml = await (await createHandler(client)(new Request("https://chromestatuslite.com/feed.xml"))).text();
  equal(xml.includes('onmouseover="alert(1)"'), false);
  includes(xml, "9%22%20onmouseover%3D%22alert(1)");
});

Deno.test("feed.xml shows an outage notice, not a zero-claim, for mixed malformed buckets", async () => {
  const handler = createHandler(fixtureClient({
    getVersions: async () => [140],
    getFeaturesForVersion: async () => ({ "Enabled by default": [], "Deprecated": null }),
  }));

  const res = await handler(new Request("https://chromestatuslite.com/feed.xml?limit=1"));
  equal(res.status, 200);
  const text = await res.text();
  includes(text, "Unable to load feature data for Chrome 140");
  equal(text.includes("includes 0 feature changes"), false);
});

Deno.test("feed.xml shows an outage notice for a payload with no recognised buckets", async () => {
  const handler = createHandler(fixtureClient({
    getVersions: async () => [140],
    getFeaturesForVersion: async () => ({ nonsense: "text" }),
  }));

  const res = await handler(new Request("https://chromestatuslite.com/feed.xml?limit=1"));
  equal(res.status, 200);
  const text = await res.text();
  includes(text, "Unable to load feature data for Chrome 140");
  equal(text.includes("includes 0 feature changes"), false);
});

Deno.test("feed.xml keeps a genuine empty milestone as valid data with a zero count", async () => {
  const handler = createHandler(fixtureClient({
    getVersions: async () => [200],
    getFeaturesForVersion: async () => ({
      "Enabled by default": [],
      "Deprecated": [],
      "Removed": [],
      "Stepped rollout": [],
      "Origin trial": [],
      "In developer trial (Behind a flag)": [],
      total_count: 0,
    }),
  }));

  const res = await handler(new Request("https://chromestatuslite.com/feed.xml?limit=1"));
  equal(res.status, 200);
  const text = await res.text();
  includes(text, "Chrome 200 includes 0 feature changes");
  equal(text.includes("Unable to load feature data"), false);
});

Deno.test("feed.xml reports a per-milestone outage without claiming the healthy milestone is empty", async () => {
  const handler = createHandler(fixtureClient({
    getVersions: async () => [140, 139],
    getFeaturesForVersion: (v) =>
      v === 140
        ? Promise.reject(new Error("Upstream HTTP 500"))
        : Promise.resolve({ "Enabled by default": [{ id: 1, name: "x" }] }),
  }));

  const res = await handler(new Request("https://chromestatuslite.com/feed.xml?limit=2"));
  equal(res.status, 200);
  const text = await res.text();
  includes(text, "Unable to load feature data for Chrome 140");
  includes(text, "Chrome 139 includes 1 feature changes");
  equal(text.includes("Chrome 140 includes 0 feature changes"), false);
});
