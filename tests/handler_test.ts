import { createHandler, stripBodyForHead } from "../src/handler.ts";
import { MemorySnapshotStore, type SnapshotStore } from "../src/lib/snapshots.ts";
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
    const csp = res.headers.get("content-security-policy") || "";
    equal(csp, "default-src 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'");
    // Pin the hardening directives explicitly so a future header edit cannot silently drop them.
    for (const directive of ["base-uri 'none'", "object-src 'none'", "form-action 'self'", "frame-ancestors 'none'"]) {
      includes(csp, directive);
    }
    equal(res.headers.get("x-content-type-options"), "nosniff");
    equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    equal(res.headers.get("x-frame-options"), "DENY");
    await res.body?.cancel();
  }
});

Deno.test("a rejecting route returns a hardened 500, not Deno.serve's bare one (chrome-status-lite-0nj)", async () => {
  // Without the try/catch in createHandler this rejection escapes the handler
  // and Deno.serve synthesises a 500 with none of SECURITY_HEADERS; removing
  // the catch makes this suite fail (await handler rejects, headers missing).
  // A non-async getVersions double is legal (StatusClient is structural) and
  // its sync throw escapes the api-version route: the call at the whitelist
  // step runs before the route's .catch(() => []) can attach, so route()
  // rejects — a seam none of the routes' internal catches cover.
  const handler = createHandler(fixtureClient({
    getVersions: () => { throw new TypeError("upstream socket reset"); },
  }));
  const res = await handler(new Request("https://chromestatuslite.com/api/version/120"));
  equal(res.status, 500);
  equal(await res.text(), "Internal Server Error");
  const csp = res.headers.get("content-security-policy") || "";
  equal(csp, "default-src 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'");
  equal(res.headers.get("x-content-type-options"), "nosniff");
  equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  equal(res.headers.get("x-frame-options"), "DENY");

  // The error gate composes with the HEAD strip: no body, byte-accurate length.
  const head = await handler(new Request("https://chromestatuslite.com/api/version/120", { method: "HEAD" }));
  equal(head.status, 500);
  equal(await head.text(), "");
  equal(head.headers.get("content-length"), String(new TextEncoder().encode("Internal Server Error").length));
  equal(head.headers.get("x-frame-options"), "DENY");
});

Deno.test("non-GET/HEAD verbs are rejected with 405 and Allow before dispatch", async () => {
  const client = fixtureClient({
    getVersions: () => { throw Error("must not touch upstream"); },
    getFeaturesForVersion: () => { throw Error("must not touch upstream"); },
    getFeature: () => { throw Error("must not touch upstream"); },
  });
  const store = new Proxy({} as SnapshotStore, {
    get: () => () => { throw Error("must not touch the snapshot store"); },
  });
  const handler = createHandler(client, undefined, store);

  for (const method of ["POST", "PUT", "DELETE"]) {
    for (const path of ["/", "/feature/123", "/api/version/120"]) {
      const res = await handler(new Request(`https://chromestatuslite.com${path}`, { method }));
      equal(res.status, 405);
      equal(res.headers.get("allow"), path.startsWith("/api/version/") ? "GET, HEAD, OPTIONS" : "GET, HEAD");
      equal(await res.text(), "");
    }
  }
  // OPTIONS preflight still reaches the API route (204, not 405).
  const preflight = await handler(new Request("https://chromestatuslite.com/api/version/120", { method: "OPTIONS" }));
  equal(preflight.status, 204);
});

Deno.test("HEAD responses carry GET headers, no body, and never mutate the snapshot store (chrome-status-lite-rw6)", async () => {
  const store = new MemorySnapshotStore();
  const handler = createHandler(fixtureClient(), undefined, store);

  // HEAD first, on an empty store: RFC 9110 9.3.2 (HEAD = GET minus the
  // body) and HEAD is safe — it must not capture a snapshot.
  const head = await handler(
    new Request("https://chromestatuslite.com/feature/123", { method: "HEAD" }),
  );
  equal(head.status, 200);
  equal(await head.text(), "");
  equal((await store.list("123")).length, 0);

  // The same view over GET renders fully, captures exactly once, and the
  // HEAD headers above described exactly this representation (incl. the
  // byte-accurate content-length).
  const getRes = await handler(new Request("https://chromestatuslite.com/feature/123"));
  const getText = await getRes.text();
  equal(getRes.status, 200);
  equal(head.headers.get("content-type"), getRes.headers.get("content-type"));
  equal(
    head.headers.get("content-length"),
    String(new TextEncoder().encode(getText).length),
  );
  equal((await store.list("123")).length, 1);

  // The central strip covers every route, not just /feature/:id.
  const headIndex = await handler(new Request("https://chromestatuslite.com/", { method: "HEAD" }));
  equal(headIndex.status, 200);
  equal(await headIndex.text(), "");
});

Deno.test("HEAD strip measures body bytes, not decoded text (chrome-status-lite-38e)", async () => {
  // Non-UTF-8 bodies must not pass through text(): decoding replaces invalid
  // bytes with U+FFFD (3 bytes each), so the reported content-length would be
  // larger than the GET representation's actual byte length.
  const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]);
  const stripped = await stripBodyForHead(
    new Response(binary, { headers: { "content-type": "application/octet-stream" } }),
  );
  equal(stripped.headers.get("content-length"), String(binary.byteLength));
  equal(stripped.headers.get("content-type"), "application/octet-stream");
  equal(await stripped.text(), "");

  // A streamed body drains to the same byte count (flora templates and the
  // static route both produce streamed/byte bodies, never in-memory strings).
  const streamed = await stripBodyForHead(
    new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(binary);
        controller.close();
      },
    })),
  );
  equal(streamed.headers.get("content-length"), String(binary.byteLength));
});

Deno.test("HEAD strip counts a multi-chunk stream and keeps a route-supplied length on a null body (chrome-status-lite-735)", async () => {
  // A chunked stream is drained piece by piece: the content-length is the
  // sum of every chunk, and no single buffer ever holds the whole body.
  const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6, 7, 8, 9])];
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const counted = await stripBodyForHead(
    new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    })),
  );
  equal(counted.headers.get("content-length"), String(total));
  equal(await counted.text(), "");

  // A route that answered HEAD directly (static route via Deno.stat) has a
  // null body and an explicit content-length: keep it, don't overwrite to 0.
  const kept = await stripBodyForHead(
    new Response(null, { headers: { "content-length": "42", "content-type": "text/css" } }),
  );
  equal(kept.headers.get("content-length"), "42");
  equal(kept.headers.get("content-type"), "text/css");

  // Any other null body (redirects, 405s) is genuinely empty.
  const empty = await stripBodyForHead(new Response(null));
  equal(empty.headers.get("content-length"), "0");
});

Deno.test("HEAD on a static asset answers from file metadata with the GET byte length (chrome-status-lite-735)", async () => {
  const handler = createHandler(fixtureClient());
  const getRes = await handler(new Request("https://chromestatuslite.com/styles/index.css"));
  equal(getRes.status, 200);
  const getBytes = new Uint8Array(await getRes.arrayBuffer());

  const head = await handler(new Request("https://chromestatuslite.com/styles/index.css", { method: "HEAD" }));
  equal(head.status, 200);
  equal(await head.text(), "");
  // The probe reports exactly the GET representation's byte length and type.
  equal(head.headers.get("content-length"), String(getBytes.byteLength));
  includes(head.headers.get("content-type") || "", "text/css");

  // The stat fast path stays behind the same whitelist: unknown and
  // traversal paths still 404 on HEAD.
  for (const path of ["/unknown", "/scripts/missing.js", "/scripts/%2e%2e%2fmain.ts"]) {
    const res = await handler(new Request(`https://chromestatuslite.com${path}`, { method: "HEAD" }));
    equal(res.status, 404);
    equal(await res.text(), "");
  }
});

Deno.test("static HEAD never reads the file: a stat-only filesystem still answers (chrome-status-lite-70n)", async () => {
  // Discriminator for the stat fast path: inject a filesystem whose readFile
  // always throws. HEAD must answer from stat metadata alone; if the HEAD
  // branch regresses to Deno.readFile (the pre-735 code), it throws and this
  // goes red. GET keeps using readFile, so it 404s here — proving the seam.
  const statOnlyFs = {
    stat: async () => ({ isFile: true, size: 4321 }) as Deno.FileInfo,
    readFile: async () => { throw new Error("readFile must not be called for HEAD"); },
  };
  const handler = createHandler(fixtureClient(), "/nonexistent-static-root", null, statOnlyFs);

  const head = await handler(new Request("https://chromestatuslite.com/styles/index.css", { method: "HEAD" }));
  equal(head.status, 200);
  equal(head.headers.get("content-length"), "4321");
  includes(head.headers.get("content-type") || "", "text/css");
  equal(await head.text(), "");

  // A directory-shaped stat result is not a file: 404, and readFile unused.
  const dirFs = {
    stat: async () => ({ isFile: false, size: 0 }) as Deno.FileInfo,
    readFile: async () => { throw new Error("readFile must not be called for HEAD"); },
  };
  const dirHandler = createHandler(fixtureClient(), "/nonexistent-static-root", null, dirFs);
  const dirHead = await dirHandler(new Request("https://chromestatuslite.com/styles/index.css", { method: "HEAD" }));
  equal(dirHead.status, 404);

  // GET on the stat-only fs proves readFile is the GET path (and that the
  // injected seam, not real disk, answered the HEAD above).
  const getRes = await handler(new Request("https://chromestatuslite.com/styles/index.css"));
  equal(getRes.status, 404);
});

Deno.test("HEAD strip holds peak memory to a chunk, not the whole body (chrome-status-lite-70n)", async () => {
  // Discriminator for the streaming drain: measure RSS growth across the
  // strip of a 256 MiB stream. An arrayBuffer() drain materialises the whole
  // body, so RSS ends >= 256 MiB higher; chunk-by-chunk counting discards as
  // it goes and allocation-driven GC keeps the residue small (reviewer
  // measured 559 MiB peak old vs 105 MiB new on this size). The 64 MiB delta
  // threshold sits far from both outcomes, so GC noise cannot flip it.
  const chunks = 256;
  const chunk = new Uint8Array(1024 * 1024); // 1 MiB
  const baselineRss = Deno.memoryUsage().rss;
  let pulled = 0;
  const stripped = await stripBodyForHead(
    new Response(new ReadableStream({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk);
        if (pulled === chunks) controller.close();
      },
    })),
  );
  equal(stripped.headers.get("content-length"), String(chunks * chunk.byteLength));
  equal(pulled, chunks); // the whole stream was measured, not truncated
  const retainedMiB = (Deno.memoryUsage().rss - baselineRss) / (1024 * 1024);
  if (retainedMiB >= 64) {
    throw new Error(
      `HEAD strip grew RSS by ~${retainedMiB.toFixed(0)} MiB draining a 256 MiB stream — ` +
      "the drain buffers the whole body instead of counting chunks",
    );
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
