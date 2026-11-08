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

// Continuation pages share one small per-client pool instead of launching
// every start offset at once: a cold /wiki can otherwise hold hundreds of
// upstream fetches and their buffers open inside a single anonymous request
// (chrome-status-lite-9nh). Four in flight keeps pages overlapping (a
// serialized pool would multiply a capped topic's load time) while capping
// the worst case. The pool is keyed by client like the topic cache, so the
// production singleton bounds concurrency across concurrent requests while
// tests with fresh fixture clients stay isolated.
export const CONTINUATION_POOL_SIZE = 4;

// Runs job() as soon as a slot is free; slots are handed to queued callers
// in FIFO order as earlier jobs settle.
class Semaphore {
  private inFlight = 0;
  private readonly limit: number;
  private readonly waiters: (() => void)[] = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  run<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.inFlight++;
        // job() may throw SYNCHRONOUSLY: StatusClient is structural, so a
        // non-async double or future implementation is legal. Invoking it
        // through .then turns a sync throw into a rejection, so the finally
        // below always releases the slot — a direct job() call would skip it
        // and leak slots until every pool.run() queued forever
        // (chrome-status-lite-1qp).
        Promise.resolve().then(job).then(resolve, reject).finally(() => {
          this.inFlight--;
          this.waiters.shift()?.();
        });
      };
      if (this.inFlight < this.limit) start();
      else this.waiters.push(start);
    });
  }
}

const continuationPools = new WeakMap<StatusClient, Semaphore>();

const continuationPoolFor = (chromeStatusAPI: StatusClient): Semaphore => {
  let pool = continuationPools.get(chromeStatusAPI);
  if (!pool) {
    pool = new Semaphore(CONTINUATION_POOL_SIZE);
    continuationPools.set(chromeStatusAPI, pool);
  }
  return pool;
};

export const fetchQueryFeatures = async (
  query: string,
  chromeStatusAPI: StatusClient,
): Promise<{ total_count: number; features: any[]; complete: boolean }> => {
  const first = await chromeStatusAPI.getFeaturesByQuery(query, { num: PAGE_SIZE });
  // A 200 without a numeric total_count is not evidence of a complete
  // inventory: treat it as unknown (count 0 for sizing) and incomplete, so
  // the assembled topic data is not cached as authoritative (i11). null must
  // be rejected explicitly - Number(null) coerces to 0 and would pass the
  // finite check (bzs). Numeric strings still coerce.
  const rawTotal = first?.total_count == null ? NaN : Number(first.total_count);
  const totalKnown = Number.isFinite(rawTotal);
  const total = totalKnown ? rawTotal : 0;
  const features = Array.isArray(first?.features) ? [...first.features] : [];
  const wanted = Math.min(total, MAX_FEATURES_PER_QUERY);
  let complete = totalKnown && total <= MAX_FEATURES_PER_QUERY;
  if (features.length < wanted) {
    const starts: number[] = [];
    for (let start = features.length; start < wanted; start += PAGE_SIZE) {
      starts.push(start);
    }
    // Continuations queue on the shared pool; the one retry per page
    // re-queues rather than bypassing the cap.
    const pool = continuationPoolFor(chromeStatusAPI);
    const attempt = (start: number) =>
      chromeStatusAPI.getFeaturesByQuery(query, { num: PAGE_SIZE, start });
    const fetchPage = (start: number) =>
      pool.run(() => attempt(start))
        // One retry for transient upstream failures before giving up.
        .catch(() => pool.run(() => attempt(start)))
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

// An incomplete assembly is kept only briefly instead of being deleted: the
// short retry window rate-limits and shares retries across callers, so the
// next anonymous visit inside the window does not re-run the whole
// continuation fan-out (chrome-status-lite-9nh) — while a partial inventory
// still expires quickly enough never to masquerade as the full TTL answer
// (chrome-status-lite-3mh). Total failures are still dropped: there is no
// data to show, so the next visit retries immediately.
export const TOPIC_RETRY_TTL = 45 * 1000;

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
// assembly (single-flight). Complete assemblies keep the full TTL. A partial
// inventory (a continuation page was lost, or the cap bit) is re-dated to the
// short retry TTL so callers within the window share one partial answer
// instead of each re-running the fan-out (chrome-status-lite-9nh), while a
// total failure is dropped so the next visit retries immediately (4p4).
// Neither partial ever pins a stale count for the whole TTL. `now` is
// injectable so tests can cross the retry window without sleeping.
export const getTopicData = (
  topic: WikiTopic,
  chromeStatusAPI: StatusClient,
  now: () => number = Date.now,
): Promise<TopicData> => {
  let cache = topicCaches.get(chromeStatusAPI);
  if (!cache) {
    cache = new Map();
    topicCaches.set(chromeStatusAPI, cache);
  }
  const requestedAt = now();
  const hit = cache.get(topic.slug);
  if (hit && hit.expires > requestedAt) return hit.promise;
  const promise = assembleTopicData(topic, chromeStatusAPI);
  // Cache the in-flight promise immediately so concurrent directory/topic
  // renders share one assembly; the entry's expiry is then corrected for
  // the assembled outcome below.
  cache.set(topic.slug, { expires: requestedAt + TOPIC_CACHE_TTL, promise });
  promise.then((data) => {
    const entry = cache.get(topic.slug);
    if (entry?.promise !== promise) return; // superseded by a newer assembly
    if (data.complete) return; // full TTL stands
    if (data.failed) {
      cache.delete(topic.slug);
      return;
    }
    // Partial: re-date to the retry window, anchored at resolution so a
    // slow assembly does not leave an already-expired entry behind.
    entry.expires = now() + TOPIC_RETRY_TTL;
  });
  return promise;
};
