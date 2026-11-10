import { createHandler, stripBodyForHead } from "../src/handler.ts";
import { MemorySnapshotStore, type SnapshotStore } from "../src/lib/snapshots.ts";
import template, { raw } from "../src/flora.ts";
import feed from "../src/routes/feed.ts";
import apiVersion from "../src/routes/api-version.ts";
import breaking from "../src/routes/breaking.ts";
import originTrials from "../src/routes/origin-trials.ts";
import { equal, fixtureClient, includes, sampleFeature } from "./fixture.ts";

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

Deno.test("every HTML page shell declares lang=en (chrome-status-lite-tiu)", async () => {
  // WCAG 2.1 A 3.1.1: the page language must be programmatically determinable
  // from the root element. Pinned here for every route through the real handler
  // so a new or edited shell cannot drop the attribute without going red.
  const handler = createHandler(fixtureClient());
  const htmlRoutes = [
    "/",
    "/deprecations",
    "/feature/123",
    "/feature/123/history", // no store configured: still an HTML shell
    "/breaking",
    "/origin-trials",
    "/diff",
  ];
  for (const path of htmlRoutes) {
    const res = await handler(new Request(`https://chromestatuslite.com${path}`));
    equal(res.status, 200);
    includes(await res.text(), '<html lang="en">');
  }
  // The wiki shells render twice (directory + topic); probe the topic the
  // directory itself links, so the pair cannot drift apart.
  const wiki = await handler(new Request("https://chromestatuslite.com/wiki"));
  const wikiHtml = await wiki.text();
  includes(wikiHtml, '<html lang="en">');
  const topic = wikiHtml.match(/href="\/wiki\/([a-z0-9-]+)"/);
  if (!topic) throw new Error("wiki directory listed no topic to probe");
  const topicRes = await handler(new Request(`https://chromestatuslite.com/wiki/${topic[1]}`));
  equal(topicRes.status, 200);
  includes(await topicRes.text(), '<html lang="en">');
});

Deno.test("every page has one main landmark and a first-of-body skip link (chrome-status-lite-c8t)", async () => {
  // WCAG 2.1 A 2.4.1 Bypass Blocks: a <main id="main"> landmark per page plus
  // a skip link as the first body element (emitted by the shared nav component
  // before <nav>), so keyboard users can bypass the 7-link nav.
  const handler = createHandler(fixtureClient());
  const htmlRoutes = [
    "/",
    "/deprecations",
    "/feature/123",
    "/feature/123/history", // no store configured: still an HTML shell
    "/breaking",
    "/origin-trials",
    "/diff",
  ];
  for (const path of htmlRoutes) {
    const res = await handler(new Request(`https://chromestatuslite.com${path}`));
    equal(res.status, 200);
    const html = await res.text();
    includes(html, '<main id="main">');
    equal(html.split("<main").length - 1, 1, `${path}: exactly one <main>`);
    // The skip link must precede every nav link: first element after <body>.
    includes(
      html.slice(html.indexOf("<body>"), html.indexOf("<nav>")),
      '<a class="skip" href="#main">Skip to content</a>',
      `${path}: skip link first in body`,
    );
  }
  // The wiki shells render twice (directory + topic); probe the topic the
  // directory itself links, so the pair cannot drift apart.
  const wiki = await handler(new Request("https://chromestatuslite.com/wiki"));
  const wikiHtml = await wiki.text();
  includes(wikiHtml, '<main id="main">');
  const topic = wikiHtml.match(/href="\/wiki\/([a-z0-9-]+)"/);
  if (!topic) throw new Error("wiki directory listed no topic to probe");
  const topicRes = await handler(new Request(`https://chromestatuslite.com/wiki/${topic[1]}`));
  const topicHtml = await topicRes.text();
  includes(topicHtml, '<main id="main">');
  equal(topicHtml.split("<main").length - 1, 1, "wiki topic: exactly one <main>");
});

Deno.test("every page has exactly one h1 (chrome-status-lite-axi)", async () => {
  // WCAG 1.3.1 / 2.4.6: one top-level heading per page. The home shell used to
  // render a second h1 ("Chrome Release Summary") above the version h1 that
  // matches <title>; the shell label is now a .page-kicker paragraph.
  const handler = createHandler(fixtureClient());
  const htmlRoutes = [
    "/",
    "/?version=118",
    "/deprecations",
    "/feature/123",
    "/feature/123/history",
    "/breaking",
    "/origin-trials",
    "/diff",
  ];
  for (const path of htmlRoutes) {
    const res = await handler(new Request(`https://chromestatuslite.com${path}`));
    const html = await res.text();
    equal((html.match(/<h1[ >]/g) || []).length, 1, `${path}: exactly one h1`);
  }
  const wiki = await handler(new Request("https://chromestatuslite.com/wiki"));
  const wikiHtml = await wiki.text();
  equal((wikiHtml.match(/<h1[ >]/g) || []).length, 1, "/wiki: exactly one h1");
  const topic = wikiHtml.match(/href="\/wiki\/([a-z0-9-]+)"/);
  if (!topic) throw new Error("wiki directory listed no topic to probe");
  const topicRes = await handler(new Request(`https://chromestatuslite.com/wiki/${topic[1]}`));
  const topicHtml = await topicRes.text();
  equal((topicHtml.match(/<h1[ >]/g) || []).length, 1, "wiki topic: exactly one h1");
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

const drain = async (stream: ReadableStream): Promise<string> =>
  new Response(stream).text();

Deno.test("flora escapes interpolated strings by default (chrome-status-lite-btw)", async () => {
  const html = await drain(await template`<p>${'<img src=x onerror=alert(1)>'}</p>`);
  equal(html, "<p>&lt;img src=x onerror=alert(1)&gt;</p>");
});

Deno.test("flora escapes strings inside arrays and promises too", async () => {
  const html = await drain(await template`<ul>${
    ["<b>one</b>", Promise.resolve("<i>two</i>")]
  }</ul>`);
  equal(html, "<ul>&lt;b&gt;one&lt;/b&gt;&lt;i&gt;two&lt;/i&gt;</ul>");
});

Deno.test("flora emits raw() values verbatim and passes nested templates through as markup", async () => {
  const html = await drain(await template`<div>${raw("<em>ok</em>")}</div>`);
  equal(html, "<div><em>ok</em></div>");

  // A nested template result is a ReadableStream of already-rendered (and
  // already escaped at its own interpolations) markup: it must stream
  // through unchanged rather than being re-escaped.
  const inner = template`<b>${"<i>inner</i>"}</b>`;
  const outer = await drain(await template`<div>${inner}</div>`);
  equal(outer, "<div><b>&lt;i&gt;inner&lt;/i&gt;</b></div>");
});

Deno.test("flora interpolates numbers and null/undefined without escaping artifacts", async () => {
  const html = await drain(await template`<p>${42}:${null}:${undefined}</p>`);
  equal(html, "<p>42::</p>");
});

Deno.test("flora escapes object leaves with a custom toString (chrome-status-lite-d9n)", async () => {
  const hostile = { toString: () => "<script>alert(1)</script>" };
  const html = await drain(await template`<p>${hostile}</p>`);
  equal(html, "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  // A String wrapper is an object, not a typeof string: same escaping.
  const wrapped = await drain(await template`<p>${new String("<b>x</b>")}</p>`);
  equal(wrapped, "<p>&lt;b&gt;x&lt;/b&gt;</p>");
  // Numbers/booleans are unchanged by escaping their string form.
  const plain = await drain(await template`<p>${120}:${true}</p>`);
  equal(plain, "<p>120:true</p>");
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
