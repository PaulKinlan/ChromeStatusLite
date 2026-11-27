import { test } from "vitest";
import { createHandler } from "../src/handler.ts";
import { equal, fixtureClient, includes } from "./fixture.ts";

test("every HTML page shell declares lang=en, charset=utf-8, favicon, RSS autodiscovery and Speculation-Rules", async () => {
  const handler = createHandler({ client: fixtureClient() });
  const htmlRoutes = [
    "/",
    "/deprecations",
    "/feature/123",
    "/feature/123/history",
    "/breaking",
    "/origin-trials",
    "/diff",
  ];
  for (const path of htmlRoutes) {
    const res = await handler(
      new Request(`https://chromestatuslite.com${path}`),
    );
    equal(res.status, 200);
    equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await res.text();
    includes(html, '<html lang="en">');
    includes(html, '<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
    includes(
      html,
      '<link rel="alternate" type="application/rss+xml" title="Chrome Status Lite" href="/feed.xml">',
    );
    equal(html.includes("<script"), false, `${path}: ships zero <script> tags`);
    if (path !== "/feature/123/history") {
      equal(
        res.headers.get("speculation-rules"),
        '"/speculation-rules.json"',
        `${path}: advertises Speculation-Rules header`,
      );
    }
  }
  const wiki = await handler(new Request("https://chromestatuslite.com/wiki"));
  const wikiHtml = await wiki.text();
  includes(wikiHtml, '<html lang="en">');
  const topic = wikiHtml.match(/href="\/wiki\/([a-z0-9-]+)"/);
  if (!topic) throw new Error("wiki directory listed no topic to probe");
  const topicRes = await handler(
    new Request(`https://chromestatuslite.com/wiki/${topic[1]}`),
  );
  equal(topicRes.status, 200);
  includes(await topicRes.text(), '<html lang="en">');
});

test("every page has one main landmark and a first-of-body skip link (chrome-status-lite-c8t)", async () => {
  const handler = createHandler({ client: fixtureClient() });
  const htmlRoutes = [
    "/",
    "/deprecations",
    "/feature/123",
    "/feature/123/history",
    "/breaking",
    "/origin-trials",
    "/diff",
  ];
  for (const path of htmlRoutes) {
    const res = await handler(
      new Request(`https://chromestatuslite.com${path}`),
    );
    equal(res.status, 200);
    const html = await res.text();
    includes(html, '<main id="main">');
    equal(html.split("<main").length - 1, 1, `${path}: exactly one <main>`);
    includes(
      html.slice(html.indexOf("<body>"), html.indexOf("<nav>")),
      '<a class="skip" href="#main">Skip to content</a>',
      `${path}: skip link first in body`,
    );
  }
  const wiki = await handler(new Request("https://chromestatuslite.com/wiki"));
  const wikiHtml = await wiki.text();
  includes(wikiHtml, '<main id="main">');
  const topic = wikiHtml.match(/href="\/wiki\/([a-z0-9-]+)"/);
  if (!topic) throw new Error("wiki directory listed no topic to probe");
  const topicRes = await handler(
    new Request(`https://chromestatuslite.com/wiki/${topic[1]}`),
  );
  const topicHtml = await topicRes.text();
  includes(topicHtml, '<main id="main">');
  equal(
    topicHtml.split("<main").length - 1,
    1,
    "wiki topic: exactly one <main>",
  );
});

test("every page has exactly one h1 (chrome-status-lite-axi)", async () => {
  const handler = createHandler({ client: fixtureClient() });
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
    const res = await handler(
      new Request(`https://chromestatuslite.com${path}`),
    );
    const html = await res.text();
    equal(
      (html.match(/<h1[ >]/g) || []).length,
      1,
      `${path}: exactly one h1`,
    );
  }
  const wiki = await handler(new Request("https://chromestatuslite.com/wiki"));
  const wikiHtml = await wiki.text();
  equal(
    (wikiHtml.match(/<h1[ >]/g) || []).length,
    1,
    "/wiki: exactly one h1",
  );
  const topic = wikiHtml.match(/href="\/wiki\/([a-z0-9-]+)"/);
  if (!topic) throw new Error("wiki directory listed no topic to probe");
  const topicRes = await handler(
    new Request(`https://chromestatuslite.com/wiki/${topic[1]}`),
  );
  const topicHtml = await topicRes.text();
  equal(
    (topicHtml.match(/<h1[ >]/g) || []).length,
    1,
    "wiki topic: exactly one h1",
  );
});

test("the collapsed nav ships its popover wiring server-side (chrome-status-lite-nc9)", async () => {
  const handler = createHandler({ client: fixtureClient() });
  const paths = [
    "/",
    "/diff",
    "/breaking",
    "/origin-trials",
    "/deprecations",
    "/wiki",
    "/feature/123",
  ];
  for (const path of paths) {
    const html = await (await handler(
      new Request(`https://chromestatuslite.com${path}`),
    )).text();
    includes(
      html,
      '<button class="menu-button" type="button" popovertarget="site-menu" aria-controls="site-menu">Menu</button>',
      `${path}: menu button controls the link list`,
    );
    includes(
      html,
      '<ul id="site-menu" class="site-menu" popover="auto">',
      `${path}: link list is a popover`,
    );
    equal(html.includes('role="menu"'), false, `${path}: no menu role`);
  }
});

test("primary nav marks the current section with aria-current (chrome-status-lite-whe)", async () => {
  const handler = createHandler({ client: fixtureClient() });
  const marked = (html: string, href: string): boolean =>
    html.includes(`<a href="${href}" class="current" aria-current="page">`);
  const NAV_HREFS = [
    "/",
    "/diff",
    "/breaking",
    "/origin-trials",
    "/deprecations",
    "/wiki",
  ];
  const cases: Array<[string, string | null]> = [
    ["/", "/"],
    ["/?version=118", "/"],
    ["/breaking", "/breaking"],
    ["/origin-trials", "/origin-trials"],
    ["/deprecations", "/deprecations"],
    ["/diff", "/diff"],
    ["/feature/123", null],
    ["/feature/123/history", null],
  ];
  for (const [path, expected] of cases) {
    const res = await handler(
      new Request(`https://chromestatuslite.com${path}`),
    );
    const html = await res.text();
    for (const href of NAV_HREFS) {
      equal(
        marked(html, href),
        href === expected,
        `${path}: marker on ${href}`,
      );
    }
  }
  const wiki = await handler(new Request("https://chromestatuslite.com/wiki"));
  const wikiHtml = await wiki.text();
  equal(marked(wikiHtml, "/wiki"), true, "/wiki marks Topic Wiki");
  const topic = wikiHtml.match(/href="\/wiki\/([a-z0-9-]+)"/);
  if (!topic) throw new Error("wiki directory listed no topic to probe");
  const topicRes = await handler(
    new Request(`https://chromestatuslite.com/wiki/${topic[1]}`),
  );
  equal(
    marked(await topicRes.text(), "/wiki"),
    true,
    "wiki topic marks Topic Wiki",
  );
});

test("the home page keeps exactly one h1 when upstream fails (chrome-status-lite-7uj)", async () => {
  const handler = createHandler({
    client: fixtureClient({
      getFeaturesForVersion: async () => {
        throw new Error("offline");
      },
    }),
  });
  for (const path of ["/", "/?version=120"]) {
    const res = await handler(
      new Request(`https://chromestatuslite.com${path}`),
    );
    equal(res.headers.get("cache-control"), "no-store");
    const html = await res.text();
    equal(
      (html.match(/<h1[ >]/g) || []).length,
      1,
      `${path} (upstream down): exactly one h1`,
    );
    includes(html, "Unable to load release data");
  }
  const dead = createHandler({
    client: fixtureClient({
      getVersions: () => {
        throw new Error("offline");
      },
    }),
  });
  const res = await dead(new Request("https://chromestatuslite.com/"));
  const html = await res.text();
  equal(
    (html.match(/<h1[ >]/g) || []).length,
    1,
    "version-list outage: exactly one h1",
  );
  includes(html, "Chrome release unavailable");
});
