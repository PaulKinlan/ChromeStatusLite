import { StripStream } from "../stream-utils.ts";
import { type CacheLike, TTLCache } from "./lru.ts";

// Parses an upstream stable_date, or null when the value is absent or
// unparseable. Callers must validate before formatting: Date.toUTCString()
// renders an Invalid Date as "Invalid Date" rather than throwing.
export function parseStableDate(value: unknown): Date | null {
  if (typeof value !== "string" || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Renders an upstream stable_date as UTC "yyyy-MM-dd", or null when the value
// is absent or unparseable. Always uses UTC so rendered dates never drift by
// a day across developer or edge timezones.
export function formatStableDate(value: unknown): string | null {
  const date = parseStableDate(value);
  return date ? date.toISOString().slice(0, 10) : null;
}

const CHROMESTATUS_API_ENDPOINT = "https://chromestatus.com";
const WEBSTATUS_API_ENDPOINT = "https://api.webstatus.dev";
// Single-sourced because it is also the cache key getVersions() must evict
// when it finds the cached body malformed (chrome-status-lite-8uv).
const CHANNELS_PATH = "/api/v0/channels";
const CACHE_MAX_ITEMS = 100;
const CACHE_MAX_AGE = 1000 * 60 * 60; // 1 hour.
const EDGE_CACHE_TTL_SECONDS = 3600; // 1 hour in Cloudflare Cache API.
const WEBSTATUS_CACHE_MAX_AGE = 1000 * 60 * 60 * 6; // 6 hours.
const WEBSTATUS_EDGE_TTL_SECONDS = 6 * 3600;
const WEBSTATUS_TIMEOUT_MS = 5_000;
const WEBSTATUS_MAX_BODY_BYTES = 512 * 1024; // 512 KB.
// Upstream bounds: chromestatus.com has accepted connections and then stalled
// in the past, so without these a single hung upstream parks every awaiting
// route handler forever.
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_BODY_BYTES = 16 * 1024 * 1024; // 16 MB.
// How long a retryable upstream failure (timeout, 5xx, 429, unreadable or
// unparseable body) is remembered before the path is retried upstream.
const NEGATIVE_CACHE_MAX_AGE = 10_000; // 10 s.
// Sanity bound for the dev-channel version: real Chrome milestones are three
// digits, so anything past this is malformed upstream data.
const MAX_PLAUSIBLE_VERSION = 2000;

export const MAX_FEATURE_ID_DIGITS = 16;
const FEATURE_ID_RE = new RegExp(`^\\d{1,${MAX_FEATURE_ID_DIGITS}}$`);

const FEATURE_FETCH_BURST = 30;
const FEATURE_FETCH_REFILL_PER_SECOND = 1;
const MILESTONE_PARAM_RE = new RegExp(
  `^\\d{1,${String(MAX_PLAUSIBLE_VERSION).length}}$`,
);
const WEB_FEATURE_ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;

// A client-supplied feature id is valid only when it is a digit string no
// longer than a real chromestatus id. Longer values (and anything
// non-numeric) 404 at the seam instead of flowing into an oversized
// upstream path and LRU/store key.
export function isValidFeatureId(id: unknown): id is string {
  return typeof id === "string" && FEATURE_ID_RE.test(id);
}

// A web-features / webstatus.dev identifier slug (e.g. "anchor-positioning").
export function isValidWebFeatureId(id: unknown): id is string {
  return typeof id === "string" && WEB_FEATURE_ID_RE.test(id);
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

export interface WebStatusFeature {
  feature_id?: string;
  name?: string;
  baseline?: {
    status?: "widely" | "newly" | "limited" | string;
    low_date?: string;
    high_date?: string;
  };
  browser_implementations?: Record<
    string,
    { status?: string; version?: string; date?: string }
  >;
}

export interface EdgeCacheLike {
  match(request: Request | string): Promise<Response | undefined>;
  put(request: Request | string, response: Response): Promise<void>;
  delete?(request: Request | string): Promise<boolean>;
}

// Fails the stream once more than `limit` bytes have flowed through it, so a
// never-ending upstream body cannot grow the buffered text without bound.
function byteLimitStream(
  limit: number,
): TransformStream<Uint8Array, Uint8Array> {
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
// entry, never an upstream body.
class NegativeCacheEntry {
  constructor(
    readonly error: Error,
    readonly expiresAt: number,
  ) {}
}

// Raised when the aggregate feature-detail fetch budget is exhausted
// (chrome-status-lite-d9s). Carries the wait so the route can answer 429
// with an honest Retry-After rather than reporting an upstream outage.
export class UpstreamFetchBudgetError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(
      `Feature detail fetch budget exhausted; retry in ${retryAfterMs}ms`,
    );
    this.name = "UpstreamFetchBudgetError";
  }
}

// A token bucket over *uncached* feature-detail upstream fetches. Refill is
// computed from the clock on demand, so an idle client holds no timer and a
// burst is cheap: `take()` either spends a token or throws with the wait.
export class FeatureFetchBudget {
  private tokens: number;
  private last: number;

  constructor(
    private readonly burst: number,
    private readonly refillPerMs: number,
    private readonly now: () => number,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  public take(): void {
    const at = this.now();
    const elapsed = Math.max(0, at - this.last);
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.refillPerMs);
    this.last = at;
    if (this.tokens < 1) {
      throw new UpstreamFetchBudgetError(
        Math.ceil((1 - this.tokens) / this.refillPerMs),
      );
    }
    this.tokens -= 1;
  }
}

// Isolate-level plain-data state shared across per-request Worker clients.
// Holds ONLY plain parsed JSON objects and numbers — never Request/Response
// streams or in-flight fetch() Promises — so Cloudflare Workers isolates can
// safely reuse warm data across requests without triggering cross-request I/O
// errors.
const sharedJsonCache = new TTLCache<string, unknown>({
  max: CACHE_MAX_ITEMS,
  maxAge: CACHE_MAX_AGE,
});
const sharedFeatureBudget = new FeatureFetchBudget(
  FEATURE_FETCH_BURST,
  FEATURE_FETCH_REFILL_PER_SECOND / 1000,
  Date.now,
);

export interface ChromeStatusAPIOptions {
  fetcher?: typeof fetch;
  cache?: CacheLike<string, unknown>;
  edgeCache?: EdgeCacheLike | null;
  waitUntil?: (promise: Promise<unknown>) => void;
  timeoutMs?: number;
  maxBodyBytes?: number;
  negativeCacheMaxAge?: number;
  featureBudget?: FeatureFetchBudget;
  featureFetchBudget?: { burst?: number; refillPerSecond?: number };
  now?: () => number;
}

export class ChromeStatusAPI {
  private static instance: null | ChromeStatusAPI = null;

  private cache: CacheLike<string, unknown>;
  private edgeCache: EdgeCacheLike | null;
  private waitUntil?: (promise: Promise<unknown>) => void;
  private fetcher: typeof fetch;
  private timeoutMs: number;
  private maxBodyBytes: number;
  private negativeCacheMaxAge: number;
  private now: () => number;
  private featureBudget: FeatureFetchBudget;
  // Coalesces concurrent misses for the same path within this client instance.
  // In Cloudflare Workers, `forRequest()` creates one lightweight client per
  // incoming request so in-flight Promises are never shared across requests.
  private inFlight: Map<string, Promise<unknown>> = new Map();

  constructor(options: ChromeStatusAPIOptions = {}) {
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.edgeCache = options.edgeCache ?? null;
    this.waitUntil = options.waitUntil;
    this.timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
    this.maxBodyBytes = options.maxBodyBytes ?? FETCH_MAX_BODY_BYTES;
    this.negativeCacheMaxAge = options.negativeCacheMaxAge ??
      NEGATIVE_CACHE_MAX_AGE;
    this.now = options.now ?? Date.now;
    this.featureBudget = options.featureBudget ??
      new FeatureFetchBudget(
        options.featureFetchBudget?.burst ?? FEATURE_FETCH_BURST,
        (options.featureFetchBudget?.refillPerSecond ??
          FEATURE_FETCH_REFILL_PER_SECOND) / 1000,
        this.now,
      );
    this.cache = options.cache ?? new TTLCache<string, unknown>({
      max: CACHE_MAX_ITEMS,
      maxAge: CACHE_MAX_AGE,
      now: this.now,
    });
  }

  public static getInstance(): ChromeStatusAPI {
    if (ChromeStatusAPI.instance == null) {
      ChromeStatusAPI.instance = new ChromeStatusAPI();
    }
    return ChromeStatusAPI.instance;
  }

  // Creates a Cloudflare Workers per-request client that shares the warm
  // isolate's plain-JSON L1 cache and token bucket, wires Cloudflare's L2
  // Cache API (`caches.default`), and keeps in-flight fetch promises strictly
  // scoped to this single request.
  public static forRequest(options: {
    edgeCache?: EdgeCacheLike | null;
    waitUntil?: (promise: Promise<unknown>) => void;
    fetcher?: typeof fetch;
  } = {}): ChromeStatusAPI {
    return new ChromeStatusAPI({
      cache: sharedJsonCache,
      featureBudget: sharedFeatureBudget,
      edgeCache: options.edgeCache ?? null,
      waitUntil: options.waitUntil,
      fetcher: options.fetcher,
    });
  }

  // Both bounds are coerced to canonical integers before they feed either
  // the upstream query or the shared LRU key (chrome-status-lite-3tl).
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
  public async getFeaturesForVersion(version: number | string): Promise<any> {
    const milestone = Number.parseInt(String(version), 10);
    if (!Number.isFinite(milestone)) {
      throw new Error(`Invalid milestone: ${version}`);
    }
    const params = new URLSearchParams({ milestone: String(milestone) });
    const data = await this.fetchJson<any>(`/api/v0/features?${params}`);
    return data?.features_by_type || {};
  }

  public async getVersions(): Promise<number[]> {
    const versionData = await this.getChannels();
    const rawVersion = versionData?.dev?.version;
    const lastVersion = Number.parseInt(String(rawVersion), 10);
    if (
      !Number.isFinite(lastVersion) || lastVersion <= 0 ||
      lastVersion > MAX_PLAUSIBLE_VERSION
    ) {
      this.cache.del?.(CHANNELS_PATH);
      if (this.edgeCache?.delete) {
        const del = this.edgeCache.delete(
          new Request(CHROMESTATUS_API_ENDPOINT + CHANNELS_PATH),
        ).catch(() => false);
        this.waitUntil?.(del);
      }
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

  // Full-text search over all features. Returns { total_count, features }.
  public async getFeaturesByQuery(
    query: string,
    options: { num?: number; start?: number } = {},
  ): Promise<any> {
    const params = new URLSearchParams({ q: query });
    if (options.num !== undefined) params.set("num", String(options.num));
    if (options.start !== undefined) params.set("start", String(options.start));
    return this.fetchJson(`/api/v0/features?${params}`);
  }

  // Fetches a single feature's full detail by id. Charged against the feature
  // fetch budget only on an L1 + L2 cache miss.
  public async getFeature(id: string | number): Promise<any> {
    return this.fetchJson(
      `/api/v0/features/${id}`,
      () => this.featureBudget.take(),
    );
  }

  // Lightweight Baseline status lookup via api.webstatus.dev. Always fails
  // open (returns null) so an outage on webstatus.dev never breaks a feature
  // page, and validates the slug strictly before building the URL.
  public async getWebStatusFeature(
    webFeatureId: string,
  ): Promise<WebStatusFeature | null> {
    if (!isValidWebFeatureId(webFeatureId)) return null;
    const cacheKey = `webstatus:${webFeatureId}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached as WebStatusFeature | null;
    }

    const url = `${WEBSTATUS_API_ENDPOINT}/v1/features/${webFeatureId}`;
    const edgeReq = new Request(url);
    if (this.edgeCache) {
      const hit = await this.edgeCache.match(edgeReq).catch(() => undefined);
      if (hit && hit.ok) {
        try {
          const parsed = (await hit.json()) as WebStatusFeature;
          this.cache.set(cacheKey, parsed, WEBSTATUS_CACHE_MAX_AGE);
          return parsed;
        } catch {
          // fall through to origin fetch
        }
      }
    }

    try {
      const response = await this.fetcher(url, {
        signal: AbortSignal.timeout(WEBSTATUS_TIMEOUT_MS),
      });
      if (!response.ok || !response.body) {
        if (response.status === 404) {
          this.cache.set(cacheKey, null, WEBSTATUS_CACHE_MAX_AGE);
        }
        return null;
      }
      const limited = new Response(
        response.body.pipeThrough(byteLimitStream(WEBSTATUS_MAX_BODY_BYTES)),
      );
      const text = await limited.text();
      const parsed = JSON.parse(text) as WebStatusFeature;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      this.cache.set(cacheKey, parsed, WEBSTATUS_CACHE_MAX_AGE);
      this.putEdgeCache(edgeReq, text, WEBSTATUS_EDGE_TTL_SECONDS);
      return parsed;
    } catch {
      return null;
    }
  }

  private putEdgeCache(request: Request, jsonText: string, ttlSeconds: number): void {
    if (!this.edgeCache) return;
    const cachedResponse = new Response(jsonText, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${ttlSeconds}`,
      },
    });
    const write = this.edgeCache.put(request, cachedResponse).catch(() => {});
    if (this.waitUntil) {
      this.waitUntil(write);
    }
  }

  // Records a retryable failure in the negative cache (unless the TTL is
  // configured to 0, disabling negative caching) and throws it.
  private fail(path: string, error: Error): never {
    if (this.negativeCacheMaxAge > 0) {
      this.cache.set(
        path,
        new NegativeCacheEntry(error, this.now() + this.negativeCacheMaxAge),
      );
    }
    throw error;
  }

  // `charge`, when supplied, is spent immediately before the upstream call
  // and never on an L1 hit, L2 edge hit, in-flight hit or live negative entry.
  private async fetchJson<T>(
    path: string,
    charge?: () => void,
  ): Promise<T> {
    let json = this.cache.get(path);

    if (json instanceof NegativeCacheEntry) {
      if (this.now() < json.expiresAt) {
        throw json.error;
      }
      this.cache.del?.(path);
      json = undefined;
    }

    if (json !== undefined) return json as T;

    let pending = this.inFlight.get(path) as Promise<T> | undefined;
    if (!pending) {
      if (!this.edgeCache) {
        // Charge synchronously before registering in-flight when there is no
        // async L2 lookup, so a budget refusal leaves no entry behind.
        charge?.();
        pending = this.fetchUpstream<T>(path);
      } else {
        pending = this.fetchWithEdgeCache<T>(path, charge);
      }
      this.inFlight.set(path, pending);
      const clear = () => this.inFlight.delete(path);
      pending.then(clear, clear);
    }
    return pending;
  }

  private async fetchWithEdgeCache<T>(
    path: string,
    charge?: () => void,
  ): Promise<T> {
    const edgeReq = new Request(CHROMESTATUS_API_ENDPOINT + path);
    const hit = await this.edgeCache?.match(edgeReq).catch(() => undefined);
    if (hit && hit.ok) {
      try {
        const parsed = (await hit.json()) as T;
        this.cache.set(path, parsed);
        return parsed;
      } catch {
        // Corrupt edge cache entry: fall through to fresh upstream fetch.
      }
    }
    charge?.();
    return this.fetchUpstream<T>(path);
  }

  // One upstream round-trip for `path`, caching the parsed body on success
  // and a NegativeCacheEntry on retryable failure.
  private async fetchUpstream<T>(path: string): Promise<T> {
    const url = CHROMESTATUS_API_ENDPOINT + path;
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(url, { signal });
    } catch (err) {
      this.fail(
        path,
        new Error(
          `Upstream fetch failed for ${path}: ${(err as Error).message}`,
        ),
      );
    }
    if (!response.ok) {
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
      json = JSON.parse(text) as T;
    } catch (err) {
      this.fail(
        path,
        new Error(
          `Upstream JSON parse failed for ${path}: ${(err as Error).message}`,
        ),
      );
    }
    this.cache.set(path, json);
    this.putEdgeCache(new Request(url), text, EDGE_CACHE_TTL_SECONDS);
    return json;
  }
}
