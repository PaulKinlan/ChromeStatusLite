import { StripStream } from "../stream-utils.ts";
import LRU from "https://deno.land/x/lru_cache@6.0.0-deno.4/mod.ts";

const CHROMESTATUS_API_ENDPOINT = "https://chromestatus.com";
const CACHE_MAX_ITEMS = 100;
const CACHE_MAX_AGE = 1000 * 60 * 60; // 1 hour.

export class ChromeStatusAPI {
  private static instance: null | ChromeStatusAPI = null;

  private cache: Pick<LRU<string, any>, "get" | "set">;
  private fetcher: typeof fetch;

  constructor(options: {
    fetcher?: typeof fetch;
    cache?: Pick<LRU<string, any>, "get" | "set">;
  } = {}) {
    this.fetcher = options.fetcher ?? fetch;
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
    return this.fetchJson(`/api/v0/channels${queryString}`);
  }

  // Returns features for a milestone grouped by status, e.g.
  // { "Enabled by default": [...], "Origin trial": [...], ... }.
  // The old `/features_v2.json` no longer carries a usable `milestone`
  // field, so we use the milestone query on the v0 API which groups
  // features by type server-side.
  public async getFeaturesForVersion(version: number): Promise<any> {
    const data = await this.fetchJson(
      `/api/v0/features?milestone=${version}`
    );
    return (data as any).features_by_type || {};
  }

  public async getVersions(): Promise<any> {
    const versionData = await this.getChannels();
    const lastVersion = Number.parseInt(versionData.dev.version);

    return [...Array(lastVersion).keys()].reverse();
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

  private async fetchJson<T>(path: string): Promise<T> {
    let json = this.cache.get(path);

    if (!json) {
      console.log(CHROMESTATUS_API_ENDPOINT + path);
      const response = await this.fetcher(CHROMESTATUS_API_ENDPOINT + path);
      if (!response.ok) {
        throw new Error(`Upstream HTTP ${response.status} from ${path}`);
      }
      const strippedResponse = new Response(response.body?.pipeThrough(new StripStream()));
      const text = await strippedResponse.text();
      json = JSON.parse(text);
      this.cache.set(path, json);
    }
    return json;
  }
}
