import template from "../flora.ts";
import type { StatusClient } from "../handler.ts";
import { escapeHtml } from "https://deno.land/x/escape_html/mod.ts";

import nav from "../ui-components/nav.ts";
import { WIKI_TOPICS } from "../lib/wiki.ts";
import { getTopicData } from "../lib/wiki-data.ts";

// The topic directory. Counts come from getTopicData — the same deduped
// union across ALL of a topic's queries that the topic page renders — so a
// directory count always matches its topic page. Assembled topic data is
// cached per client and shared with the topic pages, so warm loads make no
// upstream requests at all. Each failure is isolated: a topic whose queries
// all fail renders without a count rather than taking down the directory.
const renderTopicCard = (topic, chromeStatusAPI: StatusClient) => template`
  <article class="wiki-topic">
    <h2><a href="/wiki/${escapeHtml(topic.slug)}">${escapeHtml(topic.title)}</a></h2>
    <p>${escapeHtml(topic.description)}</p>
    ${getTopicData(topic, chromeStatusAPI).then((data) =>
      data.failed
        ? template``
        // A partial inventory renders as a lower-bound count ("2+") rather
        // than a silently wrong exact count; the topic page carries the full
        // incompleteness notice (un2).
        : template`<p><a href="/wiki/${escapeHtml(topic.slug)}">${data.features.length}${data.complete ? "" : "+"} feature${data.features.length === 1 && data.complete ? "" : "s"}</a></p>`
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
