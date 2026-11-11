import { createHandler } from "../src/handler.ts";
import breaking from "../src/routes/breaking.ts";
import originTrials from "../src/routes/origin-trials.ts";
import { equal, fixtureClient, includes } from "./fixture.ts";

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

Deno.test("breaking and origin-trials render sections without a date for unparseable stable_date", async () => {
  const client = fixtureClient({
    getVersions: async () => [120],
    getChannels: async () => ({
      stable: { version: "120" },
      dev: { version: "121" },
      "120": { stable_date: "unknown" },
    }),
    getFeaturesForVersion: async () => ({
      "Deprecated": [{ id: 101, name: "Deprecated API" }],
      "Origin trial": [{ id: 301, name: "Trial API" }],
    }),
    getFeaturesByType: async () => ({ features: [] }),
  });
  const handler = createHandler(client);

  const breakingRes = await handler(new Request("https://chromestatuslite.com/breaking"));
  equal(breakingRes.status, 200);
  const breakingHtml = await breakingRes.text();
  includes(breakingHtml, "Chrome 120");
  includes(breakingHtml, "Deprecated API");
  equal(breakingHtml.includes("milestone-date"), false);
  equal(breakingHtml.includes("NaN-NaN-NaN"), false);

  const otRes = await handler(new Request("https://chromestatuslite.com/origin-trials"));
  equal(otRes.status, 200);
  const otHtml = await otRes.text();
  includes(otHtml, "Chrome 120");
  includes(otHtml, "Trial API");
  equal(otHtml.includes("milestone-date"), false);
  equal(otHtml.includes("NaN-NaN-NaN"), false);
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

