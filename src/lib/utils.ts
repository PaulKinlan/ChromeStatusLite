import { StripStream } from "../stream-utils.ts";
import LRU from "https://deno.land/x/lru_cache@6.0.0-deno.4/mod.ts";

const CHROMESTATUS_API_ENDPOINT = "https://chromestatus.com";
const CACHE_MAX_ITEMS = 100;
const CACHE_MAX_AGE = 1000 * 60 * 60; // 1 hour.

export class ChromeStatusAPI {
  private static instance: null | ChromeStatusAPI = null;

  private cache = new LRU<string, any>({
    max: CACHE_MAX_ITEMS,
    maxAge: CACHE_MAX_AGE,
  });

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

  public async getFeaturesForVersion(version?: number): Promise<any> {
    let queryString = "";
    if (version != undefined) {
      queryString = `?milestone=${version}`;
    }
    return ((await this.fetchJson(`/features_v2.json`)) as any[]).filter(
      (feature) => {
        feature.milestone != version;
      }
    );
  }

  public async getVersions(): Promise<any> {
    const versionData = await this.getChannels();
    const lastVersion = Number.parseInt(versionData.dev.version);

    return [...Array(lastVersion).keys()].reverse();
  }

  public async getFeaturesByType(type: number): Promise<any> {
    return this.fetchJson(`/features_v2.json?q=feature_type=${type}`);
  }

  public async getFeatures(): Promise<any> {
    return this.getFeaturesForVersion();
  }

  private async fetchJson<T>(path: string): Promise<T> {
    let json = this.cache.get(path);

    if (!json) {
      console.log(CHROMESTATUS_API_ENDPOINT + path);
      let response = await fetch(CHROMESTATUS_API_ENDPOINT + path);
      (response = new Response(response.body?.pipeThrough(new StripStream()))),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        };

      const text = await response.text();
      json = JSON.parse(text);
      this.cache.set(path, json);
    }
    return json;
  }
}
