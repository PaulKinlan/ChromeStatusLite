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

Deno.test("a view with a url does not nest anchors around its text", async () => {
  const client = fixtureClient({ getFeature: async () => ({
    id: 127, name: "Nested anchor guard", summary: "Summary",
    browsers: { safari: { view: {
      text: "Positive, see https://webkit.org/position/1",
      url: "https://webkit.org/standards-positions/1",
      notes: "Discussed in https://github.com/WebKit/standards-positions/issues/1",
    } } },
    resources: { docs: [], samples: [] },
  }) });
  const html = await (await createHandler(client)(new Request("https://chromestatuslite.com/feature/127"))).text();
  // The url branch keeps its text plain: no anchor inside the outer anchor.
  includes(html, '<a href="https://webkit.org/standards-positions/1">Positive, see https://webkit.org/position/1</a>');
  equal(html.includes('href="https://webkit.org/position/1"'), false);
  // Notes remain free text, so they are still linkified.
  includes(html, '<a href="https://github.com/WebKit/standards-positions/issues/1" rel="noopener noreferrer">');
  // No anchor anywhere opens inside another.
  equal(/<a\b[^>]*>[^<]*<a\b/.test(html), false);
});

Deno.test("a view without a url still linkifies its text", async () => {
  const client = fixtureClient({ getFeature: async () => ({
    id: 128, name: "Free-text view", summary: "Summary",
    browsers: { ff: { view: { text: "No signal, tracked at https://bugzilla.mozilla.org/1" } } },
    resources: { docs: [], samples: [] },
  }) });
  const html = await (await createHandler(client)(new Request("https://chromestatuslite.com/feature/128"))).text();
  includes(html, '<a href="https://bugzilla.mozilla.org/1" rel="noopener noreferrer">https://bugzilla.mozilla.org/1</a>');
});

Deno.test("upstream urls cannot break out of their href attributes", async () => {
  const evil = 'https://example.com/x" onmouseover="alert(1)';
  const client = fixtureClient({ getFeature: async () => ({
    id: 129, name: "Hostile urls", summary: "Summary",
    spec_link: evil, bug_url: evil,
    browsers: { safari: { view: { text: "Position", url: evil } } },
    resources: { docs: [evil], samples: [evil] },
    explainer_links: [evil],
  }) });
  const html = await (await createHandler(client)(new Request("https://chromestatuslite.com/feature/129"))).text();
  // A raw quote inside the attribute would start a new attribute; the escaped
  // form keeps the whole value inside the quoted href.
  equal(html.includes('onmouseover="'), false);
  includes(html, "&quot; onmouseover=&quot;alert(1)");
});

Deno.test("feature detail renders ecosystem cross-links from the feature name", async () => {
  const client = fixtureClient({ getFeature: async () => ({
    id: 123, name: "View Transitions", summary: "A fixture summary",
    wpt_descr: "Covered by css/view-transitions/*.html",
    resources: { docs: [], samples: [] },
  }) });
  const html = await (await createHandler(client)(new Request("https://chromestatuslite.com/feature/123"))).text();
  includes(html, 'href="https://wpt.fyi/results/?q=css%2Fview-transitions"');
  includes(html, 'href="https://chrome-platform-showcase.paulkinlan-ea.deno.net/features"');
  includes(html, 'href="https://gendn.paulkinlan-ea.deno.net/features"');
  includes(html, 'href="https://www.google.com/search?q=site%3Achrome.dev+View%20Transitions"');
  includes(html, 'href="https://developer.mozilla.org/en-US/search?q=View%20Transitions"');
  includes(html, 'href="https://webstatus.dev/?q=View%20Transitions"');
  equal((html.match(/rel="noopener noreferrer"/g) || []).length >= 6, true);
});

Deno.test("feature detail omits the ecosystem section when the feature has no name", async () => {
  const client = fixtureClient({ getFeature: async () => ({
    id: 124, name: "", summary: "Anonymous",
    resources: { docs: [], samples: [] },
  }) });
  const html = await (await createHandler(client)(new Request("https://chromestatuslite.com/feature/124"))).text();
  equal(html.includes("<h2>Ecosystem</h2>"), false);
  equal(html.includes("wpt.fyi/results/?q="), false);
});

Deno.test("ecosystem WPT link prefers the feature's real WPT path over the name slug", async () => {
  const client = fixtureClient({ getFeature: async () => ({
    id: 125, name: "Element.scrollIntoView()", summary: "Scrolling",
    wpt_descr: "css/cssom-view/scrollIntoView-*.html",
    resources: { docs: [], samples: [] },
  }) });
  const html = await (await createHandler(client)(new Request("https://chromestatuslite.com/feature/125"))).text();
  includes(html, 'href="https://wpt.fyi/results/?q=css%2Fcssom-view%2FscrollIntoView"');
  equal(html.includes("q=element-scrollintoview"), false);
});

Deno.test("a malformed percent escape in wpt_descr cannot 500 the feature page", async () => {
  const client = fixtureClient({ getFeature: async () => ({
    id: 126, name: "Malformed percent", summary: "s",
    wpt_descr: "see https://x.test/?q=50%",
    resources: { docs: [], samples: [] },
  }) });
  const res = await createHandler(client)(new Request("https://chromestatuslite.com/feature/126"));
  equal(res.status, 200);
  const text = await res.text();
  includes(text, "wpt.fyi/results/?q=50%25");
});

Deno.test("an encoded script in the wpt q= param is re-encoded in href and escaped in text", async () => {
  const client = fixtureClient({ getFeature: async () => ({
    id: 127, name: "Hostile q", summary: "s",
    wpt_descr: "https://wpt.fyi/results/?q=test%3Cscript%3Ealert(1)%3C/script%3E",
    resources: { docs: [], samples: [] },
  }) });
  const res = await createHandler(client)(new Request("https://chromestatuslite.com/feature/127"));
  equal(res.status, 200);
  const text = await res.text();
  // No decoded markup anywhere; the anchor renders the percent-encoded form.
  equal(text.includes("<script>alert(1)</script>"), false);
  includes(text, 'q=test%3Cscript%3Ealert(1)%3C%2Fscript%3E" rel="noopener');
  includes(text, '_blank">https://wpt.fyi/results/?q=test%3Cscript%3Ealert(1)');
});
