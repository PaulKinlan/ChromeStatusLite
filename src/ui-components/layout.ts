import template from "../flora.ts";
import nav from "./nav.ts";

// Default Cache-Control for healthy dynamic HTML pages: short browser cache
// plus edge caching and stale-while-revalidate so repeat visitors get instant
// edge responses while upstream refreshes happen in the background.
export const HTML_CACHE_CONTROL =
  "public, max-age=300, s-maxage=900, stale-while-revalidate=3600";
export const HISTORY_CACHE_CONTROL =
  "public, max-age=60, stale-while-revalidate=300";
export const NO_STORE_CACHE_CONTROL = "no-store";

export interface PageOptions {
  title: unknown;
  canonical: string;
  description?: string;
  currentPath?: string;
  extraStylesheets?: string[];
  body: unknown;
}

export interface HtmlResponseOptions extends PageOptions {
  status?: number;
  cacheControl?: string;
  headers?: Record<string, string>;
}

export function renderPage({
  title,
  canonical,
  description,
  currentPath = "",
  extraStylesheets = [],
  body,
}: PageOptions): Promise<ReadableStream<Uint8Array>> {
  return template`<!doctype html>
<html lang="en">

<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${description ? template`<meta name="description" content="${description}">` : template``}
  <title>${title}</title>
  <link rel="canonical" href="${canonical}">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="alternate" type="application/rss+xml" title="Chrome Status Lite" href="/feed.xml">
  <link rel="stylesheet" href="/styles/index.css">
  ${extraStylesheets.map((href) => template`<link rel="stylesheet" href="${href}">`)}
</head>

<body>
  ${nav(currentPath)}
  <main id="main">
  ${body}
  </main>
</body>

</html>`;
}

export async function htmlResponse({
  status = 200,
  cacheControl,
  headers = {},
  ...page
}: HtmlResponseOptions): Promise<Response> {
  const stream = await renderPage(page);
  const resolvedCache = cacheControl ??
    (status === 200 ? HTML_CACHE_CONTROL : NO_STORE_CACHE_CONTROL);
  const responseHeaders: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": resolvedCache,
    vary: "Accept",
    ...headers,
  };
  if (status === 200 && resolvedCache !== NO_STORE_CACHE_CONTROL) {
    // Progressive-enhancement Speculation Rules delivered via HTTP header so
    // HTML stays script-free and CSP remains strict (default-src 'self').
    responseHeaders["speculation-rules"] = '"/speculation-rules.json"';
  }
  return new Response(stream, { status, headers: responseHeaders });
}
