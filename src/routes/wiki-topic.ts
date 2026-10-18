import template from "../flora.ts";
import type { StatusClient } from "../handler.ts";
import { escapeHtml } from "https://deno.land/x/escape_html/mod.ts";

import nav from "../ui-components/nav.ts";
import {
  consensus,
  getTopic,
  stageGroups,
  tagFeature,
  timeline,
} from "../lib/wiki.ts";
import { fetchQueryFeatures, getTopicData } from "../lib/wiki-data.ts";

// Re-exported so existing imports of the paginated query fetcher keep
// working; its home is the shared wiki-data module.
export { fetchQueryFeatures };

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
  // consensus() always returns the same three browser keys, so the guard
  // must be on whether any row actually has counts, not on rows.length.
  const rows = Object.entries(tally)
    .map(([label, counts]) => ({
      label,
      entries: Object.entries(counts).sort((a, b) => b[1] - a[1]),
    }))
    .filter(({ entries }) => entries.length > 0);
  if (rows.length === 0) return template``;
  return template`
  <h2>Cross-browser consensus</h2>
  <ul class="wiki-consensus">${rows.map(({ label, entries }) =>
    template`<li><strong>${escapeHtml(label)}:</strong> ${entries.map(([text, count], index) =>
      template`${index > 0 ? ", " : ""}${escapeHtml(text)} (${count})`
    )}</li>`
  )}</ul>`;
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

  const data = await getTopicData(topic, chromeStatusAPI);

  let contentBody;
  if (data.failed) {
    contentBody = template`<p class="error-notice">Unable to load topic data from chromestatus.com. Please try again later.</p>`;
  } else {
    // A query that failed outright, a failed continuation page, or a capped
    // result means what follows is partial: say so rather than presenting
    // the rendered subset as the complete topic inventory. The notice applies
    // to the empty branch too: "no features tagged" is only truthful when
    // every query actually succeeded.
    const incomplete = !data.complete;
    const features = data.features;
    const incompleteNotice = template`<p class="error-notice">Some features could not be loaded from chromestatus.com; the list below is incomplete.</p>`;
    if (features.length === 0) {
      contentBody = incomplete
        ? template`${incompleteNotice}<p>No features were returned by the queries that did load.</p>`
        : template`<p>No features are currently tagged with this topic.</p>`;
    } else {
      const tagsById = new Map<string, string[]>(
        features.map((feature) => [String(feature.id), tagFeature(feature)]),
      );
      contentBody = template`
      ${incomplete ? incompleteNotice : template``}
      <p>${features.length} feature${features.length === 1 ? "" : "s"} tagged with this topic.</p>
      ${renderConsensus(features)}
      ${renderStages(features, tagsById, topic.slug)}
      ${renderTimeline(features)}`;
    }
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
