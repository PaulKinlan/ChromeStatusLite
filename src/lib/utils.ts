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
// How long a retryable upstream failure (timeout, 5xx, 429, unreadable or
// unparseable body) is remembered before the path is retried upstream. Far
// below CACHE_MAX_AGE: it exists to stop an outage amplifying incoming
// traffic 1:1 onto chromestatus.com, not to serve stale errors for an hour.
// Client errors (404 and other 4xx) are never negative-cached: they reflect
// the path, not upstream health.
const NEGATIVE_CACHE_MAX_AGE = 10_000; // 10 s.
// Sanity bound for the dev-channel version: real Chrome milestones are two
// digits, so anything past this is malformed upstream data. Allocating the
// version list before validating would throw Array(NaN) RangeErrors or
// materialise an Array(1e9) (~8 GB) that OOMs the whole process — one bad
// /api/v0/channels payload must not do that, it must fail like any other
// malformed upstream body: a thrown error the routes render as an error notice.
const MAX_PLAUSIBLE_VERSION = 2000;

// Route-seam bounds for client-supplied numeric path parameters
// (chrome-status-lite-s9w). fetchJson() keys the shared LRU on the upstream
// path, so every distinct accepted value mints a cache entry and costs an
// upstream call: an unbounded id or milestone lets one unauthenticated
// client flush the whole cache. Real chromestatus feature ids are at most
// 16 decimal digits (e.g. 5082469066604544) and real milestones sit far
// below MAX_PLAUSIBLE_VERSION, so anything outside these bounds cannot be
// real and is rejected at the route seam — before any upstream call or
// cache write.
export const MAX_FEATURE_ID_DIGITS = 16;
const FEATURE_ID_RE = new RegExp(`^\\d{1,${MAX_FEATURE_ID_DIGITS}}$`);
const MILESTONE_PARAM_RE = new RegExp(
  `^\\d{1,${String(MAX_PLAUSIBLE_VERSION).length}}$`,
);

// A client-supplied feature id is valid only when it is a digit string no
// longer than a real chromestatus id. Longer values (and anything
// non-numeric) 404 at the seam instead of flowing into an oversized
// upstream path and LRU/store key.
export function isValidFeatureId(id: unknown): id is string {
  return typeof id === "string" && FEATURE_ID_RE.test(id);
}

// A client-supplied milestone is parsed only when it is a plausible integer
// in [1, MAX_PLAUSIBLE_VERSION]; anything else — including a digit string
// longer than the bound itself, which parseInt would silently truncate —
// returns null for the route to reject with 400.
export function parseMilestoneParam(raw: string): number | null {
  if (!MILESTONE_PARAM_RE.test(raw)) return null;
  const milestone = Number.parseInt(raw, 10);
  if (!(milestone >= 1 && milestone <= MAX_PLAUSIBLE_VERSION)) return null;
  return milestone;
}

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

// A remembered retryable upstream failure. JSON.parse can never produce a
// class instance, so a cached value of this type is unambiguously a negative
// entry, never an upstream body. Stored in the same shared LRU (whose 1h
// maxAge still bounds memory); the shorter expiresAt is checked on read and
// stale entries are evicted on the next access.
class NegativeCacheEntry {
  constructor(
    readonly error: Error,
    readonly expiresAt: number,
  ) {}
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
  private negativeCacheMaxAge: number;
  // Concurrent cache misses for the same path share one upstream call
  // (singleflight): without it, an outage burst overlapping the slow (up to
  // 15s) first attempt amplifies 1:1 before the negative cache entry exists
  // (chrome-status-lite-9da). The same coalescing applies to successes.
  private inFlight: Map<string, Promise<any>> = new Map();

  constructor(options: {
    fetcher?: typeof fetch;
    cache?: Pick<LRU<string, any>, "get" | "set"> & {
      del?: (key: string) => void;
    };
    timeoutMs?: number;
    maxBodyBytes?: number;
    negativeCacheMaxAge?: number;
  } = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
    this.maxBodyBytes = options.maxBodyBytes ?? FETCH_MAX_BODY_BYTES;
    this.negativeCacheMaxAge = options.negativeCacheMaxAge ??
      NEGATIVE_CACHE_MAX_AGE;
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

  // Both bounds are coerced to canonical integers before they feed either
  // the upstream query or the shared LRU key (chrome-status-lite-3tl): raw
  // values are interpolated into the key, so a non-canonical upstream
  // string ("120&num=1") could append upstream parameters and mint an
  // unbounded number of distinct cache entries. Same hazard and fix as
  // getFeaturesForVersion() below; callers pass upstream-derived strings
  // (src/routes/deprecations.ts) as well as numbers.
  public async getChannels(
    start?: number | string,
    end?: number | string,
  ): Promise<any> {
    if (start == undefined || end == undefined) {
      return this.fetchJson(CHANNELS_PATH);
    }
    const from = Number.parseInt(String(start), 10);
    const to = Number.parseInt(String(end), 10);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new Error(`Invalid channel range: ${start}..${end}`);
    }
    const params = new URLSearchParams({
      start: String(from),
      end: String(to),
    });
    return this.fetchJson(`${CHANNELS_PATH}?${params}`);
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

  // Records a retryable failure in the negative cache (unless the TTL is
  // configured to 0, disabling negative caching) and throws it.
  private fail(path: string, error: Error): never {
    if (this.negativeCacheMaxAge > 0) {
      this.cache.set(
        path,
        new NegativeCacheEntry(error, Date.now() + this.negativeCacheMaxAge),
      );
    }
    throw error;
  }

  private async fetchJson<T>(path: string): Promise<T> {
    let json = this.cache.get(path);

    if (json instanceof NegativeCacheEntry) {
      if (Date.now() < json.expiresAt) {
        throw json.error;
      }
      // Stale negative entry: evict and fall through to a real re-fetch.
      this.cache.del?.(path);
      json = undefined;
    }

    if (json) return json;

    let pending = this.inFlight.get(path);
    if (!pending) {
      pending = this.fetchUpstream(path);
      this.inFlight.set(path, pending);
      // Bookkeeping on both branches so this derived promise never rejects;
      // the shared promise itself still rejects for every awaiting caller.
      const clear = () => this.inFlight.delete(path);
      pending.then(clear, clear);
    }
    return pending;
  }

  // One upstream round-trip for `path`, caching the parsed body on success
  // and a NegativeCacheEntry on retryable failure. Never call directly from
  // outside fetchJson: it must run at most once per path at a time.
  private async fetchUpstream<T>(path: string): Promise<T> {
    const url = CHROMESTATUS_API_ENDPOINT + path;
    // Bound the upstream wait: Deno's fetch has no default timeout and no
    // cancellation reaches us from the incoming request, so an abandoned
    // render keeps reading upstream until this timeout or the body byte
    // cap below fires.
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(url, { signal });
    } catch (err) {
      // Network failure or timeout: retryable, so remember it briefly
      // rather than letting every incoming request re-issue the call.
      this.fail(
        path,
        new Error(
          `Upstream fetch failed for ${path}: ${(err as Error).message}`,
        ),
      );
    }
    if (!response.ok) {
      // 5xx and 429 are upstream/transient and negative-cached; other 4xx
      // reflect the path itself and are not (a 404 must be re-asked, in
      // case the resource appears upstream later).
      const status = response.status;
      const error = new Error(`Upstream HTTP ${status} from ${path}`);
      if (status >= 500 || status === 429) {
        this.fail(path, error);
      }
      throw error;
    }
    const body = response.body;
    if (body == null) {
      this.fail(path, new Error(`Upstream returned no body for ${path}`));
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
      this.fail(
        path,
        new Error(
          `Upstream body read failed for ${path}: ${(err as Error).message}`,
        ),
      );
    }
    let json: T;
    try {
      json = JSON.parse(text);
    } catch (err) {
      this.fail(
        path,
        new Error(
          `Upstream JSON parse failed for ${path}: ${(err as Error).message}`,
        ),
      );
    }
    this.cache.set(path, json);
    return json;
  }
}
