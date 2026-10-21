import template from "../flora.ts";
import type { StatusClient } from "../handler.ts";
import { escapeHtml } from "https://deno.land/x/escape_html/mod.ts";

import nav from "../ui-components/nav.ts";
import { renderFeatureMetadata } from "../ui-components/feature-metadata.ts";
import { hasValidBuckets } from "../lib/buckets.ts";
import linkify from "../lib/linkify.ts";
import { sanitizeUrl } from "../lib/url.ts";

const renderData = async (version, featuresByType) => {
  // The v0 API groups features by status text. Pull each bucket out,
  // defaulting to an empty list when a milestone has none of that type.
  const safeFeatures = (featuresByType && typeof featuresByType === "object") ? featuresByType : {};
  const getSafeBucket = (key: string) =>
    Array.isArray(safeFeatures[key])
      ? safeFeatures[key].filter((item) => item && typeof item === "object")
      : [];

  const enabled = getSafeBucket("Enabled by default");
  const originTrials = getSafeBucket("Origin trial");
  const flaggedFeatures = getSafeBucket("In developer trial (Behind a flag)");
  const removed = getSafeBucket("Removed");
  const deprecated = getSafeBucket("Deprecated");

  console.log(
    enabled.length,
    originTrials.length,
    flaggedFeatures.length,
    removed.length,
    deprecated.length
  );
  return template`
  <h1>Chrome ${version}</h1>
  <a href="#enabled">Enabled (${enabled.length})</a> |
  <a href="#origin-trial">Origin Trial (${originTrials.length})</a> |
  <a href="#flagged">Behind a flag (${flaggedFeatures.length})</a> |
  <a href="#deprecated">Deprecated (${deprecated.length})</a> |
  <a href="#removed">Removed (${removed.length})</a>
  ${renderEnabled(enabled, version)}
  ${renderOriginTrials(originTrials, version)}
  ${renderFlaggedFeatures(flaggedFeatures, version)}
  <h2>Deprecations and Removals</h2>
  <h3 id="deprecation-policy">Deprecation policy</h2>
    <p>To keep the platform healthy, we sometimes remove APIs from the Web Platform which have run their course. There
        can be many reasons why we would remove an API, such as:</p>
    <ul>
        <li>They are superseded by newer APIs.</li>
        <li>They are updated to reflect changes to specifications to bring alignment and consistency with other
            browsers.</li>
        <li>They are early experiments that never came to fruition in other browsers and thus can increase the burden of
            support for web developers.</li>
    </ul>
    <p>Some of these changes will have an effect on a very small number of sites. To mitigate issues ahead of time, we
        try to give developers advanced notice so they can make the required changes to keep their sites running.</p>
    <p>Chrome currently has a <a href="http://www.chromium.org/blink#TOC-Launch-Process:-Deprecation">process for
            deprecations and removals of API's</a>, essentially:</p>
    <ul>
        <li>Announce on the <a href="https://groups.google.com/a/chromium.org/forum/#!forum/blink-dev">blink-dev</a>
            mailing list.</li>
        <li>Set warnings and give time scales in the Chrome DevTools Console when usage is detected on the page.</li>
        <li>Wait, monitor, and then remove the feature as usage drops.</li>
    </ul>
    <p>You can find a list of all deprecated features on chromestatus.com using the <a
            href="https://www.chromestatus.com/features#deprecated">deprecated filter</a> and removed features by
        applying the <a href="https://www.chromestatus.com/features#removed">removed filter</a>. We will also try to
        summarize some of the changes, reasoning, and migration paths in these posts.</p>
  ${renderDeprecatedFeatures(deprecated, version)}
  ${renderRemovedFeatures(removed, version)}
  `;
};

const renderResources = (resources) => {
  if (!resources || typeof resources !== "object") {
    return template``;
  }
  const hasSamples = "samples" in resources && Array.isArray(resources.samples);
  const hasDocs = "docs" in resources && Array.isArray(resources.docs);
  const samples = hasSamples ? resources.samples : [];
  const docs = hasDocs ? resources.docs : [];
  if (hasSamples && samples.length === 0 && hasDocs && docs.length === 0) {
    return template``;
  }

  return template`<h4>Resources</h4>
      ${
        hasDocs && docs.length > 0
          ? template`<p>Docs: ${docs
              .map((resource) => sanitizeUrl(String(resource)))
              .filter((resource) => resource !== null)
              .map(
              (resource) => template`<a href="${resource}">${resource}</a>`
            )}</p>`
          : template`No linked docs`
      }</p>
      ${
        hasSamples && samples.length > 0
          ? template`<p>Samples: ${samples
              .map((resource) => sanitizeUrl(String(resource)))
              .filter((resource) => resource !== null)
              .map(
              (resource) => template`<a href="${resource}">${resource}</a>`
            )}</p>`
          : template`No linked samples`
      }</p>`;
};

// Renders a single feature block. `tag` is the heading level to use so
// that enabled/origin-trial/flagged sections sit at h3 and the nested
// deprecated/removed sections sit at h4.
const renderFeature = (item, tag = "h3") => {
  if (!item || typeof item !== "object") return template``;
  const bug = sanitizeUrl(item.browsers?.chrome?.bug);
  const spec = sanitizeUrl(item.standards?.spec);
  const id = item.id !== undefined ? encodeURIComponent(String(item.id)) : "";
  const name = escapeHtml(item.name || "Unnamed feature");
  const summary = linkify(item.summary || "");
  return template`<${tag}><a href="/feature/${id}">${name}</a></${tag}>
      <p>${summary}${
    bug ? template` <a href="${bug}">#</a>` : template``
  }</p>
      ${
        "motivation" in item && item.motivation
          ? template`<p>${
              escapeHtml(item.creator || "A contributor")
            } created this feature because: <blockquote>${escapeHtml(
              item.motivation
            )}</blockquote></p>`
          : template``
      }
      ${
        spec
          ? template`<p>This feature was specified <a href="${spec}">in this Spec</a>.</p>`
          : template``
      }
      ${renderFeatureMetadata(item)}
      ${renderResources(item.resources)}`;
};

const renderEnabled = (enabled, version) => template`
    <h2 id="enabled">Enabled by default in ${version}</h2>
    <p>This release of Chrome had ${enabled.length} new features.</p>
    ${enabled.map((item) => renderFeature(item, "h3"))}`;

const renderOriginTrials = (ot, version) => template`
    <h2 id="origin-trial">Origin Trials in-progress in ${version}</h2>
    <p>This release of Chrome had ${ot.length} new origin trials.</p>
    ${ot.map((item) => renderFeature(item, "h3"))}`;

const renderFlaggedFeatures = (flagged, version) => template`
    <h2 id="flagged">Flagged features in ${version}</h2>
    <p>This release of Chrome had ${
      flagged.length
    } are available behind a flag.</p>
    ${flagged.map((item) => renderFeature(item, "h3"))}`;

const renderDeprecatedFeatures = (deprecated, version) => template`
    <h3 id="deprecated">Deprecated features in ${version}</h3>
    <p>This release of Chrome had ${deprecated.length} features deprecated.</p>
    ${deprecated.map((item) => renderFeature(item, "h4"))}`;

const renderRemovedFeatures = (removed, version) => template`
    <h3 id="removed">Removed features in ${version}</h3>
    <p>This release of Chrome had ${removed.length} features removed.</p>
    ${removed.map((item) => renderFeature(item, "h4"))}`;

export default async function render(request: Request, chromeStatusAPI: StatusClient): Response {
  const url = new URL(request.url);
  let versions: any[] = [];
  let version: any = url.searchParams.get("version") || "";
  let features: any = {};
  let upstreamError = false;

  try {
    versions = await chromeStatusAPI.getVersions();
    if (!Array.isArray(versions)) {
      upstreamError = true;
      versions = [];
    } else {
      if (!version && versions.length > 0) {
        version = versions[0];
      }
      if (version) {
        features = await chromeStatusAPI.getFeaturesForVersion(version);
        if (!features || typeof features !== "object" || !hasValidBuckets(features)) {
          upstreamError = true;
        }
      }
    }
  } catch {
    upstreamError = true;
  }

  // Version picker: show the most recent releases as chips and tuck the long
  // tail behind a native <details> disclosure, so the full list (which runs
  // all the way back to v0) isn't overwhelming, especially on mobile. The
  // selected version is always kept visible, and everything stays a plain link.
  const RECENT_COUNT = 8;
  const recent = versions.slice(0, RECENT_COUNT);
  if (version && !recent.some((v) => String(v) === String(version))) {
    const sel = versions.find((v) => String(v) === String(version));
    if (sel !== undefined) recent.unshift(sel);
  }
  const rest = versions.filter((v) => !recent.includes(v));
  const chip = (item) =>
    `<a href="?version=${item}"${
      String(item) === String(version) ? ` class="current" aria-current="page"` : ""
    }>${item}</a>`;
  const recentHtml = recent.map(chip).join(" ");
  const restHtml = rest.map(chip).join(" ");

  const contentBody = upstreamError
    ? template`<p class="error-notice">Unable to load release data from chromestatus.com. Please try again later.</p>`
    : renderData(version, features);

  return template`
  <!doctype html>
<html>

<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="/scripts/index.js" type="module"></script>
  <title>Chrome Release ${version || ""}</title>
  <link rel="canonical" href="https://chromestatuslite.com${escapeHtml(url.pathname + url.search)}">
  <link rel="stylesheet" href="/styles/index.css">
</head>

<body>
  ${nav()}
  <h1>Chrome Release Summary</h1>
  <div class="versions">Chrome version:
    <span class="version-list">${template`${recentHtml}`}</span>
    ${
    rest.length
      ? template`<details class="more-versions"><summary title="Show ${rest.length} earlier versions" aria-label="Show ${rest.length} earlier versions">+${rest.length}</summary><div class="version-list">${template`${restHtml}`}</div></details>`
      : template``
  }
  </div>
  <div id="output">
  ${contentBody}
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
