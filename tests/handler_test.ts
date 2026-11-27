import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { test } from "vitest";
import { createHandler, stripBodyForHead } from "../src/handler.ts";
import { htmlToMarkdown, prefersMarkdown } from "../src/lib/markdown.ts";
import { MemorySnapshotStore, type SnapshotStore } from "../src/lib/snapshots.ts";
import { WIKI_TOPICS } from "../src/lib/wiki.ts";
import worker from "../src/worker.ts";
import { equal, fixtureClient, includes, sampleFeature } from "./fixture.ts";

test("import-safe handler redirects Deno hosts and optionally workers.dev without querying upstream", async () => {
  const client = fixtureClient({
    getVersions: () => {
      throw Error("unexpected fetch");
    },
  });
  const handler = createHandler({ client });
  for (const host of ["preview.deno.net", "preview.deno.dev"]) {
    const response = await handler(
      new Request(`https://${host}/feature/123?x=1`),
    );
    equal(response.status, 301);
    equal(
      response.headers.get("location"),
      "https://chromestatuslite.com/feature/123?x=1",
    );
  }

  // workers.dev redirects only when redirectWorkersDev is enabled so pre-DNS preview works.
  const previewHandler = createHandler({
    client: fixtureClient(),
    redirectWorkersDev: false,
  });
  equal(
    (await previewHandler(new Request("https://chromestatuslite.example.workers.dev/")))
      .status,
    200,
  );
  const canonicalHandler = createHandler({ client, redirectWorkersDev: true });
  const cfRedirect = await canonicalHandler(
    new Request("https://chromestatuslite.example.workers.dev/diff?from=119&to=120"),
  );
  equal(cfRedirect.status, 301);
  equal(
    cfRedirect.headers.get("location"),
    "https://chromestatuslite.com/diff?from=119&to=120",
  );
});

test("every response carries baseline security headers", async () => {
  const handler = createHandler({ client: fixtureClient(), assets: env.ASSETS });
  const cases: Array<[string, number]> = [
    ["/", 200],
    ["/styles/index.css", 200],
    ["/robots.txt", 200],
    ["/favicon.svg", 200],
    ["/speculation-rules.json", 200],
    ["/unknown", 404],
  ];
  for (const [path, status] of cases) {
    const res = await handler(
      new Request(`https://chromestatuslite.com${path}`),
    );
    equal(res.status, status, `status for ${path}`);
    const csp = res.headers.get("content-security-policy") || "";
    equal(
      csp,
      "default-src 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    for (
      const directive of [
        "base-uri 'none'",
        "object-src 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ]
    ) {
      includes(csp, directive);
    }
    equal(res.headers.get("x-content-type-options"), "nosniff");
    equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    equal(res.headers.get("x-frame-options"), "DENY");
    await res.body?.cancel();
  }
});

test("a rejecting route returns a hardened 500 with no-store", async () => {
  const handler = createHandler({
    client: fixtureClient({
      getVersions: () => {
        throw new TypeError("upstream socket reset");
      },
    }),
  });
  const res = await handler(
    new Request("https://chromestatuslite.com/api/version/120"),
  );
  equal(res.status, 500);
  equal(res.headers.get("cache-control"), "no-store");
  equal(await res.text(), "Internal Server Error");
  const csp = res.headers.get("content-security-policy") || "";
  equal(
    csp,
    "default-src 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  equal(res.headers.get("x-content-type-options"), "nosniff");
  equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  equal(res.headers.get("x-frame-options"), "DENY");

  const head = await handler(
    new Request("https://chromestatuslite.com/api/version/120", {
      method: "HEAD",
    }),
  );
  equal(head.status, 500);
  equal(await head.text(), "");
  equal(
    head.headers.get("content-length"),
    String(new TextEncoder().encode("Internal Server Error").length),
  );
  equal(head.headers.get("x-frame-options"), "DENY");
});

test("a HEAD stream rejection returns a hardened 500 instead of escaping the header gate (chrome-status-lite-tlgi)", async () => {
  const badName = {
    toString() {
      throw new Error("nested render failed");
    },
  };
  const handler = createHandler({
    client: fixtureClient({
      getFeaturesForVersion: async () => ({
        "Enabled by default": [{ ...sampleFeature, name: badName }],
      }),
    }),
  });
  const head = await handler(
    new Request("https://chromestatuslite.com/", { method: "HEAD" }),
  );
  equal(head.status, 500);
  equal(head.body, null);
  equal(head.headers.get("content-length"), "21");
  equal(
    head.headers.get("content-security-policy"),
    "default-src 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  equal(head.headers.get("x-content-type-options"), "nosniff");
  equal(head.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  equal(head.headers.get("x-frame-options"), "DENY");
});

test("non-GET/HEAD verbs are rejected with 405 and Allow before dispatch", async () => {
  const client = fixtureClient({
    getVersions: () => {
      throw Error("must not touch upstream");
    },
    getFeaturesForVersion: () => {
      throw Error("must not touch upstream");
    },
    getFeature: () => {
      throw Error("must not touch upstream");
    },
  });
  const store = new Proxy({} as SnapshotStore, {
    get: () => () => {
      throw Error("must not touch the snapshot store");
    },
  });
  const handler = createHandler({ client, store });

  for (const method of ["POST", "PUT", "DELETE"]) {
    for (const path of ["/", "/feature/123", "/api/version/120"]) {
      const res = await handler(
        new Request(`https://chromestatuslite.com${path}`, { method }),
      );
      equal(res.status, 405);
      equal(
        res.headers.get("allow"),
        path.startsWith("/api/version/") ? "GET, HEAD, OPTIONS" : "GET, HEAD",
      );
      equal(await res.text(), "");
    }
  }
  const preflight = await handler(
    new Request("https://chromestatuslite.com/api/version/120", {
      method: "OPTIONS",
    }),
  );
  equal(preflight.status, 204);
});

test("HEAD responses carry GET headers, no body, and never mutate the snapshot store (chrome-status-lite-rw6)", async () => {
  const store = new MemorySnapshotStore();
  const handler = createHandler({ client: fixtureClient(), store });

  const head = await handler(
    new Request("https://chromestatuslite.com/feature/123", { method: "HEAD" }),
  );
  equal(head.status, 200);
  equal(await head.text(), "");
  equal((await store.list("123")).length, 0);

  const getRes = await handler(
    new Request("https://chromestatuslite.com/feature/123"),
  );
  const getText = await getRes.text();
  equal(getRes.status, 200);
  equal(head.headers.get("content-type"), getRes.headers.get("content-type"));
  equal(
    head.headers.get("content-length"),
    String(new TextEncoder().encode(getText).length),
  );
  equal((await store.list("123")).length, 1);

  const headIndex = await handler(
    new Request("https://chromestatuslite.com/", { method: "HEAD" }),
  );
  equal(headIndex.status, 200);
  equal(await headIndex.text(), "");
});

test("HEAD strip measures body bytes, not decoded text (chrome-status-lite-38e)", async () => {
  const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]);
  const stripped = await stripBodyForHead(
    new Response(binary, {
      headers: { "content-type": "application/octet-stream" },
    }),
  );
  equal(stripped.headers.get("content-length"), String(binary.byteLength));
  equal(stripped.headers.get("content-type"), "application/octet-stream");
  equal(await stripped.text(), "");

  const streamed = await stripBodyForHead(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(binary);
          controller.close();
        },
      }),
    ),
  );
  equal(streamed.headers.get("content-length"), String(binary.byteLength));
});

test("HEAD strip counts a multi-chunk stream and keeps a route-supplied length on a null body (chrome-status-lite-735)", async () => {
  const chunks = [
    new Uint8Array([1, 2, 3]),
    new Uint8Array([4, 5]),
    new Uint8Array([6, 7, 8, 9]),
  ];
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const counted = await stripBodyForHead(
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    ),
  );
  equal(counted.headers.get("content-length"), String(total));
  equal(await counted.text(), "");

  const kept = await stripBodyForHead(
    new Response(null, {
      headers: { "content-length": "42", "content-type": "text/css" },
    }),
  );
  equal(kept.headers.get("content-length"), "42");
  equal(kept.headers.get("content-type"), "text/css");

  const empty = await stripBodyForHead(new Response(null));
  equal(empty.headers.get("content-length"), "0");
});

test("HEAD on a static asset answers from metadata with GET byte length via ASSETS binding", async () => {
  const handler = createHandler({ client: fixtureClient(), assets: env.ASSETS });
  const getRes = await handler(
    new Request("https://chromestatuslite.com/styles/index.css"),
  );
  equal(getRes.status, 200);
  const getBytes = new Uint8Array(await getRes.arrayBuffer());

  const head = await handler(
    new Request("https://chromestatuslite.com/styles/index.css", {
      method: "HEAD",
    }),
  );
  equal(head.status, 200);
  equal(await head.text(), "");
  equal(head.headers.get("content-length"), String(getBytes.byteLength));
  includes(head.headers.get("content-type") || "", "text/css");

  for (
    const path of [
      "/unknown",
      "/scripts/missing.js",
      "/scripts/%2e%2e%2fmain.ts",
    ]
  ) {
    const res = await handler(
      new Request(`https://chromestatuslite.com${path}`, { method: "HEAD" }),
    );
    equal(res.status, 404);
    equal(await res.text(), "");
  }
});

test("static HEAD delegates HEAD to assets binding without forcing GET", async () => {
  let seenMethod = "";
  const headOnlyAssets = {
    fetch: async (req: Request) => {
      seenMethod = req.method;
      if (req.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "content-type": "text/css", "content-length": "4321" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  };
  const handler = createHandler({
    client: fixtureClient(),
    assets: headOnlyAssets,
  });

  const head = await handler(
    new Request("https://chromestatuslite.com/styles/index.css", {
      method: "HEAD",
    }),
  );
  equal(seenMethod, "HEAD");
  equal(head.status, 200);
  equal(head.headers.get("content-length"), "4321");
  includes(head.headers.get("content-type") || "", "text/css");
  equal(await head.text(), "");
});

test("HEAD strip drains the body chunk by chunk, never through a whole-body API (chrome-status-lite-vp3)", async () => {
  const chunks = [
    new Uint8Array([1, 2, 3]),
    new Uint8Array([4, 5]),
    new Uint8Array([6, 7, 8, 9]),
  ];
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const buffered = (api: string) => () => {
    throw new Error(
      `HEAD strip called response.${api}() - that materialises the whole body`,
    );
  };
  let pulls = 0;
  const body = new ReadableStream({
    pull(controller) {
      const chunk = chunks[pulls];
      pulls++;
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
  });
  const response = {
    body,
    headers: new Headers({ "content-type": "text/html" }),
    status: 200,
    statusText: "OK",
    arrayBuffer: buffered("arrayBuffer"),
    blob: buffered("blob"),
    bytes: buffered("bytes"),
    clone: buffered("clone"),
    formData: buffered("formData"),
    json: buffered("json"),
    text: buffered("text"),
  } as unknown as Response;

  const stripped = await stripBodyForHead(response);
  equal(stripped.headers.get("content-length"), String(total));
  equal(pulls, chunks.length + 1);
  equal(await stripped.text(), "");
  includes(stripped.headers.get("content-type") || "", "text/html");
});

test("static assets, robots.txt, favicon.svg, speculation-rules.json and unknown paths", async () => {
  const handler = createHandler({ client: fixtureClient(), assets: env.ASSETS });
  const asset = await handler(
    new Request("https://chromestatuslite.com/styles/index.css"),
  );
  equal(asset.status, 200);
  includes(asset.headers.get("content-type") || "", "text/css");
  includes(asset.headers.get("cache-control") || "", "max-age=86400");
  includes(await asset.text(), "body");

  const robots = await handler(
    new Request("https://chromestatuslite.com/robots.txt"),
  );
  equal(robots.status, 200);
  includes(await robots.text(), "User-agent: *");

  const favicon = await handler(
    new Request("https://chromestatuslite.com/favicon.svg"),
  );
  equal(favicon.status, 200);
  includes(favicon.headers.get("content-type") || "", "image/svg+xml");

  const specRules = await handler(
    new Request("https://chromestatuslite.com/speculation-rules.json"),
  );
  equal(specRules.status, 200);
  includes(
    specRules.headers.get("content-type") || "",
    "application/speculationrules+json",
  );
  const parsedRules = JSON.parse(await specRules.text());
  equal(Array.isArray(parsedRules.prefetch), true);

  equal(
    (await handler(new Request("https://chromestatuslite.com/unknown"))).status,
    404,
  );
  equal(
    (await handler(
      new Request("https://chromestatuslite.com/scripts/missing.js"),
    )).status,
    404,
  );
  const verification = await handler(
    new Request("https://chromestatuslite.com/google1bf7ef037ae116eb.html"),
  );
  equal(verification.status, 200);
  includes(verification.headers.get("content-type") || "", "text/html");
  includes(
    await verification.text(),
    "google-site-verification: google1bf7ef037ae116eb.html",
  );
  for (
    const path of [
      "/scripts/%2e%2e%2fmain.ts",
      "/scripts/%2e%2e%2f%2e%2e%2fmain.ts",
      "/styles/%2e%2e%2fworker.ts",
    ]
  ) {
    equal(
      (await handler(new Request(`https://chromestatuslite.com${path}`)))
        .status,
      404,
    );
  }
});

test("Cloudflare Worker entrypoint serves static assets with security headers and redirects Deno hosts", async () => {
  const ctx1 = createExecutionContext();
  const redirect = await worker.fetch(
    new Request("https://preview.deno.net/diff"),
    env,
    ctx1,
  );
  await waitOnExecutionContext(ctx1);
  equal(redirect.status, 301);
  equal(
    redirect.headers.get("location"),
    "https://chromestatuslite.com/diff",
  );
  equal(redirect.headers.get("x-frame-options"), "DENY");

  const ctx2 = createExecutionContext();
  const css = await worker.fetch(
    new Request("https://chromestatuslite.com/styles/index.css"),
    env,
    ctx2,
  );
  await waitOnExecutionContext(ctx2);
  equal(css.status, 200);
  equal(css.headers.get("x-content-type-options"), "nosniff");
  includes(await css.text(), "awsm.css");
});

test("release dates resolve via milestone range queries and do not leak internal errors", async () => {
  let rangePassedToApi = false;
  let rangePassedToFeed = false;
  const client = fixtureClient({
    getChannels: async (start?: number | string, end?: number | string) => {
      if (start === 120 && end === 120) rangePassedToApi = true;
      if (
        start !== undefined && end !== undefined && Number(start) <= 120 &&
        Number(end) >= 120
      ) {
        rangePassedToFeed = true;
      }
      if (start !== undefined && end !== undefined) {
        return { "120": { stable_date: "2024-05-15T00:00:00Z" } };
      }
      return { stable: { version: "120" }, dev: { version: "122" } };
    },
  });
  const handler = createHandler({ client });

  const apiRes = await handler(
    new Request("https://chromestatuslite.com/api/version/120"),
  );
  const apiData = (await apiRes.json()) as { stable_date: string };
  equal(rangePassedToApi, true);
  equal(apiData.stable_date, "2024-05-15T00:00:00Z");

  const feedRes = await handler(
    new Request("https://chromestatuslite.com/feed.xml?limit=1"),
  );
  const feedXml = await feedRes.text();
  equal(rangePassedToFeed, true);
  includes(feedXml, "<pubDate>Wed, 15 May 2024 00:00:00 GMT</pubDate>");

  const failingHandler = createHandler({
    client: fixtureClient({
      getFeaturesForVersion: async () => {
        throw new Error("secret internal database error");
      },
    }),
  });
  const errorRes = await failingHandler(
    new Request("https://chromestatuslite.com/api/version/120"),
  );
  equal(errorRes.status, 500);
  const errorJson = (await errorRes.json()) as {
    error: string;
    detail?: string;
  };
  equal(errorJson.error, "Failed to fetch milestone features");
  equal(errorJson.detail, undefined);
});

test("index, diff, and deprecations render error-notices with no-store on upstream failure", async () => {
  const failingClient = fixtureClient({
    getVersions: async () => {
      throw new Error("Upstream HTTP 500");
    },
    getFeaturesForVersion: async () => {
      throw new Error("Upstream HTTP 500");
    },
    getFeaturesByType: async () => {
      throw new Error("Upstream HTTP 500");
    },
  });

  const handler = createHandler({ client: failingClient });

  for (const path of ["/", "/diff?from=120&to=119", "/deprecations"]) {
    const res = await handler(
      new Request(`https://chromestatuslite.com${path}`),
    );
    equal(res.status, 200);
    equal(res.headers.get("cache-control"), "no-store");
    includes(await res.text(), "error-notice");
  }
});

test("malformed non-throwing bodies render error-notices and avoid unhandled rejections", async () => {
  const malformedClient = fixtureClient({
    getVersions: async () => [120, 119],
    getFeaturesForVersion: async () => null as any,
    getFeaturesByType: async () => ({
      features: [{ name: "X", browsers: { chrome: { desktop: "120" } } }],
    }),
    getChannels: async () => null as any,
  });

  const handler = createHandler({ client: malformedClient });

  const indexRes = await handler(new Request("https://chromestatuslite.com/"));
  equal(indexRes.status, 200);
  includes(await indexRes.text(), "error-notice");

  const deprecationsRes = await handler(
    new Request("https://chromestatuslite.com/deprecations"),
  );
  equal(deprecationsRes.status, 200);
  includes(await deprecationsRes.text(), "error-notice");
});

test("malformed feature entries and non-bucket bodies on / render error-notices", async () => {
  const malformedEntryClient = fixtureClient({
    getVersions: async () => [120],
    getFeaturesForVersion: async () => ({ "Enabled by default": [null] }) as any,
  });
  const res1 = await createHandler({ client: malformedEntryClient })(
    new Request("https://chromestatuslite.com/"),
  );
  equal(res1.status, 200);
  includes(await res1.text(), "error-notice");

  const nonBucketClient = fixtureClient({
    getVersions: async () => [120],
    getFeaturesForVersion: async () => ({ features: null }) as any,
  });
  const res2 = await createHandler({ client: nonBucketClient })(
    new Request("https://chromestatuslite.com/"),
  );
  equal(res2.status, 200);
  includes(await res2.text(), "error-notice");
});

test("feature entry without resources or null deprecation entries render safely", async () => {
  const base = {
    getVersions: async () => [120],
    getFeaturesForVersion: async () => ({
      "Enabled by default": [{ id: 7, name: "ok" }],
    }),
    getFeaturesByType: async () => ({ features: [null] }),
    getChannels: async () => ({}),
  };
  const handler = createHandler({ client: fixtureClient(base as any) });
  const resIndex = await handler(new Request("https://chromestatuslite.com/"));
  equal(resIndex.status, 200);
  includes(await resIndex.text(), "Chrome 120");

  const resDep = await handler(
    new Request("https://chromestatuslite.com/deprecations"),
  );
  equal(resDep.status, 200);
  equal((await resDep.text()).includes("Unnamed feature"), false);
});

test("feature detail and feed render error-notices on upstream service failure", async () => {
  const boom = async () => {
    throw new Error("Upstream HTTP 500");
  };
  const failingClient = fixtureClient({
    getVersions: boom,
    getFeature: boom,
  });
  const handler = createHandler({ client: failingClient });

  const resFeature = await handler(
    new Request("https://chromestatuslite.com/feature/123456"),
  );
  equal(resFeature.status, 200);
  equal(resFeature.headers.get("cache-control"), "no-store");
  const featureText = await resFeature.text();
  includes(featureText, "error-notice");
  equal(featureText.includes("Feature not found"), false);

  const resFeed = await handler(
    new Request("https://chromestatuslite.com/feed.xml"),
  );
  equal(resFeed.status, 200);
  equal(resFeed.headers.get("cache-control"), "no-store");
  const feedText = await resFeed.text();
  includes(feedText, "Unable to load release data from chromestatus.com");
  equal((feedText.match(/<item>/g) || []).length, 1);
});

test("prefersMarkdown negotiates Accept headers with quality weights", () => {
  const req = (accept?: string) =>
    new Request(
      "https://chromestatuslite.com/",
      accept === undefined ? undefined : { headers: { accept } },
    );
  equal(prefersMarkdown(req()), false);
  equal(prefersMarkdown(req("*/*")), false);
  equal(prefersMarkdown(req("text/html, application/xhtml+xml, */*;q=0.8")), false);
  equal(prefersMarkdown(req("text/markdown")), true);
  equal(prefersMarkdown(req("text/markdown, text/html;q=0.9")), true);
  equal(prefersMarkdown(req("text/html;q=0.5, text/markdown;q=0.9")), true);
  equal(prefersMarkdown(req("text/html, text/markdown;q=0.5")), false);
  equal(prefersMarkdown(req("text/markdown;q=0, */*")), false);
  equal(prefersMarkdown(req("text/markdown; charset=utf-8; q=1.0")), true);
});

test("Accept: text/markdown returns clean Markdown for HTML pages and leaves non-HTML routes untouched", async () => {
  const store = new MemorySnapshotStore();
  const handler = createHandler({
    client: fixtureClient(),
    assets: env.ASSETS,
    store,
  });
  const mdHeaders = { accept: "text/markdown" };

  // Home page
  const homeRes = await handler(
    new Request("https://chromestatuslite.com/?version=120", {
      headers: mdHeaders,
    }),
  );
  equal(homeRes.status, 200);
  equal(homeRes.headers.get("content-type"), "text/markdown; charset=utf-8");
  includes(homeRes.headers.get("vary") || "", "Accept");
  equal(Number(homeRes.headers.get("x-markdown-tokens")) > 0, true);
  equal(homeRes.headers.get("speculation-rules"), null);
  equal(homeRes.headers.get("x-frame-options"), "DENY");
  const homeMd = await homeRes.text();
  includes(homeMd, "Source: https://chromestatuslite.com/?version=120");
  includes(homeMd, "# Chrome 120");
  includes(homeMd, "[Fixture feature](https://chromestatuslite.com/feature/123)");
  equal(homeMd.includes("<!doctype html>"), false);
  equal(homeMd.includes("Skip to content"), false);

  // Deprecations page renders a GFM Markdown table
  const depRes = await handler(
    new Request("https://chromestatuslite.com/deprecations", {
      headers: mdHeaders,
    }),
  );
  equal(depRes.headers.get("content-type"), "text/markdown; charset=utf-8");
  const depMd = await depRes.text();
  includes(depMd, "| Date | Name | Intent Stage | Chrome Version |");
  includes(depMd, "| --- | --- | --- | --- |");
  includes(
    depMd,
    "[Deprecated fixture](https://chromestatuslite.com/feature/123)",
  );

  // Feature detail renders definition list + links
  const featRes = await handler(
    new Request("https://chromestatuslite.com/feature/123", {
      headers: mdHeaders,
    }),
  );
  equal(featRes.headers.get("content-type"), "text/markdown; charset=utf-8");
  const featMd = await featRes.text();
  includes(featMd, "# Fixture feature");
  includes(featMd, "- **Status:** Enabled by default");
  includes(featMd, "## Ecosystem");

  // HEAD + Accept: text/markdown measures Markdown byte length and does not mutate snapshots
  const headStore = new MemorySnapshotStore();
  const headHandler = createHandler({
    client: fixtureClient(),
    store: headStore,
  });
  const headMd = await headHandler(
    new Request("https://chromestatuslite.com/feature/123", {
      method: "HEAD",
      headers: mdHeaders,
    }),
  );
  equal(headMd.status, 200);
  equal(headMd.headers.get("content-type"), "text/markdown; charset=utf-8");
  equal(await headMd.text(), "");
  equal(
    headMd.headers.get("content-length"),
    String(new TextEncoder().encode(featMd).length),
  );
  equal((await headStore.list("123")).length, 0);

  // Non-HTML routes & Google verification HTML ignore Accept: text/markdown
  const apiRes = await handler(
    new Request("https://chromestatuslite.com/api/version/120", {
      headers: mdHeaders,
    }),
  );
  includes(apiRes.headers.get("content-type") || "", "application/json");

  const rssRes = await handler(
    new Request("https://chromestatuslite.com/feed.xml", {
      headers: mdHeaders,
    }),
  );
  includes(rssRes.headers.get("content-type") || "", "application/rss+xml");

  const verifyRes = await handler(
    new Request("https://chromestatuslite.com/google1bf7ef037ae116eb.html", {
      headers: mdHeaders,
    }),
  );
  includes(verifyRes.headers.get("content-type") || "", "text/html");
  includes(
    await verifyRes.text(),
    "google-site-verification: google1bf7ef037ae116eb.html",
  );
});

test("/about renders Paul Kinlan's background and why ChromeStatusLite exists in HTML and Markdown", async () => {
  const handler = createHandler({ client: fixtureClient() });
  const htmlRes = await handler(
    new Request("https://chromestatuslite.com/about"),
  );
  equal(htmlRes.status, 200);
  equal(htmlRes.headers.get("content-type"), "text/html; charset=utf-8");
  includes(htmlRes.headers.get("vary") || "", "Accept");
  const html = await htmlRes.text();
  includes(html, "<h1>About ChromeStatusLite</h1>");
  includes(html, "Paul Kinlan");
  includes(html, 'href="https://paul.kinlan.me/"');
  includes(html, 'href="https://github.com/PaulKinlan/ChromeStatusLite"');
  includes(html, "chromestatus.com");
  includes(html, "can't run JavaScript");
  includes(html, 'href="/llms.txt"');

  const mdRes = await handler(
    new Request("https://chromestatuslite.com/about", {
      headers: { accept: "text/markdown" },
    }),
  );
  equal(mdRes.status, 200);
  equal(mdRes.headers.get("content-type"), "text/markdown; charset=utf-8");
  const md = await mdRes.text();
  includes(md, "# About ChromeStatusLite");
  includes(md, "[Paul Kinlan](https://paul.kinlan.me/)");
  includes(md, "<https://paul.kinlan.me/>");
  includes(md, "<https://github.com/PaulKinlan/ChromeStatusLite>");
  includes(md, "[/llms.txt](https://chromestatuslite.com/llms.txt)");

  // Entity-decoded angle brackets and autolinks must not be stripped or double-decoded.
  const tricky = htmlToMarkdown(
    '<!doctype html><html><head><link rel="canonical" href="https://chromestatuslite.com/feature/9"></head><body><main id="main"><h1>HTML &lt;dialog&gt; closedby</h1><p>Use <code>&lt;dialog&gt;</code> and &amp;lt;tag&amp;gt;. See <a href="https://example.com/">https://example.com/</a>.</p></main></body></html>',
  );
  includes(tricky, "# HTML <dialog> closedby");
  includes(tricky, "`<dialog>`");
  includes(tricky, "&lt;tag&gt;");
  includes(tricky, "<https://example.com/>");
});

test("/llms.txt serves agent index with security headers and lists every wiki topic", async () => {
  const handler = createHandler({ client: fixtureClient(), assets: env.ASSETS });
  const res = await handler(
    new Request("https://chromestatuslite.com/llms.txt"),
  );
  equal(res.status, 200);
  equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  equal(res.headers.get("x-frame-options"), "DENY");
  equal(res.headers.get("x-content-type-options"), "nosniff");
  const body = await res.text();
  includes(body, "# ChromeStatusLite");
  includes(body, "Accept: text/markdown");
  includes(body, "https://chromestatuslite.com/about");
  includes(body, "https://chromestatuslite.com/api/version/latest");
  for (const topic of WIKI_TOPICS) {
    includes(body, `https://chromestatuslite.com/wiki/${topic.slug}`);
  }
});

test("Worker edge cache keeps HTML and Accept: text/markdown entries separated", async () => {
  const ctxHtml = createExecutionContext();
  const htmlRes = await worker.fetch(
    new Request("https://chromestatuslite.com/about", {
      headers: { accept: "text/html" },
    }),
    env,
    ctxHtml,
  );
  await waitOnExecutionContext(ctxHtml);
  equal(htmlRes.status, 200);
  equal(htmlRes.headers.get("content-type"), "text/html; charset=utf-8");
  includes(await htmlRes.text(), "<!doctype html>");

  const ctxMd = createExecutionContext();
  const mdRes = await worker.fetch(
    new Request("https://chromestatuslite.com/about", {
      headers: { accept: "text/markdown" },
    }),
    env,
    ctxMd,
  );
  await waitOnExecutionContext(ctxMd);
  equal(mdRes.status, 200);
  equal(mdRes.headers.get("content-type"), "text/markdown; charset=utf-8");
  includes(await mdRes.text(), "# About ChromeStatusLite");

  // Subsequent browser HTML request must still get HTML, not cached Markdown.
  const ctxHtml2 = createExecutionContext();
  const htmlRes2 = await worker.fetch(
    new Request("https://chromestatuslite.com/about", {
      headers: { accept: "text/html" },
    }),
    env,
    ctxHtml2,
  );
  await waitOnExecutionContext(ctxHtml2);
  equal(htmlRes2.headers.get("content-type"), "text/html; charset=utf-8");
  includes(await htmlRes2.text(), "<!doctype html>");
});
