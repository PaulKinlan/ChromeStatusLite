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
