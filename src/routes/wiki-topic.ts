import template from "../flora.ts";
import type { StatusClient } from "../handler.ts";
import linkify from "../lib/linkify.ts";
import {
  consensus,
  getTopic,
  stageGroups,
  tagFeature,
  timeline,
} from "../lib/wiki.ts";
import {
  fetchQueryFeatures,
  getTopicData,
  type WikiTopicStore,
} from "../lib/wiki-data.ts";
import {
  htmlResponse,
  NO_STORE_CACHE_CONTROL,
} from "../ui-components/layout.ts";

// Re-exported so existing imports of the paginated query fetcher keep working.
export { fetchQueryFeatures };

const renderNotFound = (slug: string, canonical: string, path: string) =>
  htmlResponse({
    status: 404,
    cacheControl: NO_STORE_CACHE_CONTROL,
    title: "Topic not found",
    canonical,
    currentPath: path,
    body: template`<h1>Topic not found</h1>
  <p>No wiki topic <code>${slug}</code> exists. Browse the
     <a href="/wiki">topic directory</a>.</p>`,
  });

const renderFeature = (feature: any, crossTags: string[]) => {
  const id = encodeURIComponent(String(feature.id));
  const name = feature.name || "Unnamed feature";
  const summary = feature.summary ? linkify(feature.summary) : template``;
  return template`
    <article class="wiki-feature">
      <h3><a href="/feature/${id}">${name}</a></h3>
      <p>${summary}</p>
      ${
    crossTags.length > 0
      ? template`<p><small>Also tagged: ${
        crossTags.map((slug) =>
          template`<a href="/wiki/${slug}">${
            getTopic(slug)?.title || slug
          }</a> `
        )
      }</small></p>`
      : template``
  }
    </article>`;
};

const renderConsensus = (features: any[]) => {
  const tally = consensus(features);
  const rows = Object.entries(tally)
    .map(([label, counts]) => ({
      label,
      entries: Object.entries(counts).sort((a, b) => b[1] - a[1]),
    }))
    .filter(({ entries }) => entries.length > 0);
  if (rows.length === 0) return template``;
  return template`
  <h2>Cross-browser consensus</h2>
  <ul class="wiki-consensus">${
    rows.map(({ label, entries }) =>
      template`<li><strong>${label}:</strong> ${
        entries.map(([text, count], index) =>
          template`${index > 0 ? ", " : ""}${text} (${count})`
        )
      }</li>`
    )
  }</ul>`;
};

const renderStages = (
  features: any[],
  tagsById: Map<string, string[]>,
  topicSlug: string,
) => {
  const groups = stageGroups(features);
  if (groups.length === 0) return template``;
  return template`
  <h2>Features by stage</h2>
  ${
    groups.map(({ stage, features: groupFeatures }) =>
      template`
    <section class="wiki-stage">
      <h3>${stage} (${groupFeatures.length})</h3>
      ${
        groupFeatures.map((feature) =>
          renderFeature(
            feature,
            (tagsById.get(String(feature.id)) || []).filter((slug) =>
              slug !== topicSlug
            ),
          )
        )
      }
    </section>`
    )
  }`;
};

const renderTimeline = (features: any[]) => {
  const entries = timeline(features);
  if (entries.length === 0) return template``;
  return template`
  <h2>Timeline</h2>
  <ul class="wiki-timeline">
    ${
    entries.map(({ milestone, feature }) =>
      template`
      <li>Chrome <a href="/?version=${milestone}">${milestone}</a> —
        <a href="/feature/${encodeURIComponent(String(feature.id))}">${
        feature.name || "Unnamed feature"
      }</a></li>`
    )
  }
  </ul>`;
};

export default async function render(
  request: Request,
  match: URLPatternResult,
  chromeStatusAPI: StatusClient,
  wikiStore: WikiTopicStore | null = null,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const url = new URL(request.url);
  const canonical = `https://chromestatuslite.com${url.pathname + url.search}`;
  const slug = match?.pathname?.groups?.topic || "";
  const topic = getTopic(slug);
  if (!topic) return renderNotFound(slug, canonical, url.pathname);

  const data = await getTopicData(
    topic,
    chromeStatusAPI,
    Date.now,
    wikiStore,
    waitUntil,
  );

  let contentBody: unknown;
  if (data.failed) {
    contentBody =
      template`<p class="error-notice">Unable to load topic data from chromestatus.com. Please try again later.</p>`;
  } else {
    const incomplete = !data.complete;
    const features = data.features;
    const incompleteNotice =
      template`<p class="error-notice">Some features could not be loaded from chromestatus.com; the list below is incomplete.</p>`;
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
      <p>${features.length} feature${
        features.length === 1 ? "" : "s"
      } tagged with this topic.</p>
      ${renderConsensus(features)}
      ${renderStages(features, tagsById, topic.slug)}
      ${renderTimeline(features)}`;
    }
  }

  return htmlResponse({
    title: `${topic.title} — Web Platform Topic Wiki`,
    canonical,
    description: topic.description,
    currentPath: url.pathname,
    cacheControl: data.failed || !data.complete
      ? NO_STORE_CACHE_CONTROL
      : undefined,
    body: template`<p><a href="/wiki">&larr; Topic directory</a></p>
  <h1>${topic.title}</h1>
  <p>${topic.description}</p>
  <div id="output">
    ${contentBody}
  </div>`,
  });
}
