import { createHandler } from "../src/handler.ts";
import feed from "../src/routes/feed.ts";
import apiVersion from "../src/routes/api-version.ts";
import { equal, fixtureClient, includes } from "./fixture.ts";

Deno.test("import-safe handler redirects Deno hosts without querying upstream", async () => {
  const handler = createHandler(fixtureClient({ getVersions: () => { throw Error("unexpected fetch"); } }));
  for (const host of ["preview.deno.net", "preview.deno.dev"]) {
    const response = await handler(new Request(`https://${host}/feature/123?x=1`));
    equal(response.status, 301);
    equal(response.headers.get("location"), "https://chromestatuslite.com/feature/123?x=1");
  }
});

Deno.test("static assets and unknown paths", async () => {
  const handler = createHandler(fixtureClient());
  const asset = await handler(new Request("https://chromestatuslite.com/styles/index.css"));
  equal(asset.status, 200);
  includes(asset.headers.get("content-type") || "", "text/css");
  includes(await asset.text(), "body");
  equal((await handler(new Request("https://chromestatuslite.com/unknown"))).status, 404);
  equal((await handler(new Request("https://chromestatuslite.com/scripts/missing.js"))).status, 404);
  const verification = await handler(new Request("https://chromestatuslite.com/google1bf7ef037ae116eb.html"));
  equal(verification.status, 200);
  includes(verification.headers.get("content-type") || "", "text/html");
  includes(await verification.text(), "google-site-verification: google1bf7ef037ae116eb.html");
  // Encoded separators must not escape the explicit static asset whitelist.
  for (const path of [
    "/scripts/%2e%2e%2fmain.ts",
    "/scripts/%2e%2e%2f%2e%2e%2fmain.ts",
  ]) {
    equal((await handler(new Request(`https://chromestatuslite.com${path}`))).status, 404);
  }
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

Deno.test("api/version/:version returns clean JSON for milestone", async () => {
  const handler = createHandler(fixtureClient());
  const res = await handler(new Request("https://chromestatuslite.com/api/version/120"));
  equal(res.status, 200);
  includes(res.headers.get("content-type") || "", "application/json");
  equal(res.headers.get("access-control-allow-origin"), "*");
  includes(res.headers.get("cache-control") || "", "max-age=3600");
  const data = JSON.parse(await res.text());
  equal(data.version, 120);
  equal(data.stable_date, "2024-01-01T00:00:00Z");
  equal(data.total_features, 1);
  equal(data.features_by_type["Enabled by default"]?.[0]?.name, "Fixture feature");
  equal(data.features.length, 1);
  equal(data.features[0].id, 123);
  equal(data.features[0].status_type, "Enabled by default");
});

Deno.test("api/version/latest resolves to newest milestone", async () => {
  const handler = createHandler(fixtureClient());
  const res = await handler(new Request("https://chromestatuslite.com/api/version/latest"));
  equal(res.status, 200);
  includes(res.headers.get("content-type") || "", "application/json");
  const data = JSON.parse(await res.text());
  equal(data.version, 120);
  equal(data.total_features, 1);
});

Deno.test("api/version/:version validation, preflight, and 404 behavior", async () => {
  const handler = createHandler(fixtureClient());

  // OPTIONS preflight
  const preflight = await handler(
    new Request("https://chromestatuslite.com/api/version/120", { method: "OPTIONS" }),
  );
  equal(preflight.status, 204);
  equal(preflight.headers.get("access-control-allow-origin"), "*");

  // Invalid parameter
  const badParam = await handler(new Request("https://chromestatuslite.com/api/version/not-a-number"));
  equal(badParam.status, 400);
  const badParamData = JSON.parse(await badParam.text());
  includes(badParamData.error, "Invalid version parameter");

  // Milestone not found (e.g. 99999)
  const customHandler = createHandler(
    fixtureClient({
      getVersions: async () => [120, 119],
      getFeaturesForVersion: async () => ({}),
    }),
  );
  const notFound = await customHandler(
    new Request("https://chromestatuslite.com/api/version/99999"),
  );
  equal(notFound.status, 404);
  const notFoundData = JSON.parse(await notFound.text());
  includes(notFoundData.error, "not found");
});

Deno.test("feed and apiVersion route modules execute directly with injected client", async () => {
  const client = fixtureClient();
  const feedRes = await feed(new Request("https://chromestatuslite.com/feed.xml"), client);
  equal(feedRes.status, 200);
  includes(await feedRes.text(), "Chrome 120");

  const pattern = new URLPattern({ pathname: "/api/version/:version" });
  const match = pattern.exec("https://chromestatuslite.com/api/version/120");
  const apiRes = await apiVersion(new Request("https://chromestatuslite.com/api/version/120"), match!, client);
  equal(apiRes.status, 200);
  const data = JSON.parse(await apiRes.text());
  equal(data.version, 120);
});
