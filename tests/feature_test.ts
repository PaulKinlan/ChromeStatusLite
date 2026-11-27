import { test } from "vitest";
import { createHandler } from "../src/handler.ts";
import { MemorySnapshotStore } from "../src/lib/snapshots.ts";
import { sanitizeUrl } from "../src/lib/url.ts";
import { UpstreamFetchBudgetError } from "../src/lib/utils.ts";
import { equal, fixtureClient, includes, sampleFeature } from "./fixture.ts";

test("feature detail renders fixture and canonical URL", async () => {
  const response = await createHandler({ client: fixtureClient() })(
    new Request("https://chromestatuslite.com/feature/123?ref=nav"),
  );
  equal(response.status, 200);
  const html = await response.text();
  includes(html, "Fixture feature");
  includes(html, 'href="https://chromestatuslite.com/feature/123?ref=nav"');
  includes(html, "A fixture summary");
});

test("feature detail exposes impact, flag, WPT and spec maturity", async () => {
  const client = fixtureClient({
    getFeature: async () => ({
      id: 123,
      name: "Metadata feature",
      summary: "Summary",
      resources: { docs: [], samples: [] },
      breaking_change: false,
      enterprise_impact: 2,
      flag_name: "test-flag",
      wpt: true,
      wpt_descr: "<unsafe>test coverage",
      standards: { maturity: { short_text: "Published standard" } },
    }),
  });
  const html = await (await createHandler({ client })(
    new Request("https://chromestatuslite.com/feature/123"),
  )).text();
  includes(html, "Breaking change:</strong> No");
  includes(html, "Enterprise impact:</strong> Low");
  includes(html, "Chromium flag:</strong> test-flag");
  includes(html, "Web Platform Tests:</strong> Yes");
  includes(html, "Spec maturity:</strong> Published standard");
  includes(html, "WPT details: &lt;unsafe&gt;test coverage");
});

test("invalid and absent feature ids return 404 without an upstream call", async () => {
  const handler = createHandler({
    client: fixtureClient({
      getFeature: async () => {
        throw new Error("Upstream HTTP 404 from /api/v0/features/456");
      },
    }),
  });
  equal(
    (await handler(new Request("https://chromestatuslite.com/feature/not-a-number")))
      .status,
    404,
  );
  const missing = await handler(
    new Request("https://chromestatuslite.com/feature/456"),
  );
  equal(missing.status, 404);
  equal(missing.headers.get("cache-control"), "no-store");
  includes(await missing.text(), "Feature not found");
});

test("overlong numeric feature ids are bounded at the seam (chrome-status-lite-s9w)", async () => {
  let upstreamCalls = 0;
  const handler = createHandler({
    client: fixtureClient({
      getFeature: async () => {
        upstreamCalls++;
        return sampleFeature;
      },
    }),
  });
  const overlong = "5".repeat(17);
  equal(
    (await handler(new Request(`https://chromestatuslite.com/feature/${overlong}`)))
      .status,
    404,
  );
  equal(upstreamCalls, 0);
  const plausible = await handler(
    new Request("https://chromestatuslite.com/feature/5082469066604544"),
  );
  equal(plausible.status, 200);
  equal(upstreamCalls, 1);
});

test("feature detail linkifies URLs in summary, motivation, signals and notes", async () => {
  const client = fixtureClient({
    getFeature: async () => ({
      id: 123,
      name: "Linked feature",
      summary: "See https://github.com/WebKit/WebKit/pull/70542.",
      motivation: "Filed as https://crbug.com/500967896 for details",
      wpt_descr: "Covered by https://wpt.fyi/results/abc",
      browsers: {
        chrome: { status: { text: "Enabled by default" } },
        safari: {
          view: {
            text: "Support planned, tracked in https://bugs.webkit.org/123",
            notes: "Position: https://webkit.org/position/",
          },
        },
      },
      resources: { docs: [], samples: [] },
    }),
  });
  const html = await (await createHandler({ client })(
    new Request("https://chromestatuslite.com/feature/123"),
  )).text();
  includes(
    html,
    '<a href="https://github.com/WebKit/WebKit/pull/70542" rel="noopener noreferrer">https://github.com/WebKit/WebKit/pull/70542</a>.',
  );
  includes(
    html,
    '<a href="https://crbug.com/500967896" rel="noopener noreferrer">https://crbug.com/500967896</a>',
  );
  includes(
    html,
    '<a href="https://wpt.fyi/results/abc" rel="noopener noreferrer">',
  );
  includes(
    html,
    '<a href="https://bugs.webkit.org/123" rel="noopener noreferrer">',
  );
  includes(
    html,
    '<a href="https://webkit.org/position/" rel="noopener noreferrer">',
  );
});

test("linkify keeps surrounding text escaped and ignores non-http schemes", async () => {
  const client = fixtureClient({
    getFeature: async () => ({
      id: 124,
      name: "Unsafe feature",
      summary:
        "Evil <script>alert(1)</script> and ftp://example.com/x and javascript:alert(2)",
      resources: { docs: [], samples: [] },
    }),
  });
  const html = await (await createHandler({ client })(
    new Request("https://chromestatuslite.com/feature/124"),
  )).text();
  includes(html, "&lt;script&gt;alert(1)&lt;/script&gt;");
  equal(html.includes("javascript:alert(2)</a>"), false);
  equal(html.includes('href="ftp://example.com/x"'), false);
});

test("linkify links scheme-less tracker and PR references", async () => {
  const client = fixtureClient({
    getFeature: async () => ({
      id: 125,
      name: "Bare references",
      motivation:
        "Spec PR github.com/whatwg/html/pull/123 and the bug crbug.com/500967896 (fixed).",
      browsers: {
        safari: {
          view: {
            text: "No signal",
            notes:
              "See bugzilla.mozilla.org/show_bug.cgi?id=1 and example.com/not-a-tracker",
          },
        },
      },
      resources: { docs: [], samples: [] },
    }),
  });
  const html = await (await createHandler({ client })(
    new Request("https://chromestatuslite.com/feature/125"),
  )).text();
  includes(
    html,
    '<a href="https://github.com/whatwg/html/pull/123" rel="noopener noreferrer">github.com/whatwg/html/pull/123</a>',
  );
  includes(
    html,
    '<a href="https://crbug.com/500967896" rel="noopener noreferrer">crbug.com/500967896</a>',
  );
  includes(
    html,
    '<a href="https://bugzilla.mozilla.org/show_bug.cgi?id=1" rel="noopener noreferrer">bugzilla.mozilla.org/show_bug.cgi?id=1</a>',
  );
  equal(html.includes('href="https://example.com/not-a-tracker"'), false);
  includes(html, "example.com/not-a-tracker");
});

test("a view with a url does not nest anchors around its text", async () => {
  const client = fixtureClient({
    getFeature: async () => ({
      id: 127,
      name: "Nested anchor guard",
      summary: "Summary",
      browsers: {
        safari: {
          view: {
            text: "Positive, see https://webkit.org/position/1",
            url: "https://webkit.org/standards-positions/1",
            notes:
              "Discussed in https://github.com/WebKit/standards-positions/issues/1",
          },
        },
      },
      resources: { docs: [], samples: [] },
    }),
  });
  const html = await (await createHandler({ client })(
    new Request("https://chromestatuslite.com/feature/127"),
  )).text();
  includes(
    html,
    '<a href="https://webkit.org/standards-positions/1">Positive, see https://webkit.org/position/1</a>',
  );
  equal(html.includes('href="https://webkit.org/position/1"'), false);
  includes(
    html,
    '<a href="https://github.com/WebKit/standards-positions/issues/1" rel="noopener noreferrer">',
  );
  equal(/<a\b[^>]*>[^<]*<a\b/.test(html), false);
});

test("a view without a url still linkifies its text", async () => {
  const client = fixtureClient({
    getFeature: async () => ({
      id: 128,
      name: "Free-text view",
      summary: "Summary",
      browsers: {
        ff: {
          view: { text: "No signal, tracked at https://bugzilla.mozilla.org/1" },
        },
      },
      resources: { docs: [], samples: [] },
    }),
  });
  const html = await (await createHandler({ client })(
    new Request("https://chromestatuslite.com/feature/128"),
  )).text();
  includes(
    html,
    '<a href="https://bugzilla.mozilla.org/1" rel="noopener noreferrer">https://bugzilla.mozilla.org/1</a>',
  );
});

test("upstream urls cannot break out of their href attributes", async () => {
  const evil = 'https://example.com/x" onmouseover="alert(1)';
  const client = fixtureClient({
    getFeature: async () => ({
      id: 129,
      name: "Hostile urls",
      summary: "Summary",
      spec_link: evil,
      bug_url: evil,
      browsers: { safari: { view: { text: "Position", url: evil } } },
      resources: { docs: [evil], samples: [evil] },
      explainer_links: [evil],
    }),
  });
  const html = await (await createHandler({ client })(
    new Request("https://chromestatuslite.com/feature/129"),
  )).text();
  equal(html.includes('onmouseover="'), false);
  includes(html, 'href="https://example.com/x%22%20onmouseover=%22alert(1)"');
  equal(html.includes("&quot;"), false);
});

test("sanitizeUrl emits the serialization it validated, not the raw input (chrome-status-lite-2df)", () => {
  equal(sanitizeUrl(" https://example.com/a b"), "https://example.com/a%20b");
  equal(sanitizeUrl("HTTPS://Example.COM/A"), "https://example.com/A");
  equal(sanitizeUrl("https:\\evil.com"), "https://evil.com/");
  equal(sanitizeUrl("javascript:alert(1)"), null);
  equal(sanitizeUrl("data:text/html,<script>alert(1)</script>"), null);
  equal(sanitizeUrl("/relative/path"), null);
  equal(sanitizeUrl(""), null);
  equal(sanitizeUrl(undefined), null);
});

test("feature detail drops non-http(s) hrefs in every upstream url field", async () => {
  const evil = [
    "javascript:alert(document.domain)",
    "data:text/html,<script>alert(1)</script>",
  ];
  for (const url of evil) {
    const client = fixtureClient({
      getFeature: async () => ({
        id: 130,
        name: "Scheme attack",
        summary: "Summary",
        spec_link: url,
        bug_url: url,
        browsers: { safari: { view: { text: "Position", url } } },
        resources: { docs: [url], samples: [url] },
        doc_links: [url],
        sample_links: [url],
        explainer_links: [url],
      }),
    });
    const html = await (await createHandler({ client })(
      new Request("https://chromestatuslite.com/feature/130"),
    )).text();
    equal(html.includes('href="javascript:'), false);
    equal(html.includes('href="data:'), false);
    equal(html.includes(url), false);
  }
});

test("feature detail keeps http(s) hrefs in upstream url fields", async () => {
  const url = "https://example.com/spec";
  const client = fixtureClient({
    getFeature: async () => ({
      id: 131,
      name: "Honest links",
      summary: "Summary",
      spec_link: url,
      bug_url: url,
      browsers: { safari: { view: { text: "Position", url } } },
      doc_links: [url],
      sample_links: [url],
      explainer_links: [url],
    }),
  });
  const html = await (await createHandler({ client })(
    new Request("https://chromestatuslite.com/feature/131"),
  )).text();
  includes(html, `<a href="${url}">${url}</a>`);
  includes(html, `<a href="${url}">Position</a>`);
});

test("feature detail renders updated ecosystem cross-links and webstatus.dev Baseline badge", async () => {
  const client = fixtureClient({
    getFeature: async () => ({
      id: 123,
      name: "View Transitions",
      summary: "A fixture summary",
      web_feature: "view-transitions",
      wpt_descr: "Covered by css/view-transitions/*.html",
      resources: { docs: [], samples: [] },
    }),
    getWebStatusFeature: async (slug) => {
      equal(slug, "view-transitions");
      return {
        feature_id: "view-transitions",
        baseline: { status: "newly", low_date: "2025-10-01" },
        browser_implementations: {
          chrome: { status: "available", version: "111" },
          edge: { status: "available", version: "111" },
          firefox: { status: "available", version: "144" },
          safari: { status: "available", version: "18" },
        },
      };
    },
  });
  const html = await (await createHandler({ client })(
    new Request("https://chromestatuslite.com/feature/123"),
  )).text();
  includes(html, 'href="https://wpt.fyi/results/?q=css%2Fview-transitions"');
  includes(
    html,
    'href="https://chrome-platform-showcase.com/features?q=View%20Transitions"',
  );
  includes(html, 'href="https://gendn.dev/features?q=View%20Transitions"');
  includes(
    html,
    'href="https://www.google.com/search?q=site%3Achrome.dev+View%20Transitions"',
  );
  includes(
    html,
    'href="https://www.google.com/search?q=site%3Aweb.dev+View%20Transitions"',
  );
  includes(
    html,
    'href="https://developer.mozilla.org/en-US/search?q=View%20Transitions"',
  );
  includes(html, 'href="https://webstatus.dev/features/view-transitions"');
  includes(html, "Baseline Newly available (since 2025-10-01)");
  includes(html, "(Chrome 111, Edge 111, Firefox 144, Safari 18)");
  equal((html.match(/rel="noopener noreferrer"/g) || []).length >= 7, true);
});

test("feature detail falls back to webstatus.dev search URL when web_feature is absent", async () => {
  const client = fixtureClient({
    getFeature: async () => ({
      id: 123,
      name: "View Transitions",
      summary: "A fixture summary",
      resources: { docs: [], samples: [] },
    }),
  });
  const html = await (await createHandler({ client })(
    new Request("https://chromestatuslite.com/feature/123"),
  )).text();
  includes(html, 'href="https://webstatus.dev/?q=View%20Transitions"');
});

test("feature detail schedules snapshot capture via waitUntil when provided", async () => {
  const store = new MemorySnapshotStore();
  const background: Promise<unknown>[] = [];
  const handler = createHandler({
    client: fixtureClient(),
    store,
    waitUntil: (p) => background.push(p),
  });
  const res = await handler(
    new Request("https://chromestatuslite.com/feature/123"),
  );
  equal(res.status, 200);
  equal(background.length, 1);
  await Promise.all(background);
  equal((await store.list("123")).length, 1);
});

test("feature detail omits the ecosystem section when the feature has no name", async () => {
  const client = fixtureClient({
    getFeature: async () => ({
      id: 124,
      name: "",
      summary: "Anonymous",
      resources: { docs: [], samples: [] },
    }),
  });
  const html = await (await createHandler({ client })(
    new Request("https://chromestatuslite.com/feature/124"),
  )).text();
  equal(html.includes("<h2>Ecosystem</h2>"), false);
  equal(html.includes("wpt.fyi/results/?q="), false);
});

test("ecosystem WPT link prefers the feature's real WPT path over the name slug", async () => {
  const client = fixtureClient({
    getFeature: async () => ({
      id: 125,
      name: "Element.scrollIntoView()",
      summary: "Scrolling",
      wpt_descr: "css/cssom-view/scrollIntoView-*.html",
      resources: { docs: [], samples: [] },
    }),
  });
  const html = await (await createHandler({ client })(
    new Request("https://chromestatuslite.com/feature/125"),
  )).text();
  includes(
    html,
    'href="https://wpt.fyi/results/?q=css%2Fcssom-view%2FscrollIntoView"',
  );
  equal(html.includes("q=element-scrollintoview"), false);
});

test("a malformed percent escape in wpt_descr cannot 500 the feature page", async () => {
  const client = fixtureClient({
    getFeature: async () => ({
      id: 126,
      name: "Malformed percent",
      summary: "s",
      wpt_descr: "see https://x.test/?q=50%",
      resources: { docs: [], samples: [] },
    }),
  });
  const res = await createHandler({ client })(
    new Request("https://chromestatuslite.com/feature/126"),
  );
  equal(res.status, 200);
  const text = await res.text();
  includes(text, "wpt.fyi/results/?q=50%25");
});

test("an encoded script in the wpt q= param is re-encoded in href and escaped in text", async () => {
  const client = fixtureClient({
    getFeature: async () => ({
      id: 127,
      name: "Hostile q",
      summary: "s",
      wpt_descr:
        "https://wpt.fyi/results/?q=test%3Cscript%3Ealert(1)%3C/script%3E",
      resources: { docs: [], samples: [] },
    }),
  });
  const res = await createHandler({ client })(
    new Request("https://chromestatuslite.com/feature/127"),
  );
  equal(res.status, 200);
  const text = await res.text();
  equal(text.includes("<script>alert(1)</script>"), false);
  includes(text, 'q=test%3Cscript%3Ealert(1)%3C%2Fscript%3E" rel="noopener');
  includes(
    text,
    '_blank">https://wpt.fyi/results/?q=test%3Cscript%3Ealert(1)',
  );
});

const ecosystemHtml = async (wpt_descr: string, id = 200) => {
  const client = fixtureClient({
    getFeature: async () => ({
      id,
      name: "Probe feature",
      summary: "s",
      wpt_descr,
      resources: { docs: [], samples: [] },
    }),
  });
  return await (await createHandler({ client })(
    new Request(`https://chromestatuslite.com/feature/${id}`),
  )).text();
};

test("ecosystem WPT query from a github blob URL strips host, branch and file extension", async () => {
  const html = await ecosystemHtml(
    "https://github.com/web-platform-tests/wpt/blob/master/css/css-ui/animation/caret-animation-parsing.html",
  );
  includes(
    html,
    'href="https://wpt.fyi/results/?q=css%2Fcss-ui%2Fanimation%2Fcaret-animation-parsing"',
  );
  equal(html.includes("q=probe-feature"), false);
});

test("ecosystem WPT query from a github tree URL keeps the directory path", async () => {
  const html = await ecosystemHtml(
    "https://github.com/web-platform-tests/wpt/tree/master/content-security-policy/script-src/tentative",
  );
  includes(
    html,
    'href="https://wpt.fyi/results/?q=content-security-policy%2Fscript-src"',
  );
  equal(html.includes("q=probe-feature"), false);
});

test("ecosystem WPT query from a wpt.fyi /results/ URL uses the test path", async () => {
  const html = await ecosystemHtml(
    "Covered by https://wpt.fyi/results/dom/events/Event-dispatch.html in full",
  );
  includes(
    html,
    'href="https://wpt.fyi/results/?q=dom%2Fevents%2FEvent-dispatch"',
  );
  equal(html.includes("q=probe-feature"), false);
});

test("ecosystem WPT query from a host-form wpt.fyi URL without /results/ keeps two directories", async () => {
  const html = await ecosystemHtml(
    "Also at https://wpt.fyi/css/css-ui/animation and in the spec",
  );
  includes(html, 'href="https://wpt.fyi/results/?q=css%2Fcss-ui"');
  equal(html.includes("q=probe-feature"), false);
});

test("ecosystem WPT query from an external/wpt/ path drops the prefix", async () => {
  const html = await ecosystemHtml(
    "Landed as external/wpt/dom/events/Event-dispatch.html in the gecko tree",
  );
  includes(
    html,
    'href="https://wpt.fyi/results/?q=dom%2Fevents%2FEvent-dispatch"',
  );
  equal(html.includes("q=probe-feature"), false);
});

test("ecosystem WPT q= param wins verbatim even when prose slash-words come first", async () => {
  const html = await ecosystemHtml(
    "was css/cssom-view/scrollIntoView-*.html; now tracked at https://wpt.fyi/results/?q=dom%2Fintroduction",
  );
  includes(html, 'href="https://wpt.fyi/results/?q=dom%2Fintroduction"');
  equal(html.includes("q=css%2Fcssom-view%2FscrollIntoView"), false);
  equal(html.includes("q=results"), false);
});

test("ecosystem WPT query falls back to the name slug when wpt_descr has no WPT shape", async () => {
  const html = await ecosystemHtml(
    "See the demo on example.com/docs/page and the discuss thread changed/removed",
  );
  includes(html, 'href="https://wpt.fyi/results/?q=probe-feature"');
  equal(html.includes("q=example-com"), false);
  equal(html.includes("q=changed"), false);
});

test("feature detail renders error-notice, not 404, for a 200 body of literal null", async () => {
  const handler = createHandler({
    client: fixtureClient({ getFeature: async () => null }),
  });

  const res = await handler(
    new Request("https://chromestatuslite.com/feature/123456"),
  );
  equal(res.status, 200);
  equal(res.headers.get("cache-control"), "no-store");
  const text = await res.text();
  includes(text, "error-notice");
  equal(text.includes("Feature not found"), false);
});

test("feature detail renders error-notice, not 404, for a 200 object without an id", async () => {
  const handler = createHandler({
    client: fixtureClient({ getFeature: async () => ({ name: "Shapeless" }) }),
  });

  const res = await handler(
    new Request("https://chromestatuslite.com/feature/123456"),
  );
  equal(res.status, 200);
  const text = await res.text();
  includes(text, "error-notice");
  equal(text.includes("Feature not found"), false);
});

test("feature detail keeps the authoritative 404 for a genuine upstream not-found", async () => {
  const handler = createHandler({
    client: fixtureClient({
      getFeature: async () => {
        throw new Error("Upstream HTTP 404 from /api/v0/features/999999");
      },
    }),
  });

  const res = await handler(
    new Request("https://chromestatuslite.com/feature/999999"),
  );
  equal(res.status, 404);
  const text = await res.text();
  includes(text, "Feature not found");
  equal(text.includes("error-notice"), false);
});

test("/feature/:id answers an exhausted fetch budget with 429 and Retry-After (chrome-status-lite-d9s)", async () => {
  const handler = createHandler({
    client: fixtureClient({
      getFeature: async () => {
        throw new UpstreamFetchBudgetError(2400);
      },
    }),
  });
  const response = await handler(
    new Request("https://chromestatuslite.com/feature/123"),
  );
  equal(response.status, 429);
  equal(response.headers.get("retry-after"), "3");
  equal(response.headers.get("cache-control"), "no-store");
  const html = await response.text();
  includes(html, "Too many feature lookups");
  equal(
    html.includes("Unable to load feature details from chromestatus.com"),
    false,
  );
});
