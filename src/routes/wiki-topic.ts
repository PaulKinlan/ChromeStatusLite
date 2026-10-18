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

// The upstream search defaults to 100 results per page; topics can match
// several hundred features, so fetch continuation pages in parallel (one
// retry each). The cap bounds upstream load for very broad queries. A failed
// continuation or a capped result sets complete=false, and the route must
// say so rather than presenting a partial inventory as the whole topic.
const PAGE_SIZE = 100;
const MAX_FEATURES_PER_QUERY = 1000;

export const fetchQueryFeatures = async (
  query: string,
  chromeStatusAPI: StatusClient,
): Promise<{ total_count: number; features: any[]; complete: boolean }> => {
  const first = await chromeStatusAPI.getFeaturesByQuery(query, { num: PAGE_SIZE });
  const total = Number(first?.total_count) || 0;
  const features = Array.isArray(first?.features) ? [...first.features] : [];
  const wanted = Math.min(total, MAX_FEATURES_PER_QUERY);
  let complete = total <= MAX_FEATURES_PER_QUERY;
  if (features.length < wanted) {
    const starts: number[] = [];
    for (let start = features.length; start < wanted; start += PAGE_SIZE) {
      starts.push(start);
    }
    const fetchPage = (start: number) =>
      chromeStatusAPI.getFeaturesByQuery(query, { num: PAGE_SIZE, start })
        // One retry for transient upstream failures before giving up.
        .catch(() => chromeStatusAPI.getFeaturesByQuery(query, { num: PAGE_SIZE, start }))
        .catch(() => null);
    for (const page of await Promise.all(starts.map(fetchPage))) {
      if (Array.isArray(page?.features)) {
        features.push(...page.features);
      } else {
        complete = false;
      }
    }
  }
  return { total_count: total, features: features.slice(0, MAX_FEATURES_PER_QUERY), complete };
};

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

  const results = await Promise.all(
    topic.queries.map((query) => fetchQueryFeatures(query, chromeStatusAPI).catch(() => null)),
  );

  let contentBody;
  if (results.every((result) => result === null)) {
    contentBody = template`<p class="error-notice">Unable to load topic data from chromestatus.com. Please try again later.</p>`;
  } else {
    // A query that failed outright, a failed continuation page, or a capped
    // result means what follows is partial: say so rather than presenting
    // the rendered subset as the complete topic inventory. The notice applies
    // to the empty branch too: "no features tagged" is only truthful when
    // every query actually succeeded.
    const incomplete = results.some((result) => result === null || !result.complete);
    const features = collectTopicFeatures(results.filter((result) => result !== null));
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
