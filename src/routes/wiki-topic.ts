import template from "../flora.ts";
import type { StatusClient } from "../handler.ts";
import { escapeHtml } from "https://deno.land/x/escape_html/mod.ts";

import nav from "../ui-components/nav.ts";
import {
  collectTopicFeatures,
  consensus,
  getTopic,
  stageGroups,
  tagFeature,
  timeline,
} from "../lib/wiki.ts";

const renderNotFound = (slug: string, canonical: string) =>
  template`
  <!doctype html>
<html>

<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Topic not found</title>
  <link rel="canonical" href="${canonical}">
  <link rel="stylesheet" href="/styles/index.css">
</head>

<body>
  ${nav()}
  <h1>Topic not found</h1>
  <p>No wiki topic <code>${escapeHtml(slug)}</code> exists. Browse the
     <a href="/wiki">topic directory</a>.</p>
</body>

</html>`.then(
    (data) =>
      new Response(data, {
        status: 404,
        headers: { "content-type": "text/html" },
      })
  );

const renderFeature = (feature, crossTags: string[]) => {
  const id = encodeURIComponent(String(feature.id));
  const name = escapeHtml(feature.name || "Unnamed feature");
  const summary = escapeHtml(feature.summary || "");
  return template`
    <article class="wiki-feature">
      <h3><a href="/feature/${id}">${name}</a></h3>
      <p>${summary}</p>
      ${crossTags.length > 0
        ? template`<p><small>Also tagged: ${crossTags.map((slug) =>
            template`<a href="/wiki/${escapeHtml(slug)}">${escapeHtml(
              getTopic(slug)?.title || slug
            )}</a> `
          )}</small></p>`
        : template``}
    </article>`;
};

const renderConsensus = (features) => {
  const tally = consensus(features);
  const rows = Object.entries(tally).map(([label, counts]) => {
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return template``;
    return template`<li><strong>${escapeHtml(label)}:</strong> ${entries.map(([text, count]) =>
      template`${escapeHtml(text)} (${count})`
    )}</li>`;
  });
  if (rows.length === 0) return template``;
  return template`
  <h2>Cross-browser consensus</h2>
  <ul class="wiki-consensus">${rows}</ul>`;
};

const renderStages = (features, tagsById: Map<string, string[]>, topicSlug: string) => {
  const groups = stageGroups(features);
  if (groups.length === 0) return template``;
  return template`
  <h2>Features by stage</h2>
  ${groups.map(({ stage, features: groupFeatures }) => template`
    <section class="wiki-stage">
      <h3>${escapeHtml(stage)} (${groupFeatures.length})</h3>
      ${groupFeatures.map((feature) =>
        renderFeature(
          feature,
          (tagsById.get(String(feature.id)) || []).filter((slug) => slug !== topicSlug),
        )
      )}
    </section>`)}`;
};

const renderTimeline = (features) => {
  const entries = timeline(features);
  if (entries.length === 0) return template``;
  return template`
  <h2>Timeline</h2>
  <ul class="wiki-timeline">
    ${entries.map(({ milestone, feature }) => template`
      <li>Chrome <a href="/?version=${milestone}">${milestone}</a> —
        <a href="/feature/${encodeURIComponent(String(feature.id))}">${escapeHtml(feature.name || "Unnamed feature")}</a></li>`)}
  </ul>`;
};

export default async function render(
  request: Request,
  match: URLPatternResult,
  chromeStatusAPI: StatusClient,
): Promise<Response> {
  const url = new URL(request.url);
  const canonical = `https://chromestatuslite.com${escapeHtml(url.pathname + url.search)}`;
  const slug = match?.pathname?.groups?.topic || "";
  const topic = getTopic(slug);
  if (!topic) return renderNotFound(slug, canonical);

  const results = await Promise.all(
    topic.queries.map((query) => chromeStatusAPI.getFeaturesByQuery(query).catch(() => null)),
  );

  let contentBody;
  if (results.every((result) => result === null)) {
    contentBody = template`<p class="error-notice">Unable to load topic data from chromestatus.com. Please try again later.</p>`;
  } else {
    const features = collectTopicFeatures(results.filter((result) => result !== null));
    const tagsById = new Map<string, string[]>(
      features.map((feature) => [String(feature.id), tagFeature(feature)]),
    );
    contentBody = features.length === 0
      ? template`<p>No features are currently tagged with this topic.</p>`
      : template`
      <p>${features.length} feature${features.length === 1 ? "" : "s"} tagged with this topic.</p>
      ${renderConsensus(features)}
      ${renderStages(features, tagsById, topic.slug)}
      ${renderTimeline(features)}`;
  }

  return template`
  <!doctype html>
<html>

<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(topic.title)} — Web Platform Topic Wiki</title>
  <link rel="canonical" href="${canonical}">
  <link rel="stylesheet" href="/styles/index.css">
</head>

<body>
  ${nav()}
  <p><a href="/wiki">&larr; Topic directory</a></p>
  <h1>${escapeHtml(topic.title)}</h1>
  <p>${escapeHtml(topic.description)}</p>
  <div id="output">
    ${contentBody}
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
