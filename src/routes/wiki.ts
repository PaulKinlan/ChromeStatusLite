import template from "../flora.ts";
import type { StatusClient } from "../handler.ts";
import { WIKI_TOPICS, type WikiTopic } from "../lib/wiki.ts";
import {
  getTopicData,
  type StoredTopicEntry,
  type TopicData,
  type WikiTopicStore,
} from "../lib/wiki-data.ts";
import { htmlResponse } from "../ui-components/layout.ts";

// When backed by D1, bound cold on-demand fallbacks per directory request so
// even before the first Cron Trigger completes, /wiki stays safely inside the
// Cloudflare Workers Free plan 50 external subrequest budget.
const MAX_COLD_DIRECTORY_FALLBACKS = 2;

const renderCount = (topic: WikiTopic, data: TopicData) =>
  data.failed
    ? template``
    : template`<p><a href="/wiki/${topic.slug}">${data.features.length}${
      data.complete ? "" : "+"
    } feature${data.features.length === 1 && data.complete ? "" : "s"}</a></p>`;

const renderTopicCard = (
  topic: WikiTopic,
  dataPromise: Promise<TopicData> | null,
) =>
  template`
  <article class="wiki-topic">
    <h2><a href="/wiki/${topic.slug}">${topic.title}</a></h2>
    <p>${topic.description}</p>
    ${dataPromise ? dataPromise.then((data) => renderCount(topic, data)) : template``}
  </article>`;

export default async function render(
  request: Request,
  chromeStatusAPI: StatusClient,
  wikiStore: WikiTopicStore | null = null,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const url = new URL(request.url);

  // With D1 configured, one batch query fetches every pre-warmed topic count
  // with zero external subrequests.
  let storedAll: Map<string, StoredTopicEntry> | null = null;
  if (wikiStore) {
    storedAll = await wikiStore.getAll().catch(() => null);
  }

  let coldFallbacksUsed = 0;
  const cards = WIKI_TOPICS.map((topic) => {
    if (storedAll) {
      const hit = storedAll.get(topic.slug);
      if (hit) return renderTopicCard(topic, Promise.resolve(hit.data));
      if (coldFallbacksUsed < MAX_COLD_DIRECTORY_FALLBACKS) {
        coldFallbacksUsed++;
        return renderTopicCard(
          topic,
          getTopicData(topic, chromeStatusAPI, Date.now, wikiStore, waitUntil),
        );
      }
      // Leave remaining cold topics uncounted until the cron warms them.
      return renderTopicCard(topic, null);
    }
    return renderTopicCard(
      topic,
      getTopicData(topic, chromeStatusAPI),
    );
  });

  return htmlResponse({
    title: "Web Platform Topic Wiki",
    canonical: `https://chromestatuslite.com${url.pathname + url.search}`,
    description:
      "Topic pages grouping Chrome Platform Status features across WebGPU, CSS, Built-in AI, Storage, Privacy, and more.",
    currentPath: url.pathname,
    body: template`<h1>Web Platform Topic Wiki</h1>
  <p>Persistent topic pages grouping related Chrome Platform Status features: active stages,
     cross-browser consensus, and shipping timelines. Tags are assigned by a deterministic
     keyword pipeline and kept in sync with chromestatus.com data.</p>
  <div id="output" class="wiki-directory">
    ${cards}
  </div>`,
  });
}
