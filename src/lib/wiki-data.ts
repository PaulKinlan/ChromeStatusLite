// Shared wiki topic data: paginated query fetching plus a per-client
// in-memory cache of assembled topic feature sets. The /wiki directory and
// the /wiki/:slug topic pages both read through getTopicData, so they count
// the same deduped union of features and a warm cache makes both load
// without any upstream requests. The cache is keyed by client (WeakMap), so
// tests with fresh fixture clients stay isolated while production's shared
// singleton shares assembled data across requests.

import type { StatusClient } from "../handler.ts";
import { collectTopicFeatures, type WikiTopic } from "./wiki.ts";

// The upstream search defaults to 100 results per page; topics can match
// several hundred features, so fetch continuation pages in parallel (one
// retry each). The cap bounds upstream load for very broad queries. A failed
// continuation or a capped result sets complete=false, and callers must say
// so rather than presenting a partial inventory as the whole topic.
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
  // A continuation can also succeed with a short or empty page, or repeat
  // records already seen, so check the unique assembled count against what
  // upstream said exists, not just for errors or raw length.
  const byId = new Map<string, any>();
  for (const feature of features) {
    if (!feature || typeof feature !== "object" || feature.id === undefined) continue;
    const key = String(feature.id);
    if (!byId.has(key)) byId.set(key, feature);
  }
  const unique = [...byId.values()];
  if (unique.length < wanted) complete = false;
  return { total_count: total, features: unique.slice(0, MAX_FEATURES_PER_QUERY), complete };
};

export interface TopicData {
  // Deduped union of every query's features, ordered by name — the single
  // source of truth for both the directory count and the topic page list.
  features: any[];
  // False when any query failed outright, lost a continuation page, or hit
  // the cap: the feature set is then a partial inventory.
  complete: boolean;
  // True when every query failed: there is no data to show at all.
  failed: boolean;
}

// Assembled topic data is cached briefly. Freshness beyond the TTL falls
// through to the client, whose own LRU still shields upstream for an hour,
// so a TTL refetch is assembly work, not necessarily network work.
const TOPIC_CACHE_TTL = 15 * 60 * 1000;

interface CacheEntry {
  expires: number;
  promise: Promise<TopicData>;
}

const topicCaches = new WeakMap<StatusClient, Map<string, CacheEntry>>();

const assembleTopicData = async (
  topic: WikiTopic,
  chromeStatusAPI: StatusClient,
): Promise<TopicData> => {
  const results = await Promise.all(
    topic.queries.map((query) => fetchQueryFeatures(query, chromeStatusAPI).catch(() => null)),
  );
  const loaded = results.filter((result) => result !== null);
  return {
    features: collectTopicFeatures(loaded),
    complete: results.every((result) => result !== null && result.complete),
    failed: loaded.length === 0,
  };
};

// Returns the assembled feature set for a topic, serving from the shared
// per-client cache when fresh. Concurrent callers share one in-flight
// assembly (single-flight), and a total failure is NOT cached so the next
// visit retries upstream instead of pinning an error page.
export const getTopicData = (
  topic: WikiTopic,
  chromeStatusAPI: StatusClient,
): Promise<TopicData> => {
  let cache = topicCaches.get(chromeStatusAPI);
  if (!cache) {
    cache = new Map();
    topicCaches.set(chromeStatusAPI, cache);
  }
  const now = Date.now();
  const hit = cache.get(topic.slug);
  if (hit && hit.expires > now) return hit.promise;
  const promise = assembleTopicData(topic, chromeStatusAPI);
  // Cache the in-flight promise immediately so concurrent directory/topic
  // renders share one assembly. Drop the entry if every query failed.
  cache.set(topic.slug, { expires: now + TOPIC_CACHE_TTL, promise });
  promise.then((data) => {
    if (data.failed && cache.get(topic.slug)?.promise === promise) {
      cache.delete(topic.slug);
    }
  });
  return promise;
};
