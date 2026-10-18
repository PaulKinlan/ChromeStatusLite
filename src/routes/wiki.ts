import template from "../flora.ts";
import type { StatusClient } from "../handler.ts";
import { escapeHtml } from "https://deno.land/x/escape_html/mod.ts";

import nav from "../ui-components/nav.ts";
import { WIKI_TOPICS, collectTopicFeatures } from "../lib/wiki.ts";

// The topic directory. Counts are fetched per topic in parallel and each
// failure is isolated: a topic whose queries fail renders without a count
// rather than taking down the directory.
const countFeatures = async (topic, chromeStatusAPI: StatusClient): Promise<number | undefined> => {
  const results = await Promise.all(
    topic.queries.map((query) => chromeStatusAPI.getFeaturesByQuery(query).catch(() => null)),
  );
  if (results.every((result) => result === null)) return undefined;
  return collectTopicFeatures(results.filter((result) => result !== null)).length;
};

const renderTopicCard = (topic, chromeStatusAPI: StatusClient) => template`
  <article class="wiki-topic">
    <h2><a href="/wiki/${escapeHtml(topic.slug)}">${escapeHtml(topic.title)}</a></h2>
    <p>${escapeHtml(topic.description)}</p>
    ${countFeatures(topic, chromeStatusAPI).then((count) =>
      count === undefined
        ? template``
        : template`<p><a href="/wiki/${escapeHtml(topic.slug)}">${count} features</a></p>`
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
