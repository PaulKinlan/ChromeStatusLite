import { createHandler } from "../src/handler.ts";
import { equal, fixtureClient, includes } from "./fixture.ts";

Deno.test("feature detail renders fixture and canonical URL", async () => {
  const response = await createHandler(fixtureClient())(new Request("https://chromestatuslite.com/feature/123?ref=nav"));
  equal(response.status, 200);
  const html = await response.text();
  includes(html, "Fixture feature");
  includes(html, 'href="https://chromestatuslite.com/feature/123?ref=nav"');
  includes(html, "A fixture summary");
});

Deno.test("feature detail exposes impact, flag, WPT and spec maturity", async () => {
  const client = fixtureClient({ getFeature: async () => ({
    id: 123, name: "Metadata feature", summary: "Summary", resources: { docs: [], samples: [] },
    breaking_change: false, enterprise_impact: 2, flag_name: 'test-flag',
    wpt: true, wpt_descr: '<unsafe>test coverage',
    standards: { maturity: { short_text: "Published standard" } },
  }) });
  const html = await (await createHandler(client)(new Request("https://chromestatuslite.com/feature/123"))).text();
  includes(html, "Breaking change:</strong> No");
  includes(html, "Enterprise impact:</strong> Low");
  includes(html, "Chromium flag:</strong> test-flag");
  includes(html, "Web Platform Tests:</strong> Yes");
  includes(html, "Spec maturity:</strong> Published standard");
  includes(html, "WPT details: &lt;unsafe&gt;test coverage");
});

Deno.test("invalid and absent feature ids return 404 without an upstream call", async () => {
  const handler = createHandler(fixtureClient({ getFeature: async () => { throw Error("missing"); } }));
  equal((await handler(new Request("https://chromestatuslite.com/feature/not-a-number"))).status, 404);
  const missing = await handler(new Request("https://chromestatuslite.com/feature/456"));
  equal(missing.status, 404);
  includes(await missing.text(), "Feature not found");
});

Deno.test("feature detail linkifies URLs in summary, motivation, signals and notes", async () => {
  const client = fixtureClient({ getFeature: async () => ({
    id: 123, name: "Linked feature", summary: "See https://github.com/WebKit/WebKit/pull/70542.",
    motivation: "Filed as https://crbug.com/500967896 for details",
    wpt_descr: "Covered by https://wpt.fyi/results/abc",
    browsers: { chrome: { status: { text: "Enabled by default" } }, safari: { view: { text: "Support planned, tracked in https://bugs.webkit.org/123", notes: "Position: https://webkit.org/position/" } } },
    resources: { docs: [], samples: [] },
  }) });
  const html = await (await createHandler(client)(new Request("https://chromestatuslite.com/feature/123"))).text();
  includes(html, '<a href="https://github.com/WebKit/WebKit/pull/70542" rel="noopener noreferrer">https://github.com/WebKit/WebKit/pull/70542</a>.');
  includes(html, '<a href="https://crbug.com/500967896" rel="noopener noreferrer">https://crbug.com/500967896</a>');
  includes(html, '<a href="https://wpt.fyi/results/abc" rel="noopener noreferrer">');
  includes(html, '<a href="https://bugs.webkit.org/123" rel="noopener noreferrer">');
  includes(html, '<a href="https://webkit.org/position/" rel="noopener noreferrer">');
});

Deno.test("linkify keeps surrounding text escaped and ignores non-http schemes", async () => {
  const client = fixtureClient({ getFeature: async () => ({
    id: 124, name: "Unsafe feature",
    summary: "Evil <script>alert(1)</script> and ftp://example.com/x and javascript:alert(2)",
    resources: { docs: [], samples: [] },
  }) });
  const html = await (await createHandler(client)(new Request("https://chromestatuslite.com/feature/124"))).text();
  includes(html, "&lt;script&gt;alert(1)&lt;/script&gt;");
  equal(html.includes("javascript:alert(2)</a>"), false);
  equal(html.includes('href="ftp://example.com/x"'), false);
});

Deno.test("linkify links scheme-less tracker and PR references", async () => {
  const client = fixtureClient({ getFeature: async () => ({
    id: 125, name: "Bare references",
    motivation: "Spec PR github.com/whatwg/html/pull/123 and the bug crbug.com/500967896 (fixed).",
    browsers: { safari: { view: { text: "No signal", notes: "See bugzilla.mozilla.org/show_bug.cgi?id=1 and example.com/not-a-tracker" } } },
    resources: { docs: [], samples: [] },
  }) });
  const html = await (await createHandler(client)(new Request("https://chromestatuslite.com/feature/125"))).text();
  includes(html, '<a href="https://github.com/whatwg/html/pull/123" rel="noopener noreferrer">github.com/whatwg/html/pull/123</a>');
  includes(html, '<a href="https://crbug.com/500967896" rel="noopener noreferrer">crbug.com/500967896</a>');
  includes(html, '<a href="https://bugzilla.mozilla.org/show_bug.cgi?id=1" rel="noopener noreferrer">bugzilla.mozilla.org/show_bug.cgi?id=1</a>');
  // Unknown hosts stay plain text rather than becoming an arbitrary link.
  equal(html.includes('href="https://example.com/not-a-tracker"'), false);
  includes(html, "example.com/not-a-tracker");
});
