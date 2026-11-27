import { test } from "vitest";
import { createHandler } from "../src/handler.ts";
import { equal, fixtureClient, includes } from "./fixture.ts";

test("release page selects version and preserves canonical query", async () => {
  const calls: unknown[] = [];
  const handler = createHandler({
    client: fixtureClient({
      getFeaturesForVersion: async (version) => {
        calls.push(version);
        return {
          "Enabled by default": [
            {
              id: 123,
              name: "Fixture feature",
              summary: "Fixture summary",
              resources: { docs: [], samples: [] },
            },
          ],
        };
      },
    }),
  });
  const response = await handler(
    new Request("https://chromestatuslite.com/?version=112"),
  );
  equal(response.status, 200);
  equal(calls[0], "112");
  const html = await response.text();
  includes(
    html,
    '<link rel="canonical" href="https://chromestatuslite.com/?version=112">',
  );
  includes(
    html,
    '<a href="?version=112" class="current" aria-current="page">112</a>',
  );
  includes(html, "Fixture feature");
  includes(html, '<details class="more-versions"');
  includes(html, '<li><a href="/diff">Compare releases</a></li>');
  // Dead empty /scripts/index.js is gone: the home page ships zero <script> tags.
  equal(html.includes("<script"), false);
  equal(html.includes("</p></p>"), false);
});

test("release page links to chrome-platform-showcase.com for milestones >= 130", async () => {
  const handler = createHandler({
    client: fixtureClient({
      getVersions: async () => [140, 129],
    }),
  });
  const v140 = await (await handler(
    new Request("https://chromestatuslite.com/?version=140"),
  )).text();
  includes(v140, 'href="https://chrome-platform-showcase.com/v140/"');

  const v129 = await (await handler(
    new Request("https://chromestatuslite.com/?version=129"),
  )).text();
  equal(v129.includes("chrome-platform-showcase.com/v129"), false);
});

test("release notes expose available metadata without fetching full records", async () => {
  let detailCalls = 0;
  const listItem = {
    id: 123,
    name: "Important change",
    summary: "Summary",
    resources: { docs: [], samples: [] },
    breaking_change: true,
    enterprise_impact: 4,
    standards: { maturity: { short_text: "Working draft" } },
  };
  const client = fixtureClient({
    getFeaturesForVersion: async () => ({ "Enabled by default": [listItem] }),
    getFeature: async () => {
      detailCalls++;
      throw Error("unexpected detail fetch");
    },
  });
  const html = await (await createHandler({ client })(
    new Request("https://chromestatuslite.com/"),
  )).text();
  includes(html, "Breaking change:</strong> Yes");
  includes(html, "Enterprise impact:</strong> High");
  includes(html, "Spec maturity:</strong> Working draft");
  equal(detailCalls, 0);
});

test("release notes escape optional metadata and hide unavailable fields", async () => {
  const client = fixtureClient({
    getFeaturesForVersion: async () => ({
      "Enabled by default": [
        {
          id: 123,
          name: "Optional",
          summary: "Summary",
          resources: { docs: [], samples: [] },
          breaking_change: false,
          enterprise_impact: 1,
          flag_name: "<script>alert(1)</script>",
          wpt: false,
        },
      ],
    }),
  });
  const html = await (await createHandler({ client })(
    new Request("https://chromestatuslite.com/"),
  )).text();
  includes(html, "Chromium flag:</strong> &lt;script&gt;alert(1)&lt;/script&gt;");
  includes(html, "Web Platform Tests:</strong> No");
  equal(html.includes("Breaking change:</strong>"), false);
  equal(html.includes("Enterprise impact:</strong>"), false);
});

test("release page defaults to latest fixture milestone", async () => {
  const html = await (await createHandler({ client: fixtureClient() })(
    new Request("https://chromestatuslite.com/"),
  )).text();
  includes(html, "Chrome Release 120");
});

test("release page linkifies URLs in feature summaries and keeps valid HTML structure", async () => {
  const client = fixtureClient({
    getFeaturesForVersion: async () => ({
      "Enabled by default": [
        {
          id: 9,
          name: "Summarised",
          summary: "Spec: https://example.com/spec.html.",
          motivation: "See crbug.com/999 for context.",
          resources: {
            docs: ["https://example.com/a", "https://example.com/b"],
            samples: [],
          },
        },
      ],
    }),
  });
  const html = await (await createHandler({ client })(
    new Request("https://chromestatuslite.com/"),
  )).text();
  includes(
    html,
    '<a href="https://example.com/spec.html" rel="noopener noreferrer">https://example.com/spec.html</a>.',
  );
  includes(
    html,
    '<a href="https://crbug.com/999" rel="noopener noreferrer">crbug.com/999</a>',
  );
  // Valid HTML: blockquote is not nested inside <p>, and resources have no double </p></p>.
  equal(html.includes("<blockquote>") && html.includes("</blockquote></p>"), false);
  equal(html.includes("</p></p>"), false);
  includes(
    html,
    '<a href="https://example.com/a">https://example.com/a</a> <a href="https://example.com/b">https://example.com/b</a>',
  );
});

test("release page never reflects an unlisted ?version= into the page or the upstream query", async () => {
  const calls: unknown[] = [];
  const handler = createHandler({
    client: fixtureClient({
      getFeaturesForVersion: async (version) => {
        calls.push(version);
        return { "Enabled by default": [] };
      },
    }),
  });
  const response = await handler(
    new Request(
      "https://chromestatuslite.com/?version=%3Cscript%3Ealert(document.domain)%3C/script%3E",
    ),
  );
  equal(response.status, 200);
  const html = await response.text();
  equal(calls[0], "120");
  includes(html, "<title>Chrome Release 120</title>");
  const body = html.slice(html.indexOf("<body>"));
  equal(body.includes("alert(document.domain)"), false);
  equal(body.includes("<script"), false);
  includes(body, "<h1>Chrome 120</h1>");
});

test("release page escapes the selected version at every HTML sink even when whitelisted", async () => {
  const evil = "<script>alert(1)</script>";
  const client = fixtureClient({
    getVersions: async () => [120, evil] as unknown as number[],
    getFeaturesForVersion: async () => ({
      "Enabled by default": [
        {
          id: 1,
          name: "X",
          summary: "Y",
          resources: { docs: [], samples: [] },
        },
      ],
    }),
  });
  const response = await createHandler({ client })(
    new Request(
      `https://chromestatuslite.com/?version=${encodeURIComponent(evil)}`,
    ),
  );
  const html = await response.text();
  equal(html.includes("<script>alert(1)</script>"), false);
  includes(
    html,
    "<title>Chrome Release &lt;script&gt;alert(1)&lt;/script&gt;</title>",
  );
  includes(html, "<h1>Chrome &lt;script&gt;alert(1)&lt;/script&gt;</h1>");
  includes(
    html,
    "Enabled by default in &lt;script&gt;alert(1)&lt;/script&gt;</h2>",
  );
  includes(
    html,
    '<a href="?version=%3Cscript%3Ealert(1)%3C%2Fscript%3E" class="current" aria-current="page">&lt;script&gt;alert(1)&lt;/script&gt;</a>',
  );
  includes(html, '<a href="?version=120">120</a>');
});

test("release page upstream urls cannot break out of their href attributes", async () => {
  const evil = 'https://example.com/x" onmouseover="alert(1)';
  const client = fixtureClient({
    getFeaturesForVersion: async () => ({
      "Enabled by default": [
        {
          id: 202,
          name: "Evil links",
          summary: "Summary",
          resources: { docs: [evil], samples: [evil] },
          browsers: { chrome: { bug: evil } },
          standards: { spec: evil },
        },
      ],
    }),
  });
  const html = await (await createHandler({ client })(
    new Request("https://chromestatuslite.com/?version=120"),
  )).text();
  equal(html.includes('onmouseover="'), false);
  includes(html, 'href="https://example.com/x%22%20onmouseover=%22alert(1)"');
  equal(html.includes("&quot;"), false);
});

test("release page drops non-http(s) hrefs in resources, bug and spec fields", async () => {
  const evil = [
    "javascript:alert(document.domain)",
    "data:text/html,<script>alert(1)</script>",
  ];
  for (const url of evil) {
    const client = fixtureClient({
      getFeaturesForVersion: async () => ({
        "Enabled by default": [
          {
            id: 203,
            name: "Scheme attack",
            summary: "Summary",
            resources: { docs: [url], samples: [url] },
            browsers: { chrome: { bug: url } },
            standards: { spec: url },
          },
        ],
      }),
    });
    const html = await (await createHandler({ client })(
      new Request("https://chromestatuslite.com/?version=120"),
    )).text();
    equal(html.includes('href="javascript:'), false);
    equal(html.includes('href="data:'), false);
    equal(html.includes(url), false);
  }
});

test("release page drops the Docs/Samples label when every link is filtered out", async () => {
  const client = fixtureClient({
    getFeaturesForVersion: async () => ({
      "Enabled by default": [
        {
          id: 205,
          name: "All filtered",
          summary: "Summary",
          resources: {
            docs: ["javascript:alert(1)"],
            samples: ["javascript:alert(1)"],
          },
        },
      ],
    }),
  });
  const html = await (await createHandler({ client })(
    new Request("https://chromestatuslite.com/?version=120"),
  )).text();
  equal(html.includes("Docs:"), false);
  equal(html.includes("Samples:"), false);
});

test("release page keeps http(s) hrefs in resources, bug and spec fields", async () => {
  const url = "https://example.com/tracking";
  const client = fixtureClient({
    getFeaturesForVersion: async () => ({
      "Enabled by default": [
        {
          id: 204,
          name: "Honest links",
          summary: "Summary",
          resources: { docs: [url], samples: [url] },
          browsers: { chrome: { bug: url } },
          standards: { spec: url },
        },
      ],
    }),
  });
  const html = await (await createHandler({ client })(
    new Request("https://chromestatuslite.com/?version=120"),
  )).text();
  includes(html, `<a href="${url}">${url}</a>`);
  includes(html, `<a href="${url}">#</a>`);
  includes(html, `<a href="${url}">in this Spec</a>`);
});
