import { createHandler } from "../src/handler.ts";
import apiVersion from "../src/routes/api-version.ts";
import { equal, fixtureClient, includes } from "./fixture.ts";

Deno.test("api-version route module executes directly with injected client", async () => {
  const pattern = new URLPattern({ pathname: "/api/version/:version" });
  const match = pattern.exec("https://chromestatuslite.com/api/version/120");
  const res = await apiVersion(new Request("https://chromestatuslite.com/api/version/120"), match!, fixtureClient());
  equal(res.status, 200);
  equal(JSON.parse(await res.text()).version, 120);
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

Deno.test("api/version rejects out-of-range and overlong milestones at the seam (chrome-status-lite-s9w)", async () => {
  // Every distinct accepted milestone mints two LRU keys and two upstream
  // calls, so implausible milestones must be rejected before any client
  // method runs: milestone 0 and past-2000 values are not Chrome releases,
  // and an overlong digit string is not a milestone at all.
  let clientCalls = 0;
  const handler = createHandler(fixtureClient({
    getFeaturesForVersion: async () => {
      clientCalls++;
      return {};
    },
    getChannels: async () => {
      clientCalls++;
      return {};
    },
  }));
  for (const version of ["0", "2001", "999999", "1".repeat(25)]) {
    const res = await handler(new Request(`https://chromestatuslite.com/api/version/${version}`));
    equal(res.status, 400);
    includes(await res.text(), "Invalid version parameter");
  }
  equal(clientCalls, 0);
});

Deno.test("unknown in-range milestones cost one cached lookup, zero per-milestone fetches (chrome-status-lite-or9)", async () => {
  let versionCalls = 0;
  let featureCalls = 0;
  let channelCalls = 0;
  const handler = createHandler(fixtureClient({
    getVersions: async () => {
      versionCalls++;
      return [120, 119];
    },
    getFeaturesForVersion: async () => {
      featureCalls++;
      return {};
    },
    getChannels: async () => {
      channelCalls++;
      return {};
    },
  }));

  // Each unknown-but-in-range milestone is one whitelist lookup (shared,
  // cacheable) and NO per-milestone fetches or cache writes.
  const notFound = await handler(new Request("https://chromestatuslite.com/api/version/150"));
  equal(notFound.status, 404);
  includes(await notFound.text(), "not found");
  equal(versionCalls, 1);
  equal(featureCalls, 0);
  equal(channelCalls, 0);

  await handler(new Request("https://chromestatuslite.com/api/version/151"));
  equal(versionCalls, 2);
  equal(featureCalls, 0);
  equal(channelCalls, 0);

  // A known milestone still serves the full payload.
  const ok = await handler(new Request("https://chromestatuslite.com/api/version/120"));
  equal(ok.status, 200);
  equal(JSON.parse(await ok.text()).version, 120);
  // One getVersions call per request (in production the LRU makes every
  // request after the first a cache hit on the shared channels key).
  equal(versionCalls, 3);
  equal(featureCalls, 1);
  equal(channelCalls, 1);
});

Deno.test("a version-list outage degrades to direct fetch, not 500 (chrome-status-lite-j0p)", async () => {
  // The whitelist is an optimisation: when getVersions is down but the
  // features/channels endpoints are healthy, a known milestone must still
  // serve 200 (parent behaviour). An empty list never 404s anything.
  const handler = createHandler(fixtureClient({
    getVersions: async () => {
      throw new Error("channels endpoint down");
    },
  }));
  const res = await handler(new Request("https://chromestatuslite.com/api/version/120"));
  equal(res.status, 200);
  const data = JSON.parse(await res.text());
  equal(data.version, 120);
  equal(data.total_features, 1);
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

  // Milestone not found: in the plausible range (seam-bound, so it reaches
  // the upstream query) but absent from the upstream version list.
  const customHandler = createHandler(
    fixtureClient({
      getVersions: async () => [120, 119],
      getFeaturesForVersion: async () => ({}),
    }),
  );
  const notFound = await customHandler(
    new Request("https://chromestatuslite.com/api/version/150"),
  );
  equal(notFound.status, 404);
  const notFoundData = JSON.parse(await notFound.text());
  includes(notFoundData.error, "not found");
});

