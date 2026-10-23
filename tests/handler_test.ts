import { createHandler } from "../src/handler.ts";
import template from "../src/flora.ts";
import feed from "../src/routes/feed.ts";
import apiVersion from "../src/routes/api-version.ts";
import breaking from "../src/routes/breaking.ts";
import originTrials from "../src/routes/origin-trials.ts";
import { equal, fixtureClient, includes } from "./fixture.ts";

Deno.test("import-safe handler redirects Deno hosts without querying upstream", async () => {
  const handler = createHandler(fixtureClient({ getVersions: () => { throw Error("unexpected fetch"); } }));
  for (const host of ["preview.deno.net", "preview.deno.dev"]) {
    const response = await handler(new Request(`https://${host}/feature/123?x=1`));
    equal(response.status, 301);
    equal(response.headers.get("location"), "https://chromestatuslite.com/feature/123?x=1");
  }
});

Deno.test("every response carries baseline security headers", async () => {
  const handler = createHandler(fixtureClient());
  const cases: Array<[string, number]> = [
    ["/", 200], // HTML route
    ["/styles/index.css", 200], // static asset
    ["/unknown", 404], // 404 path
  ];
  for (const [path, status] of cases) {
    const res = await handler(new Request(`https://chromestatuslite.com${path}`));
    equal(res.status, status);
    equal(res.headers.get("content-security-policy"), "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    equal(res.headers.get("x-content-type-options"), "nosniff");
    equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    equal(res.headers.get("x-frame-options"), "DENY");
    await res.body?.cancel();
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

Deno.test("release dates resolve via milestone range queries and do not leak internal errors", async () => {
  let rangePassedToApi = false;
  let rangePassedToFeed = false;
  const client = fixtureClient({
    getChannels: async (start?: number, end?: number) => {
      if (start === 120 && end === 120) rangePassedToApi = true;
      if (start !== undefined && end !== undefined && start <= 120 && end >= 120) rangePassedToFeed = true;
      if (start !== undefined && end !== undefined) {
        return { "120": { stable_date: "2024-05-15T00:00:00Z" } };
      }
      return { stable: { version: "120" }, dev: { version: "122" } };
    },
  });
  const handler = createHandler(client);

  const apiRes = await handler(new Request("https://chromestatuslite.com/api/version/120"));
  const apiData = await apiRes.json();
  equal(rangePassedToApi, true);
  equal(apiData.stable_date, "2024-05-15T00:00:00Z");

  const feedRes = await handler(new Request("https://chromestatuslite.com/feed.xml?limit=1"));
  const feedXml = await feedRes.text();
  equal(rangePassedToFeed, true);
  includes(feedXml, "<pubDate>Wed, 15 May 2024 00:00:00 GMT</pubDate>");

  // 500 error does not leak detail
  const failingHandler = createHandler(
    fixtureClient({
      getFeaturesForVersion: async () => { throw new Error("secret internal database error"); },
    }),
  );
  const errorRes = await failingHandler(new Request("https://chromestatuslite.com/api/version/120"));
  equal(errorRes.status, 500);
  const errorJson = await errorRes.json();
  equal(errorJson.error, "Failed to fetch milestone features");
  equal(errorJson.detail, undefined);
});

Deno.test("breaking view renders breaking changes timeline and badges", async () => {
  const client = fixtureClient({
    getVersions: async () => [120, 119],
    getFeaturesForVersion: async (v) => {
      if (v === 120) {
        return {
          "Deprecated": [{ id: 101, name: "Deprecated API", summary: "Old API", intent_stage: "Deprecated", enterprise_impact: 4 }],
          "Removed": [{ id: 102, name: "Removed API", summary: "Gone API" }],
        };
      }
      return {};
    },
    getFeaturesByType: async () => ({
      features: [
        { id: 201, name: "Type 3 Deprecation", browsers: { chrome: { desktop: "119" } } },
      ],
    }),
  });

  const handler = createHandler(client);
  const res = await handler(new Request("https://chromestatuslite.com/breaking"));
  equal(res.status, 200);
  includes(res.headers.get("content-type") || "", "text/html");
  const html = await res.text();
  includes(html, "Breaking Changes &amp; Deprecations Timeline");
  includes(html, "Chrome 120");
  includes(html, "Deprecated API");
  includes(html, "Removed API");
  includes(html, "Chrome 119");
  includes(html, "Type 3 Deprecation");
  includes(html, "Enterprise: High");
  includes(html, 'href="/diff"');
  includes(html, 'href="/breaking"');
  includes(html, 'href="/origin-trials"');
});

Deno.test("origin-trials view renders active trials tracker", async () => {
  const client = fixtureClient({
    getVersions: async () => [120, 119],
    getChannels: async () => ({
      stable: { version: "119" },
      dev: { version: "120" },
    }),
    getFeaturesForVersion: async (v) => {
      if (v === 120) {
        return {
          "Origin trial": [
            { id: 301, name: "Compute Pressure API", summary: "Testing compute pressure", intent_stage: "Origin trial" },
          ],
        };
      }
      return {};
    },
  });

  const handler = createHandler(client);
  const res = await handler(new Request("https://chromestatuslite.com/origin-trials"));
  equal(res.status, 200);
  includes(res.headers.get("content-type") || "", "text/html");
  const html = await res.text();
  includes(html, "Origin Trials Tracker");
  includes(html, "Compute Pressure API");
  includes(html, "Chrome 120");
  includes(html, "1 active origin trial");
  includes(html, "/feature/301");
});

Deno.test("origin-trials sanitizes spec link and refuses non-http(s) or hostile attribute payloads", async () => {
  const client = fixtureClient({
    getVersions: async () => [120],
    getFeaturesForVersion: async () => ({
      "Origin trial": [
        {
          id: 401,
          name: "Hostile Spec OT",
          standards: { spec: '"><img src=x onerror=alert(1)>' },
        },
        {
          id: 402,
          name: "JS Scheme OT",
          standards: { spec: "javascript:alert(1)" },
        },
      ],
    }),
  });

  const html = await (await createHandler(client)(new Request("https://chromestatuslite.com/origin-trials"))).text();
  equal(html.includes("<img src=x"), false);
  equal(html.includes("javascript:alert(1)"), false);
});

Deno.test("origin-trials distinguishes active/upcoming trials from historical ended trials", async () => {
  const client = fixtureClient({
    getVersions: async () => [122, 120, 118],
    getChannels: async () => ({
      stable: { version: "120" },
      dev: { version: "121" },
    }),
    getFeaturesForVersion: async (v) => {
      if (v === 122) return { "Origin trial": [{ id: 501, name: "Upcoming Trial" }] };
      if (v === 120) return { "Origin trial": [{ id: 502, name: "Active Trial" }] };
      if (v === 118) return { "Origin trial": [{ id: 503, name: "Past Trial" }] };
      return {};
    },
  });

  const html = await (await createHandler(client)(new Request("https://chromestatuslite.com/origin-trials"))).text();
  includes(html, "Upcoming in 122");
  includes(html, "Active in 120");
  includes(html, "Ended (Chrome 118)");
});

Deno.test("breaking and origin-trials render error notices on upstream failure", async () => {
  const failingClient = fixtureClient({
    getVersions: async () => { throw new Error("upstream down"); },
  });

  const breakingHtml = await (await createHandler(failingClient)(new Request("https://chromestatuslite.com/breaking"))).text();
  includes(breakingHtml, "error-notice");
  includes(breakingHtml, "Unable to load breaking change data");

  const otHtml = await (await createHandler(failingClient)(new Request("https://chromestatuslite.com/origin-trials"))).text();
  includes(otHtml, "error-notice");
  includes(otHtml, "Unable to load origin trial data");
});

Deno.test("breaking and origin-trials render error notices when feature endpoints reject even if versions/channels succeed", async () => {
  const partialFailingClient = fixtureClient({
    getVersions: async () => [120, 119],
    getChannels: async () => ({
      stable: { version: "119" },
      dev: { version: "120" },
    }),
    getFeaturesForVersion: async () => { throw new Error("features 500"); },
    getFeaturesByType: async () => { throw new Error("type3 500"); },
  });

  const breakingHtml = await (await createHandler(partialFailingClient)(new Request("https://chromestatuslite.com/breaking"))).text();
  includes(breakingHtml, "error-notice");
  includes(breakingHtml, "Unable to load breaking change data");
  equal(breakingHtml.includes("No breaking changes found in recent milestones"), false);

  const otHtml = await (await createHandler(partialFailingClient)(new Request("https://chromestatuslite.com/origin-trials"))).text();
  includes(otHtml, "error-notice");
  includes(otHtml, "Unable to load origin trial data");
  equal(otHtml.includes("No active origin trials found in recent milestones"), false);
});

Deno.test("origin-trials pluralizes historical trials cleanly without (ended)s", async () => {
  const client = fixtureClient({
    getVersions: async () => [118],
    getChannels: async () => ({
      stable: { version: "120" },
      dev: { version: "121" },
    }),
    getFeaturesForVersion: async () => ({
      "Origin trial": [
        { id: 1, name: "Trial 1" },
        { id: 2, name: "Trial 2" },
      ],
    }),
  });

  const html = await (await createHandler(client)(new Request("https://chromestatuslite.com/origin-trials"))).text();
  includes(html, "2 historical trials (ended) in this milestone");
  equal(html.includes("(ended)s"), false);
});

Deno.test("breaking and originTrials route modules execute directly with injected client", async () => {
  const client = fixtureClient();
  const breakingRes = await breaking(new Request("https://chromestatuslite.com/breaking"), client);
  equal(breakingRes.status, 200);
  includes(await breakingRes.text(), "Breaking Changes");

  const otRes = await originTrials(new Request("https://chromestatuslite.com/origin-trials"), client);
  equal(otRes.status, 200);
  includes(await otRes.text(), "Origin Trials Tracker");
});

Deno.test("index, diff, and deprecations render error-notices on upstream failure", async () => {
  const failingClient = fixtureClient({
    getVersions: async () => { throw new Error("Upstream HTTP 500"); },
    getFeaturesForVersion: async () => { throw new Error("Upstream HTTP 500"); },
    getFeaturesByType: async () => { throw new Error("Upstream HTTP 500"); },
  });

  const handler = createHandler(failingClient);

  const indexRes = await handler(new Request("https://chromestatuslite.com/"));
  equal(indexRes.status, 200);
  includes(await indexRes.text(), "error-notice");

  const diffRes = await handler(new Request("https://chromestatuslite.com/diff?from=120&to=119"));
  equal(diffRes.status, 200);
  includes(await diffRes.text(), "error-notice");

  const deprecationsRes = await handler(new Request("https://chromestatuslite.com/deprecations"));
  equal(deprecationsRes.status, 200);
  includes(await deprecationsRes.text(), "error-notice");
});

Deno.test("malformed non-throwing bodies render error-notices and avoid unhandled rejections", async () => {
  const malformedClient = fixtureClient({
    getVersions: async () => [120, 119],
    getFeaturesForVersion: async () => null as any,
    getFeaturesByType: async () => ({ features: [{ name: "X", browsers: { chrome: { desktop: "120" } } }] }),
    getChannels: async () => null as any,
  });

  const handler = createHandler(malformedClient);

  const indexRes = await handler(new Request("https://chromestatuslite.com/"));
  equal(indexRes.status, 200);
  includes(await indexRes.text(), "error-notice");

  const deprecationsRes = await handler(new Request("https://chromestatuslite.com/deprecations"));
  equal(deprecationsRes.status, 200);
  includes(await deprecationsRes.text(), "error-notice");
});

Deno.test("malformed feature entries and non-bucket bodies on / render error-notices", async () => {
  const malformedEntryClient = fixtureClient({
    getVersions: async () => [120],
    getFeaturesForVersion: async () => ({ "Enabled by default": [null] }) as any,
  });
  const res1 = await createHandler(malformedEntryClient)(new Request("https://chromestatuslite.com/"));
  equal(res1.status, 200);
  includes(await res1.text(), "error-notice");

  const nonBucketClient = fixtureClient({
    getVersions: async () => [120],
    getFeaturesForVersion: async () => ({ features: null }) as any,
  });
  const res2 = await createHandler(nonBucketClient)(new Request("https://chromestatuslite.com/"));
  equal(res2.status, 200);
  includes(await res2.text(), "error-notice");
});

Deno.test("flora stream converts mid-stream rejections into stream errors without unhandled rejection", async () => {
  const stream = await template`<div>${(async () => {
    throw new Error("mid-stream failure");
  })()}</div>`;
  let streamFailed = false;
  try {
    const reader = stream.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch (err: any) {
    if (err.message === "mid-stream failure") {
      streamFailed = true;
    }
  }
  equal(streamFailed, true);
});

Deno.test("feature entry without resources or null deprecation entries render safely", async () => {
  const base = {
    getVersions: async () => [120],
    getFeaturesForVersion: async () => ({ "Enabled by default": [{ id: 7, name: "ok" }] }),
    getFeaturesByType: async () => ({ features: [null] }),
    getChannels: async () => ({}),
  };
  const handler = createHandler(fixtureClient(base as any));
  const resIndex = await handler(new Request("https://chromestatuslite.com/"));
  equal(resIndex.status, 200);
  includes(await resIndex.text(), "Chrome 120");

  const resDep = await handler(new Request("https://chromestatuslite.com/deprecations"));
  equal(resDep.status, 200);
  equal((await resDep.text()).includes("Unnamed feature"), false);
});

Deno.test("feature detail and feed render error-notices on upstream service failure", async () => {
  const boom = async () => { throw new Error("Upstream HTTP 500"); };
  const failingClient = fixtureClient({
    getVersions: boom,
    getFeature: boom,
  });
  const handler = createHandler(failingClient);

  const resFeature = await handler(new Request("https://chromestatuslite.com/feature/123456"));
  equal(resFeature.status, 200);
  const featureText = await resFeature.text();
  includes(featureText, "error-notice");
  equal(featureText.includes("Feature not found"), false);

  const resFeed = await handler(new Request("https://chromestatuslite.com/feed.xml"));
  equal(resFeed.status, 200);
  const feedText = await resFeed.text();
  includes(feedText, "Unable to load release data from chromestatus.com");
  equal((feedText.match(/<item>/g) || []).length, 1);
});

Deno.test("feature detail renders error-notice, not 404, for a 200 body of literal null", async () => {
  const handler = createHandler(fixtureClient({ getFeature: async () => null }));

  const res = await handler(new Request("https://chromestatuslite.com/feature/123456"));
  equal(res.status, 200);
  const text = await res.text();
  includes(text, "error-notice");
  equal(text.includes("Feature not found"), false);
});

Deno.test("feature detail renders error-notice, not 404, for a 200 object without an id", async () => {
  const handler = createHandler(fixtureClient({ getFeature: async () => ({ name: "Shapeless" }) }));

  const res = await handler(new Request("https://chromestatuslite.com/feature/123456"));
  equal(res.status, 200);
  const text = await res.text();
  includes(text, "error-notice");
  equal(text.includes("Feature not found"), false);
});

Deno.test("feature detail keeps the authoritative 404 for a genuine upstream not-found", async () => {
  const handler = createHandler(fixtureClient({
    getFeature: async () => {
      throw new Error("Upstream HTTP 404 from /api/v0/features/999999");
    },
  }));

  const res = await handler(new Request("https://chromestatuslite.com/feature/999999"));
  equal(res.status, 404);
  const text = await res.text();
  includes(text, "Feature not found");
  equal(text.includes("error-notice"), false);
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
