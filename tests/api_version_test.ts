import { test } from "vitest";
import { createHandler } from "../src/handler.ts";
import apiVersion from "../src/routes/api-version.ts";
import { equal, fixtureClient, includes } from "./fixture.ts";

test("api-version route module executes directly with injected client", async () => {
  const pattern = new URLPattern({ pathname: "/api/version/:version" });
  const match = pattern.exec("https://chromestatuslite.com/api/version/120");
  const res = await apiVersion(
    new Request("https://chromestatuslite.com/api/version/120"),
    match!,
    fixtureClient(),
  );
  equal(res.status, 200);
  equal(JSON.parse(await res.text()).version, 120);
});

test("api/version/:version returns clean JSON for milestone", async () => {
  const handler = createHandler({ client: fixtureClient() });
  const res = await handler(
    new Request("https://chromestatuslite.com/api/version/120"),
  );
  equal(res.status, 200);
  includes(res.headers.get("content-type") || "", "application/json");
  equal(res.headers.get("access-control-allow-origin"), "*");
  includes(res.headers.get("cache-control") || "", "max-age=3600");
  const data = JSON.parse(await res.text());
  equal(data.version, 120);
  equal(data.stable_date, "2024-01-01T00:00:00Z");
  equal(data.total_features, 1);
  equal(
    data.features_by_type["Enabled by default"]?.[0]?.name,
    "Fixture feature",
  );
  equal(data.features.length, 1);
  equal(data.features[0].id, 123);
  equal(data.features[0].status_type, "Enabled by default");
});

test("api/version rejects out-of-range and overlong milestones at the seam (chrome-status-lite-s9w)", async () => {
  let clientCalls = 0;
  const handler = createHandler({
    client: fixtureClient({
      getFeaturesForVersion: async () => {
        clientCalls++;
        return {};
      },
      getChannels: async () => {
        clientCalls++;
        return {};
      },
    }),
  });
  for (const version of ["0", "2001", "999999", "1".repeat(25)]) {
    const res = await handler(
      new Request(`https://chromestatuslite.com/api/version/${version}`),
    );
    equal(res.status, 400);
    includes(await res.text(), "Invalid version parameter");
  }
  equal(clientCalls, 0);
});

test("unknown in-range milestones cost one cached lookup, zero per-milestone fetches (chrome-status-lite-or9)", async () => {
  let versionCalls = 0;
  let featureCalls = 0;
  let channelCalls = 0;
  const handler = createHandler({
    client: fixtureClient({
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
    }),
  });

  const notFound = await handler(
    new Request("https://chromestatuslite.com/api/version/150"),
  );
  equal(notFound.status, 404);
  includes(await notFound.text(), "not found");
  equal(versionCalls, 1);
  equal(featureCalls, 0);
  equal(channelCalls, 0);

  await handler(new Request("https://chromestatuslite.com/api/version/151"));
  equal(versionCalls, 2);
  equal(featureCalls, 0);
  equal(channelCalls, 0);

  const ok = await handler(
    new Request("https://chromestatuslite.com/api/version/120"),
  );
  equal(ok.status, 200);
  equal(JSON.parse(await ok.text()).version, 120);
  equal(versionCalls, 3);
  equal(featureCalls, 1);
  equal(channelCalls, 1);
});

test("a version-list outage degrades to direct fetch, not 500 (chrome-status-lite-j0p)", async () => {
  const handler = createHandler({
    client: fixtureClient({
      getVersions: async () => {
        throw new Error("channels endpoint down");
      },
    }),
  });
  const res = await handler(
    new Request("https://chromestatuslite.com/api/version/120"),
  );
  equal(res.status, 200);
  const data = JSON.parse(await res.text());
  equal(data.version, 120);
  equal(data.total_features, 1);
});

test("api/version/latest resolves to newest milestone", async () => {
  const handler = createHandler({ client: fixtureClient() });
  const res = await handler(
    new Request("https://chromestatuslite.com/api/version/latest"),
  );
  equal(res.status, 200);
  includes(res.headers.get("content-type") || "", "application/json");
  const data = JSON.parse(await res.text());
  equal(data.version, 120);
  equal(data.total_features, 1);
});

test("api/version/:version validation, preflight, and 404 behavior", async () => {
  const handler = createHandler({ client: fixtureClient() });

  const preflight = await handler(
    new Request("https://chromestatuslite.com/api/version/120", {
      method: "OPTIONS",
    }),
  );
  equal(preflight.status, 204);
  equal(preflight.headers.get("access-control-allow-origin"), "*");

  const badParam = await handler(
    new Request("https://chromestatuslite.com/api/version/not-a-number"),
  );
  equal(badParam.status, 400);
  const badParamData = JSON.parse(await badParam.text());
  includes(badParamData.error, "Invalid version parameter");

  const customHandler = createHandler({
    client: fixtureClient({
      getVersions: async () => [120, 119],
      getFeaturesForVersion: async () => ({}),
    }),
  });
  const notFound = await customHandler(
    new Request("https://chromestatuslite.com/api/version/150"),
  );
  equal(notFound.status, 404);
  const notFoundData = JSON.parse(await notFound.text());
  includes(notFoundData.error, "not found");
});
