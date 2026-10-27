import { join } from "https://deno.land/std@0.152.0/path/mod.ts";
import { contentType } from "https://deno.land/std@0.152.0/media_types/mod.ts";
import { ChromeStatusAPI } from "./lib/utils.ts";
import { renderHistory, renderDiff } from "./routes/feature-history.ts";
import type { SnapshotStore } from "./lib/snapshots.ts";
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

export type StatusClient = Pick<ChromeStatusAPI,
  "getVersions" | "getFeaturesForVersion" | "getFeaturesByType" | "getChannels" | "getFeature" | "getFeaturesByQuery">;

const CANONICAL_ORIGIN = "https://chromestatuslite.com";

// Baseline hardening applied to every outgoing response. The markup uses no
// inline scripts or styles and loads assets only from this origin; the only
// exception is the stylesheet's inline data: SVG used for the select arrow.
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
};

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Constructing the handler never starts a listener or fetches upstream data.
// Tests supply a fresh client; production keeps the shared cached singleton.
export function createHandler(
  client: StatusClient = ChromeStatusAPI.getInstance(),
  staticRoot = join(Deno.cwd(), "static"),
  store: SnapshotStore | null = null,
): (request: Request) => Promise<Response> {
  const route = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.hostname.endsWith(".deno.net") || url.hostname.endsWith(".deno.dev")) {
      return new Response(null, {
        status: 301,
        headers: { location: `${CANONICAL_ORIGIN}${url.pathname}${url.search}` },
      });
    }

    if (url.pathname === "/") return index(request, client);
    if (url.pathname === "/deprecations") return deprecations(request, client);
    if (url.pathname === "/diff") return diff(request, client);
    if (url.pathname === "/breaking") return breaking(request, client);
    if (url.pathname === "/origin-trials") return originTrials(request, client);
    if (url.pathname === "/feed.xml") return feed(request, client);
    if (url.pathname === "/wiki") return wiki(request, client);
    const wikiMatch = new URLPattern({ pathname: "/wiki/:topic" }).exec(url);
    if (wikiMatch) return wikiTopic(request, wikiMatch, client);
    const apiVersionMatch = new URLPattern({ pathname: "/api/version/:version" }).exec(url);
    if (apiVersionMatch) return apiVersion(request, apiVersionMatch, client);
    const historyMatch = new URLPattern({ pathname: "/feature/:id/history" }).exec(url);
    if (historyMatch) return renderHistory(request, historyMatch, client, store);
    const diffMatch = new URLPattern({ pathname: "/feature/:id/diff" }).exec(url);
    if (diffMatch) return renderDiff(request, diffMatch, client, store);
    const match = new URLPattern({ pathname: "/feature/:id" }).exec(url);
    if (match) return feature(request, match, client, store);

    // Only explicit static assets are served; do not let URL path traversal
    // escape the static root or turn a missing route into a file read.
    if (!/^\/(?:scripts|styles)\/[\w.-]+$/.test(url.pathname) &&
        url.pathname !== "/google1bf7ef037ae116eb.html") {
      return new Response("Not found", { status: 404 });
    }
    try {
      const data = await Deno.readFile(join(staticRoot, url.pathname));
      return new Response(data, {
        status: 200,
        headers: { "content-type": contentType(url.pathname.slice(url.pathname.lastIndexOf("."))) || "application/octet-stream" },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  };
  return async (request: Request): Promise<Response> => withSecurityHeaders(await route(request));
}
