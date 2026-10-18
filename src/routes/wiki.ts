import template from "../flora.ts";
import type { StatusClient } from "../handler.ts";
import { escapeHtml } from "https://deno.land/x/escape_html/mod.ts";

import nav from "../ui-components/nav.ts";
import { WIKI_TOPICS } from "../lib/wiki.ts";

// The topic directory. Counts come from a single num=1 request per topic
// (the primary query): the response carries the exact total_count without
// the feature payload, so a cold directory load is ~15 tiny requests rather
// than ~20 full result pages. Each failure is isolated: a topic whose count
// request fails renders without a count rather than taking down the
// directory. The precise merged count across all of a topic's queries lives
// on the topic page itself.
const countFeatures = async (topic, chromeStatusAPI: StatusClient): Promise<number | undefined> => {
  const result = await chromeStatusAPI
    .getFeaturesByQuery(topic.queries[0], { num: 1 })
    .catch(() => null);
  const total = Number(result?.total_count);
  return Number.isFinite(total) ? total : undefined;
};

const renderTopicCard = (topic, chromeStatusAPI: StatusClient) => template`
  <article class="wiki-topic">
    <h2><a href="/wiki/${escapeHtml(topic.slug)}">${escapeHtml(topic.title)}</a></h2>
    <p>${escapeHtml(topic.description)}</p>
    ${countFeatures(topic, chromeStatusAPI).then((count) =>
      count === undefined
        ? template``
        : template`<p><a href="/wiki/${escapeHtml(topic.slug)}">${count} feature${count === 1 ? "" : "s"}</a></p>`
    )}
  </article>`;

export default async function render(request: Request, chromeStatusAPI: StatusClient): Promise<Response> {
  const url = new URL(request.url);
  return template`
  <!doctype html>
<html>

<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Web Platform Topic Wiki</title>
  <link rel="canonical" href="https://chromestatuslite.com${escapeHtml(url.pathname + url.search)}">
  <link rel="stylesheet" href="/styles/index.css">
</head>

<body>
  ${nav()}
  <h1>Web Platform Topic Wiki</h1>
  <p>Persistent topic pages grouping related Chrome Platform Status features: active stages,
     cross-browser consensus, and shipping timelines. Tags are assigned by a deterministic
     keyword pipeline and re-resolved from live chromestatus.com data on every visit.</p>
  <div id="output" class="wiki-directory">
    ${WIKI_TOPICS.map((topic) => renderTopicCard(topic, chromeStatusAPI))}
  </div>
</body>

</html>`.then(
    (data) =>
      new Response(data, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
  );
}
