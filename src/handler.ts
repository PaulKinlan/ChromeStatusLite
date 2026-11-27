import { ChromeStatusAPI } from "./lib/utils.ts";
import { renderDiff, renderHistory } from "./routes/feature-history.ts";
import type { SnapshotStore } from "./lib/snapshots.ts";
import type { WikiTopicStore } from "./lib/wiki-data.ts";
import { NO_STORE_CACHE_CONTROL } from "./ui-components/layout.ts";
import index from "./routes/index.ts";
import deprecations from "./routes/deprecations.ts";
import feature from "./routes/feature.ts";
import feed from "./routes/feed.ts";
import apiVersion from "./routes/api-version.ts";
import diff from "./routes/diff.ts";
import breaking from "./routes/breaking.ts";
import originTrials from "./routes/origin-trials.ts";
import wiki from "./routes/wiki.ts";
import wikiTopic from "./routes/wiki-topic.ts";

export type StatusClient =
  & Pick<
    ChromeStatusAPI,
    | "getVersions"
    | "getFeaturesForVersion"
    | "getFeaturesByType"
    | "getChannels"
    | "getFeature"
    | "getFeaturesByQuery"
  >
  & {
    getWebStatusFeature?: ChromeStatusAPI["getWebStatusFeature"];
  };

export interface StaticAssetFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface HandlerOptions {
  client?: StatusClient;
  assets?: StaticAssetFetcher | null;
  store?: SnapshotStore | null;
  wikiStore?: WikiTopicStore | null;
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Redirect *.workers.dev requests to CANONICAL_ORIGIN once custom domain DNS is live. */
  redirectWorkersDev?: boolean;
}

const CANONICAL_ORIGIN = "https://chromestatuslite.com";
const STATIC_CACHE_CONTROL =
  "public, max-age=86400, stale-while-revalidate=604800";

// Pre-compiled route patterns (avoid re-parsing on every request).
const WIKI_TOPIC_PATTERN = new URLPattern({ pathname: "/wiki/:topic" });
const API_VERSION_PATTERN = new URLPattern({
  pathname: "/api/version/:version",
});
const FEATURE_HISTORY_PATTERN = new URLPattern({
  pathname: "/feature/:id/history",
});
const FEATURE_DIFF_PATTERN = new URLPattern({
  pathname: "/feature/:id/diff",
});
const FEATURE_PATTERN = new URLPattern({ pathname: "/feature/:id" });

// Explicit allowlist of static asset paths served from static/ via env.ASSETS.
const STATIC_ASSET_RE =
  /^\/(?:styles\/[\w.-]+|google1bf7ef037ae116eb\.html|robots\.txt|favicon\.svg|speculation-rules\.json)$/;

// Baseline hardening applied to every outgoing response. The markup uses no
// inline scripts or styles and loads assets only from this origin; the only
// exception is the stylesheet's inline data: SVG used for the select arrow.
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
};

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// RFC 9110 9.3.2: a HEAD response is a GET response minus the body —
// same status and headers (chrome-status-lite-rw6). The count drains the
// stream chunk by chunk rather than arrayBuffer()ing the whole body so peak
// memory stays O(1 chunk) (chrome-status-lite-735). A route that answered
// HEAD directly (static asset metadata) has a null body with explicit
// content-length, which is kept as-is.
export async function stripBodyForHead(response: Response): Promise<Response> {
  const headers = new Headers(response.headers);
  if (response.body === null) {
    if (!headers.has("content-length")) headers.set("content-length", "0");
  } else {
    let bytes = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    headers.set("content-length", String(bytes));
  }
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function shouldRedirectToCanonical(
  hostname: string,
  redirectWorkersDev = false,
): boolean {
  if (hostname.endsWith(".deno.net") || hostname.endsWith(".deno.dev")) {
    return true;
  }
  if (
    redirectWorkersDev &&
    (hostname.endsWith(".workers.dev") || hostname.endsWith(".pages.dev"))
  ) {
    return true;
  }
  return false;
}

// Constructing the handler never starts a listener or fetches upstream data.
export function createHandler(
  options: HandlerOptions = {},
): (request: Request) => Promise<Response> {
  const client = options.client ?? ChromeStatusAPI.getInstance();
  const assets = options.assets ?? null;
  const store = options.store ?? null;
  const wikiStore = options.wikiStore ?? null;
  const waitUntil = options.waitUntil;
  const redirectWorkersDev = options.redirectWorkersDev ?? false;

  const route = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (shouldRedirectToCanonical(url.hostname, redirectWorkersDev)) {
      return new Response(null, {
        status: 301,
        headers: {
          location: `${CANONICAL_ORIGIN}${url.pathname}${url.search}`,
        },
      });
    }

    // Read-only site: only GET/HEAD dispatch. /api/version/:version handles its
    // own OPTIONS preflight; every other verb gets 405 with Allow.
    const isApiVersion = /^\/api\/version\/[^/]+$/.test(url.pathname);
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      !(isApiVersion && request.method === "OPTIONS")
    ) {
      return new Response(null, {
        status: 405,
        headers: {
          allow: isApiVersion ? "GET, HEAD, OPTIONS" : "GET, HEAD",
          "cache-control": NO_STORE_CACHE_CONTROL,
        },
      });
    }

    if (url.pathname === "/") return index(request, client);
    if (url.pathname === "/deprecations") return deprecations(request, client);
    if (url.pathname === "/diff") return diff(request, client);
    if (url.pathname === "/breaking") return breaking(request, client);
    if (url.pathname === "/origin-trials") return originTrials(request, client);
    if (url.pathname === "/feed.xml") return feed(request, client);
    if (url.pathname === "/wiki") {
      return wiki(request, client, wikiStore, waitUntil);
    }
    const wikiMatch = WIKI_TOPIC_PATTERN.exec(url);
    if (wikiMatch) {
      return wikiTopic(request, wikiMatch, client, wikiStore, waitUntil);
    }
    const apiVersionMatch = API_VERSION_PATTERN.exec(url);
    if (apiVersionMatch) return apiVersion(request, apiVersionMatch, client);
    const historyMatch = FEATURE_HISTORY_PATTERN.exec(url);
    if (historyMatch) {
      return renderHistory(request, historyMatch, client, store, waitUntil);
    }
    const diffMatch = FEATURE_DIFF_PATTERN.exec(url);
    if (diffMatch) {
      return renderDiff(request, diffMatch, client, store, waitUntil);
    }
    const featureMatch = FEATURE_PATTERN.exec(url);
    if (featureMatch) {
      return feature(request, featureMatch, client, store, waitUntil);
    }

    // Only explicit static assets are served; unknown paths and encoded
    // traversals 404 before touching the asset binding.
    if (!STATIC_ASSET_RE.test(url.pathname) || !assets) {
      return new Response("Not found", {
        status: 404,
        headers: { "cache-control": NO_STORE_CACHE_CONTROL },
      });
    }

    try {
      let assetRes = await assets.fetch(request);
      if (!assetRes.ok) {
        return new Response("Not found", {
          status: 404,
          headers: { "cache-control": NO_STORE_CACHE_CONTROL },
        });
      }
      // If an ASSETS binding answers HEAD with a null body and omits
      // content-length (e.g. Miniflare local asset router), fall back to a
      // GET fetch so stripBodyForHead can compute the byte-accurate length.
      if (
        request.method === "HEAD" &&
        assetRes.body === null &&
        !assetRes.headers.has("content-length")
      ) {
        const getRes = await assets.fetch(
          new Request(request.url, { method: "GET", headers: request.headers }),
        );
        if (getRes.ok) assetRes = getRes;
      }
      const headers = new Headers(assetRes.headers);
      headers.set("cache-control", STATIC_CACHE_CONTROL);
      if (url.pathname === "/speculation-rules.json") {
        headers.set(
          "content-type",
          "application/speculationrules+json; charset=utf-8",
        );
      }
      return new Response(assetRes.body, {
        status: assetRes.status,
        statusText: assetRes.statusText,
        headers,
      });
    } catch {
      return new Response("Not found", {
        status: 404,
        headers: { "cache-control": NO_STORE_CACHE_CONTROL },
      });
    }
  };

  return async (request: Request): Promise<Response> => {
    let response: Response;
    try {
      response = await route(request);
      // Draining a dynamic HEAD body can reject after the route has returned.
      if (request.method === "HEAD") {
        response = await stripBodyForHead(response);
      }
    } catch (error) {
      console.error(
        `Unhandled route error: ${request.method} ${
          new URL(request.url).pathname
        }`,
        error,
      );
      response = new Response("Internal Server Error", {
        status: 500,
        headers: { "cache-control": NO_STORE_CACHE_CONTROL },
      });
      if (request.method === "HEAD") {
        response = await stripBodyForHead(response);
      }
    }
    return withSecurityHeaders(response);
  };
}
