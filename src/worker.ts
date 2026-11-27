import { createHandler, shouldRedirectToCanonical } from "./handler.ts";
import { prefersMarkdown } from "./lib/markdown.ts";
import { D1SnapshotStore } from "./lib/snapshots.ts";
import { ChromeStatusAPI, type EdgeCacheLike } from "./lib/utils.ts";
import { D1WikiTopicStore, refreshStaleWikiTopics } from "./lib/wiki-data.ts";

export interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  /** Set to "true" once chromestatuslite.com custom domain DNS is attached. */
  REDIRECT_WORKERS_DEV?: string;
}

// Read-only routes that are safe to cache at Cloudflare's edge (caches.default)
// as complete HTTP responses. /feature/:id* runs the Worker so lazy snapshot
// capture and recency touch still fire via ctx.waitUntil() (while its upstream
// API payloads stay edge-cached in ChromeStatusAPI).
function isEdgeCacheableGet(pathname: string): boolean {
  if (pathname === "/llms.txt") return true;
  const normalized = pathname === "/index.md"
    ? "/"
    : pathname.endsWith(".md")
    ? pathname.slice(0, -3)
    : pathname;
  if (
    normalized === "/" ||
    normalized === "/about" ||
    normalized === "/deprecations" ||
    normalized === "/diff" ||
    normalized === "/breaking" ||
    normalized === "/origin-trials" ||
    normalized === "/feed.xml" ||
    normalized === "/wiki"
  ) {
    return true;
  }
  return normalized.startsWith("/wiki/") ||
    (!pathname.endsWith(".md") && normalized.startsWith("/api/version/"));
}

// Cloudflare's caches.default does not partition entries by `Vary: Accept`, so
// Markdown-negotiated responses use a distinct internal cache key URL to avoid
// serving Markdown to browsers or HTML to Markdown-requesting agents.
function edgeCacheKey(request: Request): Request {
  const url = new URL(request.url);
  if (!url.pathname.endsWith(".md") && prefersMarkdown(request)) {
    url.searchParams.set("__csl_format", "markdown");
  }
  return new Request(url.toString(), { method: "GET" });
}

function defaultEdgeCache(): EdgeCacheLike | null {
  try {
    return (caches as unknown as { default?: EdgeCacheLike }).default ?? null;
  } catch {
    return null;
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const redirectWorkersDev = env.REDIRECT_WORKERS_DEV === "true";
    const edgeCache = defaultEdgeCache();
    const canEdgeCache = request.method === "GET" &&
      !shouldRedirectToCanonical(url.hostname, redirectWorkersDev) &&
      isEdgeCacheableGet(url.pathname);

    const cacheKey = canEdgeCache ? edgeCacheKey(request) : null;
    if (cacheKey && edgeCache) {
      const cached = await edgeCache.match(cacheKey).catch(() => undefined);
      if (cached) return cached;
    }

    const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise);
    const client = ChromeStatusAPI.forRequest({
      edgeCache,
      waitUntil,
    });
    const store = env.DB ? new D1SnapshotStore(env.DB) : null;
    const wikiStore = env.DB ? new D1WikiTopicStore(env.DB) : null;

    const handler = createHandler({
      client,
      assets: env.ASSETS,
      store,
      wikiStore,
      waitUntil,
      redirectWorkersDev,
    });

    const response = await handler(request);

    if (cacheKey && edgeCache && response.status === 200) {
      const cc = response.headers.get("cache-control") || "";
      if (!cc.includes("no-store") && !cc.includes("private")) {
        ctx.waitUntil(edgeCache.put(cacheKey, response.clone()).catch(() => {}));
      }
    }

    return response;
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const edgeCache = defaultEdgeCache();
    const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise);
    const client = ChromeStatusAPI.forRequest({
      edgeCache,
      waitUntil,
    });

    // Keep the channels/versions list warm in edge cache (1 subrequest).
    await client.getVersions().catch(() => {});

    // Refresh a bounded rotating batch of wiki topics into D1 so each cron run
    // stays safely under the Workers Free plan 50 external subrequests limit.
    if (env.DB) {
      const wikiStore = new D1WikiTopicStore(env.DB);
      const summary = await refreshStaleWikiTopics(client, wikiStore, {
        batchSize: 3,
      });
      console.log(
        JSON.stringify({
          event: "wiki_cron_refresh",
          refreshed: summary.refreshed,
          failed: summary.failed,
        }),
      );
    }
  },
};
