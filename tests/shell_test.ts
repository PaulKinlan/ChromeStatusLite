import { createHandler } from "../src/handler.ts";
import { equal, fixtureClient, includes } from "./fixture.ts";

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

Deno.test("primary nav marks the current section with aria-current (chrome-status-lite-whe)", async () => {
  // WCAG 1.3.1: the "you are here" cue must be visual AND programmatic. The
  // marker markup mirrors the version chips' pattern: authored as static
  // template markup, class="current" + aria-current="page" on exactly one link.
  const handler = createHandler(fixtureClient());
  const marked = (html: string, href: string): boolean =>
    html.includes(`<a href="${href}" class="current" aria-current="page">`);
  const NAV_HREFS = ["/", "/diff", "/breaking", "/origin-trials", "/deprecations", "/wiki"];
  const cases: Array<[string, string | null]> = [
    ["/", "/"],
    ["/?version=118", "/"],
    ["/breaking", "/breaking"],
    ["/origin-trials", "/origin-trials"],
    ["/deprecations", "/deprecations"],
    ["/diff", "/diff"],
    ["/feature/123", null], // deep page: no nav link matches, nothing marked
    ["/feature/123/history", null],
  ];
  for (const [path, expected] of cases) {
    const res = await handler(new Request(`https://chromestatuslite.com${path}`));
    const html = await res.text();
    for (const href of NAV_HREFS) {
      equal(marked(html, href), href === expected, `${path}: marker on ${href}`);
    }
  }
  // Wiki prefix rule: directory and topic page both mark Topic Wiki.
  const wiki = await handler(new Request("https://chromestatuslite.com/wiki"));
  const wikiHtml = await wiki.text();
  equal(marked(wikiHtml, "/wiki"), true, "/wiki marks Topic Wiki");
  const topic = wikiHtml.match(/href="\/wiki\/([a-z0-9-]+)"/);
  if (!topic) throw new Error("wiki directory listed no topic to probe");
  const topicRes = await handler(new Request(`https://chromestatuslite.com/wiki/${topic[1]}`));
  equal(marked(await topicRes.text(), "/wiki"), true, "wiki topic marks Topic Wiki");
});

Deno.test("the home page keeps exactly one h1 when upstream fails (chrome-status-lite-7uj)", async () => {
  // The shell h1 used to guarantee a heading on error views; after the axi
  // demotion the only h1 lives in the success fragment, so the error branch
  // carries its own. Both failure shapes are pinned: a feature fetch failing
  // with a known version, and a total version-list outage (version = "").
  const handler = createHandler(fixtureClient({
    getFeaturesForVersion: async () => {
      throw new Error("offline");
    },
  }));
  for (const path of ["/", "/?version=120"]) {
    const res = await handler(new Request(`https://chromestatuslite.com${path}`));
    const html = await res.text();
    equal((html.match(/<h1[ >]/g) || []).length, 1, `${path} (upstream down): exactly one h1`);
    includes(html, "Unable to load release data");
  }
  const dead = createHandler(fixtureClient({
    getVersions: () => {
      throw new Error("offline");
    },
  }));
  const res = await dead(new Request("https://chromestatuslite.com/"));
  const html = await res.text();
  equal((html.match(/<h1[ >]/g) || []).length, 1, "version-list outage: exactly one h1");
  includes(html, "Chrome release unavailable");
});

