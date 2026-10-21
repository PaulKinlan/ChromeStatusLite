import template from "../flora.ts";
import type { StatusClient } from "../handler.ts";
import { escapeHtml } from "https://deno.land/x/escape_html/mod.ts";
import linkify from "../lib/linkify.ts";
import { sanitizeUrl } from "../lib/url.ts";
import { captureSnapshot, type SnapshotStore } from "../lib/snapshots.ts";

import nav from "../ui-components/nav.ts";
import { renderFeatureMetadata } from "../ui-components/feature-metadata.ts";

// Renders a single browser's standards position / view, if present.
const renderView = (label, browser) => {
  const view = browser?.view;
  if (!view || (!view.text && !view.url)) {
    return template``;
  }
  // A view with a url already renders its text inside an anchor, so linkifying
  // that text would nest <a> (invalid HTML, chrome-status-lite-cbr): only the
  // free-text branch is linkified. Notes are always free text.
  const text = view.url
    ? escapeHtml(view.text || "No signal")
    : linkify(view.text || "No signal");
  const url = sanitizeUrl(view.url);
  return template`<li>${label}: ${
    url
      ? template`<a href="${url}">${text}</a>`
      : template`${text}`
  }${view.notes ? template` — ${linkify(view.notes)}` : template``}</li>`;
};

// Renders a list of links (docs, samples, explainers).
const renderLinks = (label, links) => {
  if (!links || links.length == 0) {
    return template``;
  }
  const safeLinks = links
    .map((link) => sanitizeUrl(String(link)))
    .filter((link) => link !== null);
  if (safeLinks.length === 0) {
    return template``;
  }
  return template`<p>${label}: ${safeLinks.map(
    (link) => template`<a href="${link}">${link}</a> `
  )}</p>`;
};

// Ecosystem cross-links for a feature: WPT results, the Chrome Platform
// Showcase, GenDN references, chrome.dev demos, and MDN/Baseline. Query
// URLs are built from the feature name at render time; no upstream calls.
// wpt.fyi's q is a literal substring match on test paths, so a real WPT
// path from the feature record beats any name-derived query. wpt_descr is
// free text carrying several shapes: bare paths, wpt.fyi URLs with or
// without a q= param, github blob/tree URLs, mozilla external/wpt/
// prefixes - and prose slash-words ("changed/removed") that must NOT
// become queries (measured against 80 live features by rev-od4/rev-33u).
const WPT_PATH_RE = /\b([a-z0-9-]+(?:\/[a-z0-9_*.-]+)+)\b/gi;

// Known wpt.fyi top-level test directories; a bare path token must start
// with one to be treated as a WPT path at all.
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
  p.replace(/\*.*$/, "") // wildcards: keep the directory
    .replace(/\/tentative$/i, "")
    .replace(/(\.[a-z0-9]+)+$/i, "") // file extensions (.any.js, .https)
    .replace(/[\/.-]+$/, "");

const slugify = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const wptQueryFromDescr = (descr: string): string | null => {
  // The record may already BE a wpt.fyi search URL: use its q= verbatim.
  const qParam = descr.match(/[?&]q=([^&\s]+)/);
  if (qParam) {
    // Free text: "?q=50%" throws URIError on a bare decode and would 500
    // the page; the raw token is still a usable literal query.
    try {
      return decodeURIComponent(qParam[1]);
    } catch {
      return qParam[1];
    }
  }
  // Shape pass, scanning every path-like token: a real wpt.fyi/results/
  // or web-platform-tests blob/tree URL wins even when prose slash-words
  // appear earlier in the text.
  for (const match of descr.matchAll(WPT_PATH_RE)) {
    const raw = match[1];
    if (/\/results\//i.test(raw)) {
      const q = trimWptPath(raw.replace(/^.*\/results\//i, ""));
      if (q) return q;
    } else if (/\/(?:blob|tree)\/[^/]+\//i.test(raw)) {
      const q = trimWptPath(raw.replace(/^.*\/(?:blob|tree)\/[^/]+\//i, ""));
      if (q) return q;
    } else if (/^fyi\//i.test(raw)) {
      // Host-form wpt.fyi URL: the linked page's directory depth is
      // arbitrary; WPT search works best on the top two directories.
      const segs = trimWptPath(raw.slice(4)).split("/");
      const q = (segs.length > 2 ? segs.slice(0, 2) : segs).join("/");
      if (q) return q;
    } else if (/^external\/wpt\//i.test(raw)) {
      const q = trimWptPath(raw.slice("external/wpt/".length));
      if (q) return q;
    }
  }

  // Bare paths: only known WPT top-level directories count as WPT paths.
  // Prose slash-words ("changed/removed", "PC/SC") and non-WPT hosts
  // ("com/tc39/...", "org/chromium/...") never pass this filter.
  for (const match of descr.matchAll(WPT_PATH_RE)) {
    const segs = match[1].split("/");
    if (!WPT_TOP_DIRS.has(segs[0].toLowerCase())) continue;
    const q = trimWptPath([segs[0].toLowerCase(), ...segs.slice(1)].join("/"));
    if (q) return q;
  }
  return null;
};

const wptResultsUrl = (feature: any, name: string): string => {
  const descr = typeof feature?.wpt_descr === "string" ? feature.wpt_descr : "";
  const q = wptQueryFromDescr(descr) ?? slugify(name);
  return `https://wpt.fyi/results/?q=${encodeURIComponent(q)}`;
};

const SHOWCASE_FEATURES = "https://chrome-platform-showcase.paulkinlan-ea.deno.net/features";
const GENDN_FEATURES = "https://gendn.paulkinlan-ea.deno.net/features";

const renderEcosystemLinks = (feature) => {
  const name = typeof feature?.name === "string" ? feature.name.trim() : "";
  if (!name) return template``;
  const q = encodeURIComponent(name);
  const link = (label, url) =>
    template`<li>${label}: <a href="${url}" rel="noopener noreferrer" target="_blank">${escapeHtml(
      url
    )}</a></li>`;
  return template`
  <h2>Ecosystem</h2>
  <ul>
    ${link("Web Platform Tests", wptResultsUrl(feature, name))}
    ${link("Chrome Platform Showcase", SHOWCASE_FEATURES)}
    ${link("GenDN reference", GENDN_FEATURES)}
    ${
      link(
        "chrome.dev demos search",
        `https://www.google.com/search?q=site%3Achrome.dev+${q}`
      )
    }
    ${link("MDN Web Docs", `https://developer.mozilla.org/en-US/search?q=${q}`)}
    ${link("Baseline status", `https://webstatus.dev/?q=${q}`)}
  </ul>
  `;
};

const renderFeature = (feature, showHistory = false) => {
  const chrome = feature.browsers?.chrome || {};
  const status = chrome.status || {};
  const spec = sanitizeUrl(feature.spec_link || feature.standards?.spec);
  const bug = sanitizeUrl(feature.bug_url || chrome.bug);

  return template`
  <p><a href="/">&larr; Back to release summary</a></p>
  <h1>${escapeHtml(feature.name)}</h1>
  ${
    // Only advertise the history routes when a store is configured: on a
    // store-less deployment they render "not configured", so a link would
    // send readers to a dead end.
    showHistory
      ? template`<p><a href="/feature/${escapeHtml(
          String(feature.id ?? "")
        )}/history">Snapshot history</a></p>`
      : template``
  }

  <dl>
    ${
      feature.category
        ? template`<dt>Category</dt><dd>${escapeHtml(feature.category)}</dd>`
        : template``
    }
    ${
      feature.feature_type
        ? template`<dt>Type</dt><dd>${escapeHtml(feature.feature_type)}</dd>`
        : template``
    }
    ${
      status.text
        ? template`<dt>Status</dt><dd>${escapeHtml(status.text)}${
            status.milestone_str
              ? template` (Chrome <a href="/?version=${escapeHtml(
                  status.milestone_str
                )}">${escapeHtml(status.milestone_str)}</a>)`
              : template``
          }</dd>`
        : template``
    }
    ${
      feature.intent_stage
        ? template`<dt>Intent stage</dt><dd>${escapeHtml(
            feature.intent_stage
          )}</dd>`
        : template``
    }
  </dl>
  ${renderFeatureMetadata(feature, true)}
  ${feature.wpt_descr ? template`<p>WPT details: ${linkify(feature.wpt_descr)}</p>` : template``}

  <h2>Summary</h2>
  <p>${linkify(feature.summary)}</p>

  ${
    feature.motivation
      ? template`<h2>Motivation</h2><blockquote>${linkify(
          feature.motivation
        )}</blockquote>`
      : template``
  }

  <h2>Standards &amp; signals</h2>
  <ul>
    ${
      spec
        ? template`<li>Specification: <a href="${spec}">${spec}</a></li>`
        : template``
    }
    ${renderView("Firefox", feature.browsers?.ff)}
    ${renderView("Safari", feature.browsers?.safari)}
    ${renderView("Web developers", feature.browsers?.webdev)}
    ${
      bug ? template`<li>Tracking bug: <a href="${bug}">${bug}</a></li>` : template``
    }
  </ul>

  ${renderEcosystemLinks(feature)}

  ${renderLinks("Docs", feature.doc_links || feature.resources?.docs)}
  ${renderLinks("Samples", feature.sample_links || feature.resources?.samples)}
  ${renderLinks("Explainers", feature.explainer_links)}

  <p><a href="https://chromestatus.com/feature/${escapeHtml(String(feature.id ?? ""))}">View on chromestatus.com</a></p>
  `;
};

export default async function render(request: Request, match: URLPatternResult, chromeStatusAPI: StatusClient, store: SnapshotStore | null = null): Response {
  const id = match?.pathname?.groups?.id;

  if (!id || /\D/.test(id)) {
    return new Response("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const canonical = `https://chromestatuslite.com${escapeHtml(
    url.pathname + url.search
  )}`;

  let feature;
  let notFound = false;
  let upstreamError = false;
  try {
    feature = await chromeStatusAPI.getFeature(id);
  } catch (err: any) {
    feature = null;
    // The client reports a missing feature by throwing
    // "Upstream HTTP 404 from <path>"; only that exact shape is an
    // authoritative answer that the feature does not exist. Every other
    // failure (5xx, network error, unparseable body) is an outage, which
    // must not state a fact about the feature.
    notFound = err instanceof Error && /^upstream http 404\b/i.test(err.message);
    upstreamError = !notFound;
  }

  // A renderable feature is an object carrying an id. A 200 body of null or
  // an object without an id is upstream data corruption, not proof the
  // feature is absent, so it must not render as an authoritative 404.
  const usableFeature = feature !== null && typeof feature === "object" &&
    !Array.isArray(feature) && feature.id !== undefined && feature.id !== null;

  if (upstreamError || (!notFound && !usableFeature)) {
    return template`
  <!doctype html>
<html>

<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Unable to load feature</title>
  <link rel="canonical" href="${canonical}">
  <link rel="stylesheet" href="/styles/index.css">
</head>

<body>
  ${nav()}
  <h1>Unable to load feature</h1>
  <p class="error-notice">Unable to load feature details from chromestatus.com. Please try again later.</p>
</body>

</html>`.then(
      (data) =>
        new Response(data, {
          status: 200,
          headers: { "content-type": "text/html" },
        })
    );
  }

  // Only a genuine upstream "not found" answer reaches this 404 page.
  if (!feature || !feature.id) {
    return template`
  <!doctype html>
<html>

<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Feature not found</title>
  <link rel="canonical" href="${canonical}">
  <link rel="stylesheet" href="/styles/index.css">
</head>

<body>
  ${nav()}
  <h1>Feature not found</h1>
  <p>No Chrome Platform Status feature with id <code>${escapeHtml(
    id
  )}</code> could be found.</p>
</body>

</html>`.then(
      (data) =>
        new Response(data, {
          status: 404,
          headers: { "content-type": "text/html" },
        })
    );
  }

  if (store) {
    await captureSnapshot(store, id, feature).catch((err) => {
      console.error("[snapshots] capture failed:", err?.message ?? err);
    });
  }

  return template`
  <!doctype html>
<html>

<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(feature.name)} — Chrome Platform Status</title>
  <link rel="canonical" href="${canonical}">
  <link rel="stylesheet" href="/styles/index.css">
</head>

<body>
  ${nav()}
  <div id="output">
  ${renderFeature(feature, store !== null)}
  </div>
</body>

</html>`.then(
    (data) =>
      new Response(data, {
        status: 200,
        headers: { "content-type": "text/html" },
      })
  );
}
