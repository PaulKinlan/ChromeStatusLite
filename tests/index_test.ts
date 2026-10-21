import { createHandler } from "../src/handler.ts";
import { equal, fixtureClient, includes } from "./fixture.ts";

Deno.test("release page selects version and preserves canonical query", async () => {
  const calls: unknown[] = [];
  const handler = createHandler(fixtureClient({ getFeaturesForVersion: async (version) => {
    calls.push(version);
    return { "Enabled by default": [{ id: 123, name: "Fixture feature", summary: "Fixture summary", resources: { docs: [], samples: [] } }] };
  } }));
  const response = await handler(new Request("https://chromestatuslite.com/?version=112"));
  equal(response.status, 200);
  equal(calls[0], "112");
  const html = await response.text();
  includes(html, '<link rel="canonical" href="https://chromestatuslite.com/?version=112">');
  includes(html, '<a href="?version=112" class="current" aria-current="page">112</a>');
  includes(html, "Fixture feature");
  includes(html, '<details class="more-versions"');
  // The shared nav renders on every page; pin the comparison entry here too so
  // removing it from src/ui-components/nav.ts cannot pass silently (8gx).
  includes(html, '<li><a href="/diff">Compare releases</a></li>');
});

Deno.test("release notes expose available metadata without fetching full records", async () => {
  let detailCalls = 0;
  const listItem = {
    id: 123, name: "Important change", summary: "Summary", resources: { docs: [], samples: [] },
    breaking_change: true, enterprise_impact: 4,
    standards: { maturity: { short_text: "Working draft" } },
  };
  const client = fixtureClient({
    getFeaturesForVersion: async () => ({ "Enabled by default": [listItem] }),
    getFeature: async () => { detailCalls++; throw Error("unexpected detail fetch"); },
  });
  const html = await (await createHandler(client)(new Request("https://chromestatuslite.com/"))).text();
  includes(html, "Breaking change:</strong> Yes");
  includes(html, "Enterprise impact:</strong> High");
  includes(html, "Spec maturity:</strong> Working draft");
  equal(detailCalls, 0);
});

Deno.test("release notes escape optional metadata and hide unavailable fields", async () => {
  const client = fixtureClient({ getFeaturesForVersion: async () => ({ "Enabled by default": [{
    id: 123, name: "Optional", summary: "Summary", resources: { docs: [], samples: [] },
    breaking_change: false, enterprise_impact: 1, flag_name: '<script>alert(1)</script>',
    wpt: false,
  }] }) });
  const html = await (await createHandler(client)(new Request("https://chromestatuslite.com/"))).text();
  includes(html, "Chromium flag:</strong> &lt;script&gt;alert(1)&lt;/script&gt;");
  includes(html, "Web Platform Tests:</strong> No");
  equal(html.includes("Breaking change:</strong>"), false);
  equal(html.includes("Enterprise impact:</strong>"), false);
});

Deno.test("release page defaults to latest fixture milestone", async () => {
  const html = await (await createHandler(fixtureClient())(new Request("https://chromestatuslite.com/"))).text();
  includes(html, "Chrome Release 120");
});

Deno.test("release page linkifies URLs in feature summaries", async () => {
  const client = fixtureClient({ getFeaturesForVersion: async () => ({
    "Enabled by default": [{ id: 9, name: "Summarised", summary: "Spec: https://example.com/spec.html." }],
  }) });
  const html = await (await createHandler(client)(new Request("https://chromestatuslite.com/"))).text();
  includes(html, '<a href="https://example.com/spec.html" rel="noopener noreferrer">https://example.com/spec.html</a>.');
});

Deno.test("release page never reflects an unlisted ?version= into the page or the upstream query", async () => {
  const calls: unknown[] = [];
  const handler = createHandler(fixtureClient({ getFeaturesForVersion: async (version) => {
    calls.push(version);
    return { "Enabled by default": [] };
  } }));
  const response = await handler(
    new Request("https://chromestatuslite.com/?version=%3Cscript%3Ealert(document.domain)%3C/script%3E"),
  );
  equal(response.status, 200);
  const html = await response.text();
  // Unlisted input falls back to the latest known milestone everywhere:
  // title, h1, section headings and the upstream query.
  equal(calls[0], "120");
  includes(html, "<title>Chrome Release 120</title>");
  const body = html.slice(html.indexOf("<body>"));
  equal(body.includes("alert(document.domain)"), false);
  equal(body.includes("<script"), false);
  includes(body, "<h1>Chrome 120</h1>");
});

Deno.test("release page escapes the selected version at every HTML sink even when whitelisted", async () => {
  const evil = '<script>alert(1)</script>';
  const client = fixtureClient({
    getVersions: async () => [120, evil],
    getFeaturesForVersion: async () => ({
      "Enabled by default": [{ id: 1, name: "X", summary: "Y", resources: { docs: [], samples: [] } }],
    }),
  });
  const response = await createHandler(client)(
    new Request(`https://chromestatuslite.com/?version=${encodeURIComponent(evil)}`),
  );
  const html = await response.text();
  equal(html.includes("<script>alert(1)</script>"), false);
  includes(html, "<title>Chrome Release &lt;script&gt;alert(1)&lt;/script&gt;</title>");
  includes(html, "<h1>Chrome &lt;script&gt;alert(1)&lt;/script&gt;</h1>");
  includes(html, "Enabled by default in &lt;script&gt;alert(1)&lt;/script&gt;</h2>");
  // Version chips survive upstream-supplied markup: the selected (evil) chip
  // is fully encoded in its href and escaped in its label.
  includes(html, '<a href="?version=%3Cscript%3Ealert(1)%3C%2Fscript%3E" class="current" aria-current="page">&lt;script&gt;alert(1)&lt;/script&gt;</a>');
  includes(html, '<a href="?version=120">120</a>');
});

Deno.test("release page upstream urls cannot break out of their href attributes", async () => {
  const evil = 'https://example.com/x" onmouseover="alert(1)';
  const client = fixtureClient({ getFeaturesForVersion: async () => ({
    "Enabled by default": [{
      id: 202, name: "Evil links", summary: "Summary",
      resources: { docs: [evil], samples: [evil] },
      browsers: { chrome: { bug: evil } }, standards: { spec: evil },
    }],
  }) });
  const html = await (await createHandler(client)(new Request("https://chromestatuslite.com/?version=120"))).text();
  equal(html.includes('onmouseover="'), false);
  includes(html, "&quot; onmouseover=&quot;alert(1)");
});
