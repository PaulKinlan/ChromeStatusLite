import template from "../flora.ts";
import type { StatusClient } from "../handler.ts";
import { escapeHtml } from "https://deno.land/x/escape_html/mod.ts";

import nav from "../ui-components/nav.ts";
import { renderFeatureMetadata } from "../ui-components/feature-metadata.ts";

// Renders a single browser's standards position / view, if present.
const renderView = (label, browser) => {
  const view = browser?.view;
  if (!view || (!view.text && !view.url)) {
    return template``;
  }
  const text = escapeHtml(view.text || "No signal");
  return template`<li>${label}: ${
    view.url
      ? template`<a href=${view.url}>${text}</a>`
      : template`${text}`
  }${view.notes ? template` — ${escapeHtml(view.notes)}` : template``}</li>`;
};

// Renders a list of links (docs, samples, explainers).
const renderLinks = (label, links) => {
  if (!links || links.length == 0) {
    return template``;
  }
  return template`<p>${label}: ${links.map(
    (link) => template`<a href=${link}>${link}</a> `
  )}</p>`;
};

// Ecosystem cross-links for a feature: WPT results, the Chrome Platform
// Showcase, GenDN references, chrome.dev demos, and MDN/Baseline. Query
// URLs are built from the feature name at render time; no upstream calls.
// wpt.fyi's q is a literal substring match on test paths, so the name is
// slugified - spaced names ("View Transitions") match nothing while the
// hyphenated form ("view-transitions") matches the test tree.
const slugify = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// wpt.fyi's q is a literal substring match on test paths, so a real WPT
// path from the feature record beats any name-derived query. wpt_descr
// carries several shapes: bare paths ("css/cssom-view/scrollIntoView-*.
// html"), wpt.fyi URLs with or without a q= param, and github blob URLs.
const WPT_PATH_RE = /\b([a-z0-9-]+(?:\/[a-z0-9_*.-]+)+)\b/i;

const wptQueryFromDescr = (descr: string): string | null => {
  const qParam = descr.match(/[?&]q=([^&\s]+)/);
  if (qParam) return decodeURIComponent(qParam[1]);
  const match = descr.match(WPT_PATH_RE);
  if (!match) return null;
  const path = match[1]
    .replace(/^.*\/blob\/[a-f0-9]+\//i, "") // github blob URLs: drop host+sha
    .replace(/^.*\/results\//, "")          // wpt.fyi URLs: keep the test path
    .replace(/^external\/wpt\//i, "")        // mozilla-style layout prefixes
    .replace(/\*.*$/, "")                     // wildcards: keep the directory
    .replace(/(\.[a-z0-9]+)+$/i, "")          // file extensions (.any.js, .html)
    .replace(/[\/.-]+$/, "");
  return path || null;
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
    template`<li>${label}: <a href="${url}" rel="noopener noreferrer" target="_blank">${url}</a></li>`;
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

const renderFeature = (feature) => {
  const chrome = feature.browsers?.chrome || {};
  const status = chrome.status || {};
  const spec = feature.spec_link || feature.standards?.spec;
  const bug = feature.bug_url || chrome.bug;

  return template`
  <p><a href="/">&larr; Back to release summary</a></p>
  <h1>${escapeHtml(feature.name)}</h1>

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
  ${feature.wpt_descr ? template`<p>WPT details: ${escapeHtml(feature.wpt_descr)}</p>` : template``}

  <h2>Summary</h2>
  <p>${escapeHtml(feature.summary)}</p>

  ${
    feature.motivation
      ? template`<h2>Motivation</h2><blockquote>${escapeHtml(
          feature.motivation
        )}</blockquote>`
      : template``
  }

  <h2>Standards &amp; signals</h2>
  <ul>
    ${
      spec
        ? template`<li>Specification: <a href=${spec}>${spec}</a></li>`
        : template``
    }
    ${renderView("Firefox", feature.browsers?.ff)}
    ${renderView("Safari", feature.browsers?.safari)}
    ${renderView("Web developers", feature.browsers?.webdev)}
    ${
      bug ? template`<li>Tracking bug: <a href=${bug}>${bug}</a></li>` : template``
    }
  </ul>

  ${renderEcosystemLinks(feature)}

  ${renderLinks("Docs", feature.doc_links || feature.resources?.docs)}
  ${renderLinks("Samples", feature.sample_links || feature.resources?.samples)}
  ${renderLinks("Explainers", feature.explainer_links)}

  <p><a href="https://chromestatus.com/feature/${feature.id}">View on chromestatus.com</a></p>
  `;
};

export default async function render(request: Request, match: URLPatternResult, chromeStatusAPI: StatusClient): Response {
  const id = match?.pathname?.groups?.id;

  if (!id || /\D/.test(id)) {
    return new Response("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const canonical = `https://chromestatuslite.com${escapeHtml(
    url.pathname + url.search
  )}`;

  let feature;
  try {
    feature = await chromeStatusAPI.getFeature(id);
  } catch (_) {
    feature = null;
  }

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
  ${renderFeature(feature)}
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
