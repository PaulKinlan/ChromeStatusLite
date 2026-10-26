import { StripStream } from "../stream-utils.ts";
import LRU from "https://deno.land/x/lru_cache@6.0.0-deno.4/mod.ts";
import { format as formatDateTime } from "https://deno.land/std@0.152.0/datetime/mod.ts";

// Parses an upstream stable_date, or null when the value is absent or
// unparseable. Callers must validate before formatting: std datetime's
// format renders an Invalid Date as "NaN-NaN-NaN" and Date.toUTCString()
// renders it as "Invalid Date" rather than throwing.
export function parseStableDate(value: unknown): Date | null {
  if (typeof value !== "string" || value === "") return null;
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

// Renders an upstream stable_date as "yyyy-MM-dd", or null when the value is
// absent or unparseable.
export function formatStableDate(value: unknown): string | null {
  const date = parseStableDate(value);
  return date ? formatDateTime(date, "yyyy-MM-dd") : null;
}

const CHROMESTATUS_API_ENDPOINT = "https://chromestatus.com";
// Single-sourced because it is also the cache key getVersions() must evict
// when it finds the cached body malformed (chrome-status-lite-8uv).
const CHANNELS_PATH = "/api/v0/channels";
const CACHE_MAX_ITEMS = 100;
const CACHE_MAX_AGE = 1000 * 60 * 60; // 1 hour.
// Upstream bounds: chromestatus.com has accepted connections and then stalled
// in the past, and Deno's fetch has no default timeout, so without these a
// single hung upstream parks every awaiting route handler (and its buffered
// memory) forever. Errors from either bound are rethrown as plain Errors so
// the existing error-notice / .catch(() => ({})) fallbacks engage.
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_BODY_BYTES = 16 * 1024 * 1024; // 16 MB.
// Sanity bound for the dev-channel version: real Chrome milestones are two
// digits, so anything past this is malformed upstream data. Allocating the
// version list before validating would throw Array(NaN) RangeErrors or
// materialise an Array(1e9) (~8 GB) that OOMs the whole process — one bad
// /api/v0/channels payload must not do that, it must fail like any other
// malformed upstream body: a thrown error the routes render as an error notice.
const MAX_PLAUSIBLE_VERSION = 2000;

// Fails the stream once more than `limit` bytes have flowed through it, so a
// never-ending upstream body cannot grow the buffered text without bound.
function byteLimitStream(limit: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > limit) {
        controller.error(
          new Error(`Upstream body exceeded ${limit} bytes`),
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

export class ChromeStatusAPI {
  private static instance: null | ChromeStatusAPI = null;

  // `del` is optional so get/set-only test doubles keep working; the real
  // LRU implements it (that is its delete-by-key name), and only the
  // malformed-channels eviction path needs it.
  private cache: Pick<LRU<string, any>, "get" | "set"> & {
    del?: (key: string) => void;
  };
  private fetcher: typeof fetch;
  private timeoutMs: number;
  private maxBodyBytes: number;

  constructor(options: {
    fetcher?: typeof fetch;
    cache?: Pick<LRU<string, any>, "get" | "set"> & {
      del?: (key: string) => void;
    };
    timeoutMs?: number;
    maxBodyBytes?: number;
  } = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
    this.maxBodyBytes = options.maxBodyBytes ?? FETCH_MAX_BODY_BYTES;
    this.cache = options.cache ?? new LRU<string, any>({
      max: CACHE_MAX_ITEMS,
      maxAge: CACHE_MAX_AGE,
    });
  }

  public static getInstance(): ChromeStatusAPI {
    if (ChromeStatusAPI.instance == null) {
      ChromeStatusAPI.instance = new ChromeStatusAPI();
    }
    return ChromeStatusAPI.instance;
  }

  public async getChannels(start?: number, end?: number): Promise<any> {
    let queryString = "";
    if (start != undefined && end != undefined) {
      queryString = `?start=${start}&end=${end}`;
    }
    return this.fetchJson(`${CHANNELS_PATH}${queryString}`);
  }

  // Returns features for a milestone grouped by status, e.g.
  // { "Enabled by default": [...], "Origin trial": [...], ... }.
  // The old `/features_v2.json` no longer carries a usable `milestone`
  // field, so we use the milestone query on the v0 API which groups
  // features by type server-side.
  // Callers pass user-influenced strings as well as numbers, so the value is
  // coerced to a canonical integer milestone before it feeds either the
  // upstream query or the shared LRU key: a raw string could append upstream
  // parameters ("120&num=1") or mint unbounded cache entries.
  public async getFeaturesForVersion(version: number | string): Promise<any> {
    const milestone = Number.parseInt(String(version), 10);
    if (!Number.isFinite(milestone)) {
      throw new Error(`Invalid milestone: ${version}`);
    }
    const params = new URLSearchParams({ milestone: String(milestone) });
    const data = await this.fetchJson(`/api/v0/features?${params}`);
    return (data as any).features_by_type || {};
  }

  public async getVersions(): Promise<any> {
    const versionData = await this.getChannels();
    const rawVersion = versionData?.dev?.version;
    const lastVersion = Number.parseInt(rawVersion);
    if (
      !Number.isFinite(lastVersion) || lastVersion <= 0 ||
      lastVersion > MAX_PLAUSIBLE_VERSION
    ) {
      // fetchJson() has already cached the parsed body, so without this the
      // same malformed payload would be re-served from cache — and re-thrown
      // — for up to CACHE_MAX_AGE (1h). Every other malformed-upstream shape
      // throws before the cache write and recovers on the next request; drop
      // the poisoned entry (del: the LRU's delete-by-key) so this shape does
      // too.
      this.cache.del?.(CHANNELS_PATH);
      throw new Error(
        `Upstream returned an implausible dev.version: ${
          JSON.stringify(rawVersion)
        }`,
      );
    }

    return Array.from({ length: lastVersion }, (_, i) => lastVersion - 1 - i);
  }

  public async getFeaturesByType(type: number): Promise<any> {
    return this.fetchJson(`/api/v0/features?q=feature_type=${type}`);
  }

  // Full-text search over all features. Returns { total_count, features };
  // each feature carries the full browsers/stages payload, which the wiki
  // topic pages group and tag from. The upstream default page size is 100,
  // so callers needing more than a page must paginate with num/start.
  public async getFeaturesByQuery(
    query: string,
    options: { num?: number; start?: number } = {},
  ): Promise<any> {
    const params = new URLSearchParams({ q: query });
    if (options.num !== undefined) params.set("num", String(options.num));
    if (options.start !== undefined) params.set("start", String(options.start));
    return this.fetchJson(`/api/v0/features?${params}`);
  }

  // Fetches a single feature's full detail by id.
  public async getFeature(id: string | number): Promise<any> {
    return this.fetchJson(`/api/v0/features/${id}`);
  }

  private async fetchJson<T>(
    path: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    let json = this.cache.get(path);

    if (!json) {
      const url = CHROMESTATUS_API_ENDPOINT + path;
      // Bound the upstream wait even when no caller signal is available; a
      // caller's signal (e.g. the incoming request's) aborts the fetch too.
      const signals = [AbortSignal.timeout(this.timeoutMs)];
      if (options.signal) signals.push(options.signal);
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      let response: Response;
      try {
        response = await this.fetcher(url, { signal });
      } catch (err) {
        throw new Error(
          `Upstream fetch failed for ${path}: ${(err as Error).message}`,
        );
      }
      if (!response.ok) {
        throw new Error(`Upstream HTTP ${response.status} from ${path}`);
      }
      let body = response.body;
      if (body == null) {
        throw new Error(`Upstream returned no body for ${path}`);
      }
      const strippedResponse = new Response(
        body
          .pipeThrough(new StripStream())
          .pipeThrough(byteLimitStream(this.maxBodyBytes)),
      );
      let text: string;
      try {
        text = await strippedResponse.text();
      } catch (err) {
        throw new Error(
          `Upstream body read failed for ${path}: ${(err as Error).message}`,
        );
      }
      json = JSON.parse(text);
      this.cache.set(path, json);
    }
    return json;
  }
}
