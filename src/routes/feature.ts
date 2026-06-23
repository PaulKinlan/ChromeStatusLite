import template from "../flora.ts";
import { ChromeStatusAPI } from "../lib/utils.ts";
import { escapeHtml } from "https://deno.land/x/escape_html/mod.ts";

import nav from "../ui-components/nav.ts";

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

  ${renderLinks("Docs", feature.doc_links || feature.resources?.docs)}
  ${renderLinks("Samples", feature.sample_links || feature.resources?.samples)}
  ${renderLinks("Explainers", feature.explainer_links)}

  <p><a href="https://chromestatus.com/feature/${feature.id}">View on chromestatus.com</a></p>
  `;
};

export default async function render(request: Request, match): Response {
  const id = match?.pathname?.groups?.id;

  if (!id || /\D/.test(id)) {
    return new Response("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const canonical = `https://chromestatuslite.com${escapeHtml(
    url.pathname + url.search
  )}`;

  const chromeStatusAPI = ChromeStatusAPI.getInstance();

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
