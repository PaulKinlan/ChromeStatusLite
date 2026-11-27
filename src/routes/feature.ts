import template from "../flora.ts";
import type { StatusClient } from "../handler.ts";
import linkify from "../lib/linkify.ts";
import { sanitizeUrl } from "../lib/url.ts";
import { captureSnapshot, type SnapshotStore } from "../lib/snapshots.ts";
import {
  isValidFeatureId,
  isValidWebFeatureId,
  UpstreamFetchBudgetError,
  type WebStatusFeature,
} from "../lib/utils.ts";

import {
  htmlResponse,
  NO_STORE_CACHE_CONTROL,
} from "../ui-components/layout.ts";
import { renderFeatureMetadata } from "../ui-components/feature-metadata.ts";

// Renders a single browser's standards position / view, if present.
const renderView = (label: string, browser: any) => {
  const view = browser?.view;
  if (!view || (!view.text && !view.url)) {
    return template``;
  }
  const text = view.url
    ? view.text || "No signal"
    : linkify(view.text || "No signal");
  const url = sanitizeUrl(view.url);
  return template`<li>${label}: ${
    url ? template`<a href="${url}">${text}</a>` : template`${text}`
  }${view.notes ? template` — ${linkify(view.notes)}` : template``}</li>`;
};

// Renders a list of links (docs, samples, explainers).
const renderLinks = (label: string, links: unknown) => {
  if (!Array.isArray(links) || links.length === 0) {
    return template``;
  }
  const safeLinks = links
    .map((link) => sanitizeUrl(String(link)))
    .filter((link): link is string => link !== null);
  if (safeLinks.length === 0) {
    return template``;
  }
  return template`<p>${label}: ${
    safeLinks.map((link) => template`<a href="${link}">${link}</a> `)
  }</p>`;
};

const WPT_PATH_RE = /\b([a-z0-9-]+(?:\/[a-z0-9_*.-]+)+)\b/gi;

const WPT_TOP_DIRS = new Set([
  "css", "html", "dom", "infrastructure", "webmessaging", "workers",
  "shadow-dom", "xhr", "fetch", "svg", "encoding", "ai", "fedcm",
  "content-security-policy", "external", "wpt", "websockets",
  "webassembly", "webstorage", "webtransport", "webvtt", "webxr",
  "webaudio", "webgl", "webgpu", "webcodecs", "webshare", "web-bluetooth",
  "web-share", "web-animations", "webrtc", "service-workers", "storage",
  "storage-access", "streams", "screen-wake-lock", "screen-orientation",
  "selection", "speech-api", "secure-contexts", "scroll-animations",
  "scroll-to-text-fragment", "resource-timing", "resize-observer",
  "referrer-policy", "reporting", "requestidlecallback",
  "picture-in-picture", "pointerevents", "pointerlock", "page-visibility",
  "page-lifecycle", "permissions", "permissions-policy", "push-api",
  "performance-timeline", "preload", "presentation-api", "portals",
  "paint", "navigation", "navigation-timing", "notifications",
  "network-error-logging", "user-timing", "uievents", "touch-events",
  "trusted-types", "vibration", "video-rvfc", "visual-viewport",
  "wai-aria", "wake-lock", "battery-status", "clipboard", "compression",
  "cookie-store", "credential-management", "fullscreen", "geolocation",
  "hr-time", "indexeddb", "intersection-observer", "keyboard-lock",
  "keyboard-map", "largest-contentful-paint", "layout-instability",
  "longtask-timing", "orientation-event", "orientation-sensor",
  "payment-handler", "payment-request", "periodic-background-sync",
  "priority-hints", "private-click-measurement", "remote-playback",
  "sanitizer", "server-timing", "shape-detection", "sms",
  "subresource-integrity", "urlpattern", "eventsource",
  "file-system-access", "gamepad", "generic-sensor", "idle-detection",
  "input-events", "mathml", "native-file-system", "old-clip-path",
  "background-fetch", "badging", "beacon", "clear-site-data",
  "content-index", "contact-picker", "digital-credentials",
  "document-picture-in-picture", "mediasession", "shared-storage",
  "speculation-rules", "accessibility",
]);

const trimWptPath = (p: string): string =>
  p.replace(/\*.*$/, "")
    .replace(/\/tentative$/i, "")
    .replace(/(\.[a-z0-9]+)+$/i, "")
    .replace(/[\/.-]+$/, "");

const slugify = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const wptQueryFromDescr = (descr: string): string | null => {
  const qParam = descr.match(/[?&]q=([^&\s]+)/);
  if (qParam) {
    try {
      return decodeURIComponent(qParam[1]);
    } catch {
      return qParam[1];
    }
  }
  for (const match of descr.matchAll(WPT_PATH_RE)) {
    const raw = match[1];
    if (/\/results\//i.test(raw)) {
      const q = trimWptPath(raw.replace(/^.*\/results\//i, ""));
      if (q) return q;
    } else if (/\/(?:blob|tree)\/[^/]+\//i.test(raw)) {
      const q = trimWptPath(raw.replace(/^.*\/(?:blob|tree)\/[^/]+\//i, ""));
      if (q) return q;
    } else if (/^fyi\//i.test(raw)) {
      const segs = trimWptPath(raw.slice(4)).split("/");
      const q = (segs.length > 2 ? segs.slice(0, 2) : segs).join("/");
      if (q) return q;
    } else if (/^external\/wpt\//i.test(raw)) {
      const q = trimWptPath(raw.slice("external/wpt/".length));
      if (q) return q;
    }
  }

  for (const match of descr.matchAll(WPT_PATH_RE)) {
    const segs = match[1].split("/");
    if (!WPT_TOP_DIRS.has(segs[0].toLowerCase())) continue;
    const q = trimWptPath([segs[0].toLowerCase(), ...segs.slice(1)].join("/"));
    if (q) return q;
  }
  return null;
};

const wptResultsUrl = (feature: any, name: string): string => {
  const descr = typeof feature?.wpt_descr === "string"
    ? feature.wpt_descr
    : "";
  const q = wptQueryFromDescr(descr) ?? slugify(name);
  return `https://wpt.fyi/results/?q=${encodeURIComponent(q)}`;
};

const SHOWCASE_FEATURES = "https://chrome-platform-showcase.com/features";
const GENDN_FEATURES = "https://gendn.dev/features";

const renderBaselineStatus = (
  webFeatureId: string | null,
  webStatus: WebStatusFeature | null,
) => {
  if (!webFeatureId || !webStatus?.baseline?.status) return template``;
  const status = webStatus.baseline.status;
  const badge = status === "widely"
    ? {
      cls: "baseline-widely",
      label: webStatus.baseline.high_date
        ? `Baseline Widely available (since ${webStatus.baseline.high_date})`
        : "Baseline Widely available",
    }
    : status === "newly"
    ? {
      cls: "baseline-newly",
      label: webStatus.baseline.low_date
        ? `Baseline Newly available (since ${webStatus.baseline.low_date})`
        : "Baseline Newly available",
    }
    : {
      cls: "baseline-limited",
      label: "Baseline: Limited availability",
    };

  const browserLabels: Array<[string, string]> = [
    ["chrome", "Chrome"],
    ["edge", "Edge"],
    ["firefox", "Firefox"],
    ["safari", "Safari"],
  ];
  const versions = browserLabels
    .map(([key, label]) => {
      const impl = webStatus.browser_implementations?.[key];
      return impl?.status === "available" && impl.version
        ? `${label} ${impl.version}`
        : null;
    })
    .filter((entry): entry is string => entry !== null);

  const featureUrl = `https://webstatus.dev/features/${
    encodeURIComponent(webFeatureId)
  }`;
  return template`<li>Baseline: <a href="${featureUrl}" rel="noopener noreferrer" target="_blank"><span class="badge ${badge.cls}">${badge.label}</span></a>${
    versions.length > 0 ? template` (${versions.join(", ")})` : template``
  }</li>`;
};

const renderEcosystemLinks = (feature: any, webFeatureId: string | null) => {
  const name = typeof feature?.name === "string" ? feature.name.trim() : "";
  if (!name) return template``;
  const q = encodeURIComponent(name);
  const webStatusUrl = webFeatureId
    ? `https://webstatus.dev/features/${encodeURIComponent(webFeatureId)}`
    : `https://webstatus.dev/?q=${q}`;
  const link = (label: string, url: string) =>
    template`<li>${label}: <a href="${url}" rel="noopener noreferrer" target="_blank">${url}</a></li>`;
  return template`
  <h2>Ecosystem</h2>
  <ul>
    ${link("Web Platform Tests", wptResultsUrl(feature, name))}
    ${link("Chrome Platform Showcase", `${SHOWCASE_FEATURES}?q=${q}`)}
    ${link("GenDN reference", `${GENDN_FEATURES}?q=${q}`)}
    ${
    link(
      "chrome.dev demos search",
      `https://www.google.com/search?q=site%3Achrome.dev+${q}`,
    )
  }
    ${
    link(
      "web.dev articles search",
      `https://www.google.com/search?q=site%3Aweb.dev+${q}`,
    )
  }
    ${link("MDN Web Docs", `https://developer.mozilla.org/en-US/search?q=${q}`)}
    ${link("Baseline status", webStatusUrl)}
  </ul>
  `;
};

const renderFeature = (
  feature: any,
  showHistory = false,
  webFeatureId: string | null = null,
  webStatus: WebStatusFeature | null = null,
) => {
  const chrome = feature.browsers?.chrome || {};
  const status = chrome.status || {};
  const spec = sanitizeUrl(feature.spec_link || feature.standards?.spec);
  const bug = sanitizeUrl(feature.bug_url || chrome.bug);

  return template`
  <p class="back-link"><a href="/">&larr; Back to release summary</a></p>
  <h1>${feature.name}</h1>
  ${
    showHistory
      ? template`<p><a href="/feature/${
        String(feature.id ?? "")
      }/history">Snapshot history</a></p>`
      : template``
  }

  <dl>
    ${
    feature.category
      ? template`<dt>Category</dt><dd>${feature.category}</dd>`
      : template``
  }
    ${
    feature.feature_type
      ? template`<dt>Type</dt><dd>${feature.feature_type}</dd>`
      : template``
  }
    ${
    status.text
      ? template`<dt>Status</dt><dd>${status.text}${
        status.milestone_str
          ? template` (Chrome <a href="/?version=${status.milestone_str}">${status.milestone_str}</a>)`
          : template``
      }</dd>`
      : template``
  }
    ${
    feature.intent_stage
      ? template`<dt>Intent stage</dt><dd>${feature.intent_stage}</dd>`
      : template``
  }
  </dl>
  ${renderFeatureMetadata(feature, true)}
  ${
    feature.wpt_descr
      ? template`<p>WPT details: ${linkify(feature.wpt_descr)}</p>`
      : template``
  }

  <h2>Summary</h2>
  <p>${linkify(feature.summary)}</p>

  ${
    feature.motivation
      ? template`<h2>Motivation</h2><blockquote>${
        linkify(feature.motivation)
      }</blockquote>`
      : template``
  }

  <h2>Standards &amp; signals</h2>
  <ul>
    ${renderBaselineStatus(webFeatureId, webStatus)}
    ${
    spec
      ? template`<li>Specification: <a href="${spec}">${spec}</a></li>`
      : template``
  }
    ${renderView("Firefox", feature.browsers?.ff)}
    ${renderView("Safari", feature.browsers?.safari)}
    ${renderView("Web developers", feature.browsers?.webdev)}
    ${
    bug
      ? template`<li>Tracking bug: <a href="${bug}">${bug}</a></li>`
      : template``
  }
  </ul>

  ${renderEcosystemLinks(feature, webFeatureId)}

  ${renderLinks("Docs", feature.doc_links || feature.resources?.docs)}
  ${renderLinks("Samples", feature.sample_links || feature.resources?.samples)}
  ${renderLinks("Explainers", feature.explainer_links)}

  <p><a href="https://chromestatus.com/feature/${
    String(feature.id ?? "")
  }">View on chromestatus.com</a></p>
  `;
};

export default async function render(
  request: Request,
  match: URLPatternResult,
  chromeStatusAPI: StatusClient,
  store: SnapshotStore | null = null,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const id = match?.pathname?.groups?.id;

  if (!isValidFeatureId(id)) {
    return new Response("Not found", {
      status: 404,
      headers: { "cache-control": NO_STORE_CACHE_CONTROL },
    });
  }

  const url = new URL(request.url);
  const canonical = `https://chromestatuslite.com${
    url.pathname + url.search
  }`;

  let feature: any;
  let notFound = false;
  let upstreamError = false;
  try {
    feature = await chromeStatusAPI.getFeature(id);
  } catch (err: any) {
    feature = null;
    if (err instanceof UpstreamFetchBudgetError) {
      const retryAfter = Math.max(1, Math.ceil(err.retryAfterMs / 1000));
      return htmlResponse({
        status: 429,
        cacheControl: NO_STORE_CACHE_CONTROL,
        headers: { "retry-after": String(retryAfter) },
        title: "Too many feature lookups",
        canonical,
        currentPath: url.pathname,
        body: template`<h1>Too many feature lookups</h1>
  <p class="error-notice">Too many new feature pages were requested in a short time. Please try
  again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.</p>`,
      });
    }
    notFound = err instanceof Error && /^upstream http 404\b/i.test(err.message);
    upstreamError = !notFound;
  }

  const usableFeature = feature !== null && typeof feature === "object" &&
    !Array.isArray(feature) && feature.id !== undefined && feature.id !== null;

  if (upstreamError || (!notFound && !usableFeature)) {
    return htmlResponse({
      status: 200,
      cacheControl: NO_STORE_CACHE_CONTROL,
      title: "Unable to load feature",
      canonical,
      currentPath: url.pathname,
      body: template`<h1>Unable to load feature</h1>
  <p class="error-notice">Unable to load feature details from chromestatus.com. Please try again later.</p>`,
    });
  }

  if (!feature || !feature.id) {
    return htmlResponse({
      status: 404,
      cacheControl: NO_STORE_CACHE_CONTROL,
      title: "Feature not found",
      canonical,
      currentPath: url.pathname,
      body: template`<h1>Feature not found</h1>
  <p>No Chrome Platform Status feature with id <code>${id}</code> could be found.</p>`,
    });
  }

  // HEAD is safe (RFC 9110 9.3.2): it must not write the snapshot store.
  // On Cloudflare Workers (`waitUntil` supplied), run snapshot capture in the
  // background so storage round-trips never delay TTFB.
  if (store && request.method !== "HEAD") {
    const capture = captureSnapshot(store, id, feature).catch((err) => {
      console.error(
        JSON.stringify({
          event: "snapshot_capture_failed",
          featureId: id,
          error: String((err as Error)?.message ?? err),
        }),
      );
    });
    if (waitUntil) waitUntil(capture);
    else await capture;
  }

  const webFeatureId = isValidWebFeatureId(feature.web_feature)
    ? feature.web_feature
    : null;
  const webStatus = webFeatureId && chromeStatusAPI.getWebStatusFeature
    ? await chromeStatusAPI.getWebStatusFeature(webFeatureId).catch(() => null)
    : null;

  return htmlResponse({
    title: `${feature.name} — Chrome Platform Status`,
    canonical,
    description: typeof feature.summary === "string"
      ? feature.summary.slice(0, 160)
      : undefined,
    currentPath: url.pathname,
    cacheControl: "public, max-age=300, stale-while-revalidate=1800",
    body: template`<div id="output">
  ${renderFeature(feature, store !== null, webFeatureId, webStatus)}
  </div>`,
  });
}
