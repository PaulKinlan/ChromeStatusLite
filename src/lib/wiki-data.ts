// Shared wiki topic data: paginated query fetching, per-client in-memory cache
// of assembled topic feature sets, and optional durable D1 backing refreshed
// by a Cloudflare Cron Trigger so /wiki stays within Workers Free plan
// external subrequest limits and serves in a single D1 query.

import type { StatusClient } from "../handler.ts";
import { collectTopicFeatures, WIKI_TOPICS, type WikiTopic } from "./wiki.ts";

const PAGE_SIZE = 100;
const MAX_FEATURES_PER_QUERY = 1000;

export const CONTINUATION_POOL_SIZE = 4;

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
        // Invoke through .then so a synchronous throw still releases the slot.
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
  const first = await chromeStatusAPI.getFeaturesByQuery(query, {
    num: PAGE_SIZE,
  });
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
    const pool = continuationPoolFor(chromeStatusAPI);
    const attempt = (start: number) =>
      chromeStatusAPI.getFeaturesByQuery(query, { num: PAGE_SIZE, start });
    const fetchPage = (start: number) =>
      pool.run(() => attempt(start))
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
  const byId = new Map<string, any>();
  for (const feature of features) {
    if (!feature || typeof feature !== "object" || feature.id === undefined) {
      continue;
    }
    const key = String(feature.id);
    if (!byId.has(key)) byId.set(key, feature);
  }
  const unique = [...byId.values()];
  if (unique.length < wanted) complete = false;
  return {
    total_count: total,
    features: unique.slice(0, MAX_FEATURES_PER_QUERY),
    complete,
  };
};

export interface TopicData {
  features: any[];
  complete: boolean;
  failed: boolean;
}

export interface StoredTopicEntry {
  slug: string;
  data: TopicData;
  updatedAt: number;
}

export interface WikiTopicStore {
  get(slug: string): Promise<StoredTopicEntry | null>;
  getAll(): Promise<Map<string, StoredTopicEntry>>;
  set(slug: string, data: TopicData, updatedAt?: number): Promise<void>;
}

// Keep only the fields rendered by /wiki and /wiki/:topic when persisting to
// D1 so each cached topic stays compact (well under D1 row/payload limits).
function slimFeatureForWiki(feature: any): any {
  const chrome = feature?.browsers?.chrome;
  return {
    id: feature?.id,
    name: feature?.name,
    summary: feature?.summary,
    motivation: feature?.motivation,
    spec_link: feature?.spec_link,
    standards: feature?.standards?.spec
      ? { spec: feature.standards.spec }
      : undefined,
    search_tags: Array.isArray(feature?.search_tags)
      ? feature.search_tags
      : undefined,
    blink_components: Array.isArray(feature?.blink_components)
      ? feature.blink_components
      : undefined,
    browsers: {
      chrome: chrome
        ? {
          status: chrome.status
            ? {
              text: chrome.status.text,
              milestone_str: chrome.status.milestone_str,
            }
            : undefined,
          blink_components: Array.isArray(chrome.blink_components)
            ? chrome.blink_components
            : undefined,
        }
        : undefined,
      ff: feature?.browsers?.ff?.view?.text
        ? { view: { text: feature.browsers.ff.view.text } }
        : undefined,
      safari: feature?.browsers?.safari?.view?.text
        ? { view: { text: feature.browsers.safari.view.text } }
        : undefined,
      webdev: feature?.browsers?.webdev?.view?.text
        ? { view: { text: feature.browsers.webdev.view.text } }
        : undefined,
    },
  };
}

/** D1-backed persistent cache for pre-warmed /wiki topic inventories. */
export class D1WikiTopicStore implements WikiTopicStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async get(slug: string): Promise<StoredTopicEntry | null> {
    const row = await this.#db
      .prepare(
        `SELECT slug, payload, complete, updated_at
         FROM wiki_topic_cache
         WHERE slug = ?`,
      )
      .bind(slug)
      .first<{
        slug: string;
        payload: string;
        complete: number;
        updated_at: number;
      }>();
    if (!row) return null;
    return {
      slug: row.slug,
      data: {
        features: JSON.parse(row.payload) as any[],
        complete: row.complete === 1,
        failed: false,
      },
      updatedAt: Number(row.updated_at),
    };
  }

  async getAll(): Promise<Map<string, StoredTopicEntry>> {
    const { results } = await this.#db
      .prepare(
        `SELECT slug, payload, complete, updated_at
         FROM wiki_topic_cache`,
      )
      .all<{
        slug: string;
        payload: string;
        complete: number;
        updated_at: number;
      }>();
    const map = new Map<string, StoredTopicEntry>();
    for (const row of results) {
      map.set(row.slug, {
        slug: row.slug,
        data: {
          features: JSON.parse(row.payload) as any[],
          complete: row.complete === 1,
          failed: false,
        },
        updatedAt: Number(row.updated_at),
      });
    }
    return map;
  }

  async set(
    slug: string,
    data: TopicData,
    updatedAt = Date.now(),
  ): Promise<void> {
    if (data.failed) return;
    const slimmed = data.features.map(slimFeatureForWiki);
    await this.#db
      .prepare(
        `INSERT INTO wiki_topic_cache (slug, payload, complete, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           payload = excluded.payload,
           complete = excluded.complete,
           updated_at = excluded.updated_at`,
      )
      .bind(slug, JSON.stringify(slimmed), data.complete ? 1 : 0, updatedAt)
      .run();
  }
}

const TOPIC_CACHE_TTL = 15 * 60 * 1000;
// Durable D1 topic entries remain fresh for 6 hours (cron refreshes them every
// ~75 min on a rotating schedule), and stale entries are still served while
// the cron refreshes them so /wiki never triggers a 100-subrequest stampede.
export const DURABLE_TOPIC_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const TOPIC_RETRY_TTL = 45 * 1000;

interface CacheEntry {
  expires: number;
  promise: Promise<TopicData>;
}

const topicCaches = new WeakMap<StatusClient, Map<string, CacheEntry>>();

export const assembleTopicData = async (
  topic: WikiTopic,
  chromeStatusAPI: StatusClient,
): Promise<TopicData> => {
  const results = await Promise.all(
    topic.queries.map((query) =>
      fetchQueryFeatures(query, chromeStatusAPI).catch(() => null)
    ),
  );
  const loaded = results.filter((result) => result !== null);
  return {
    features: collectTopicFeatures(loaded),
    complete: results.every((result) => result !== null && result.complete),
    failed: loaded.length === 0,
  };
};

// Returns the assembled feature set for a topic. When a durable WikiTopicStore
// (D1) is supplied and holds a fresh entry, it is served directly without
// touching chromestatus.com; on a miss, the topic is assembled and written
// back to the durable store (non-blocking via waitUntil when provided).
export const getTopicData = (
  topic: WikiTopic,
  chromeStatusAPI: StatusClient,
  now: () => number = Date.now,
  wikiStore: WikiTopicStore | null = null,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<TopicData> => {
  let cache = topicCaches.get(chromeStatusAPI);
  if (!cache) {
    cache = new Map();
    topicCaches.set(chromeStatusAPI, cache);
  }
  const requestedAt = now();
  const hit = cache.get(topic.slug);
  if (hit && hit.expires > requestedAt) return hit.promise;

  const promise = (async (): Promise<TopicData> => {
    if (wikiStore) {
      const stored = await wikiStore.get(topic.slug).catch(() => null);
      if (stored && (requestedAt - stored.updatedAt) < DURABLE_TOPIC_MAX_AGE_MS) {
        return stored.data;
      }
      const assembled = await assembleTopicData(topic, chromeStatusAPI);
      if (!assembled.failed) {
        const persist = wikiStore.set(topic.slug, assembled, now()).catch(() => {});
        if (waitUntil) waitUntil(persist);
        else await persist;
        return assembled;
      }
      // If upstream is completely down, serve stale D1 inventory rather than
      // failing the page completely.
      if (stored) return stored.data;
      return assembled;
    }
    return assembleTopicData(topic, chromeStatusAPI);
  })();

  cache.set(topic.slug, { expires: requestedAt + TOPIC_CACHE_TTL, promise });
  promise.then((data) => {
    const entry = cache.get(topic.slug);
    if (entry?.promise !== promise) return;
    if (data.complete) return;
    if (data.failed) {
      cache.delete(topic.slug);
      return;
    }
    entry.expires = now() + TOPIC_RETRY_TTL;
  });
  return promise;
};

// Refreshes the stalest `batchSize` wiki topics into D1. Designed for a
// Cloudflare Cron Trigger on the Workers Free plan (50 external subrequests
// per invocation): refreshing 3 topics per tick keeps external fetches well
// below the limit while cycling through all 15 topics every ~75 minutes.
export async function refreshStaleWikiTopics(
  chromeStatusAPI: StatusClient,
  wikiStore: WikiTopicStore,
  options: { batchSize?: number; now?: () => number } = {},
): Promise<{ refreshed: string[]; failed: string[] }> {
  const batchSize = options.batchSize ?? 3;
  const now = options.now ?? Date.now;
  const existing = await wikiStore.getAll().catch(
    () => new Map<string, StoredTopicEntry>(),
  );

  // Prioritize never-cached topics first, then oldest updated_at.
  const ordered = [...WIKI_TOPICS].sort((a, b) => {
    const aTime = existing.get(a.slug)?.updatedAt ?? -1;
    const bTime = existing.get(b.slug)?.updatedAt ?? -1;
    return aTime - bTime;
  });

  const batch = ordered.slice(0, batchSize);
  const refreshed: string[] = [];
  const failed: string[] = [];

  for (const topic of batch) {
    try {
      const data = await assembleTopicData(topic, chromeStatusAPI);
      if (!data.failed) {
        await wikiStore.set(topic.slug, data, now());
        refreshed.push(topic.slug);
      } else {
        failed.push(topic.slug);
      }
    } catch {
      failed.push(topic.slug);
    }
  }

  return { refreshed, failed };
}
