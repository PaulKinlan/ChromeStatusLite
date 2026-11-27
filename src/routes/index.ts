import template from "../flora.ts";
import type { StatusClient } from "../handler.ts";

import {
  htmlResponse,
  NO_STORE_CACHE_CONTROL,
} from "../ui-components/layout.ts";
import { renderFeatureMetadata } from "../ui-components/feature-metadata.ts";
import { hasValidBuckets } from "../lib/buckets.ts";
import linkify from "../lib/linkify.ts";
import { sanitizeUrl } from "../lib/url.ts";

const SHOWCASE_MIN_MILESTONE = 130;

const renderData = async (version: string, featuresByType: any) => {
  const safeFeatures = (featuresByType && typeof featuresByType === "object")
    ? featuresByType
    : {};
  const getSafeBucket = (key: string): any[] =>
    Array.isArray(safeFeatures[key])
      ? safeFeatures[key].filter((item: unknown) =>
        item && typeof item === "object"
      )
      : [];

  const enabled = getSafeBucket("Enabled by default");
  const originTrials = getSafeBucket("Origin trial");
  const flaggedFeatures = getSafeBucket("In developer trial (Behind a flag)");
  const removed = getSafeBucket("Removed");
  const deprecated = getSafeBucket("Deprecated");

  const numericVersion = /^\d+$/.test(version)
    ? Number.parseInt(version, 10)
    : NaN;
  const showcaseLink =
    Number.isFinite(numericVersion) && numericVersion >= SHOWCASE_MIN_MILESTONE
      ? template`<a class="showcase-pill" href="https://chrome-platform-showcase.com/v${numericVersion}/" rel="noopener noreferrer">Interactive demos &#8599;</a>`
      : template``;

  return template`
  <h1>Chrome ${version}</h1>
  <div class="release-jump" aria-label="Release sections">
    <a href="#enabled">Enabled <span class="jump-count">${enabled.length}</span></a>
    <a href="#origin-trial">Origin Trial <span class="jump-count">${originTrials.length}</span></a>
    <a href="#flagged">Behind a flag <span class="jump-count">${flaggedFeatures.length}</span></a>
    <a href="#deprecated">Deprecated <span class="jump-count">${deprecated.length}</span></a>
    <a href="#removed">Removed <span class="jump-count">${removed.length}</span></a>
    ${showcaseLink}
  </div>
  ${renderEnabled(enabled, version)}
  ${renderOriginTrials(originTrials, version)}
  ${renderFlaggedFeatures(flaggedFeatures, version)}
  <h2 class="release-section-heading">Deprecations and Removals</h2>
  <div class="policy-note">
    <h3 id="deprecation-policy">Deprecation policy</h3>
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
    <p>Chrome currently has a <a href="https://www.chromium.org/blink#TOC-Launch-Process:-Deprecation">process for
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
  </div>
  ${renderDeprecatedFeatures(deprecated, version)}
  ${renderRemovedFeatures(removed, version)}
  `;
};

const renderResources = (resources: any, tag: "h4" | "h5" = "h4") => {
  if (!resources || typeof resources !== "object") {
    return template``;
  }
  const hasSamples = "samples" in resources && Array.isArray(resources.samples);
  const hasDocs = "docs" in resources && Array.isArray(resources.docs);
  const samples: string[] = (hasSamples ? resources.samples : [])
    .map((resource: unknown) => sanitizeUrl(String(resource)))
    .filter((resource: string | null): resource is string => resource !== null);
  const docs: string[] = (hasDocs ? resources.docs : [])
    .map((resource: unknown) => sanitizeUrl(String(resource)))
    .filter((resource: string | null): resource is string => resource !== null);
  if (hasSamples && samples.length === 0 && hasDocs && docs.length === 0) {
    return template``;
  }

  return template`<${tag}>Resources</${tag}>
      ${
    hasDocs && docs.length > 0
      ? template`<p>Docs: ${
        docs.flatMap((resource, index) =>
          index > 0
            ? [" ", template`<a href="${resource}">${resource}</a>`]
            : [template`<a href="${resource}">${resource}</a>`]
        )
      }</p>`
      : template`<p>No linked docs</p>`
  }
      ${
    hasSamples && samples.length > 0
      ? template`<p>Samples: ${
        samples.flatMap((resource, index) =>
          index > 0
            ? [" ", template`<a href="${resource}">${resource}</a>`]
            : [template`<a href="${resource}">${resource}</a>`]
        )
      }</p>`
      : template`<p>No linked samples</p>`
  }`;
};

// Renders a single feature block. `tag` is the heading level to use so
// that enabled/origin-trial/flagged sections sit at h3 and the nested
// deprecated/removed sections sit at h4.
const renderFeature = (item: any, tag: "h3" | "h4" = "h3") => {
  if (!item || typeof item !== "object") return template``;
  const bug = sanitizeUrl(item.browsers?.chrome?.bug);
  const spec = sanitizeUrl(item.standards?.spec);
  const id = item.id !== undefined ? encodeURIComponent(String(item.id)) : "";
  const name = item.name || "Unnamed feature";
  const summary = linkify(item.summary || "");
  return template`<article class="feature-card">
      <${tag}><a href="/feature/${id}">${name}</a></${tag}>
      <p>${summary}${
    bug ? template` <a href="${bug}">#</a>` : template``
  }</p>
      ${
    "motivation" in item && item.motivation
      ? template`<p>${
        item.creator || "A contributor"
      } created this feature because:</p><blockquote>${
        linkify(item.motivation)
      }</blockquote>`
      : template``
  }
      ${
    spec
      ? template`<p>This feature was specified <a href="${spec}">in this Spec</a>.</p>`
      : template``
  }
      ${renderFeatureMetadata(item)}
      ${renderResources(item.resources, tag === "h3" ? "h4" : "h5")}
    </article>`;
};

const renderEnabled = (enabled: any[], version: string) =>
  template`
    <h2 id="enabled" class="release-section-heading">Enabled by default in ${version}</h2>
    <p class="section-lead">This release of Chrome had ${enabled.length} new features.</p>
    ${enabled.map((item) => renderFeature(item, "h3"))}`;

const renderOriginTrials = (ot: any[], version: string) =>
  template`
    <h2 id="origin-trial" class="release-section-heading">Origin Trials in-progress in ${version}</h2>
    <p class="section-lead">This release of Chrome had ${ot.length} new origin trials.</p>
    ${ot.map((item) => renderFeature(item, "h3"))}`;

const renderFlaggedFeatures = (flagged: any[], version: string) =>
  template`
    <h2 id="flagged" class="release-section-heading">Flagged features in ${version}</h2>
    <p class="section-lead">This release of Chrome had ${flagged.length} features available behind a flag.</p>
    ${flagged.map((item) => renderFeature(item, "h3"))}`;

const renderDeprecatedFeatures = (deprecated: any[], version: string) =>
  template`
    <h3 id="deprecated">Deprecated features in ${version}</h3>
    <p class="section-lead">This release of Chrome had ${deprecated.length} features deprecated.</p>
    ${deprecated.map((item) => renderFeature(item, "h4"))}`;

const renderRemovedFeatures = (removed: any[], version: string) =>
  template`
    <h3 id="removed">Removed features in ${version}</h3>
    <p class="section-lead">This release of Chrome had ${removed.length} features removed.</p>
    ${removed.map((item) => renderFeature(item, "h4"))}`;

export default async function render(
  request: Request,
  chromeStatusAPI: StatusClient,
): Promise<Response> {
  const url = new URL(request.url);
  const requested = url.searchParams.get("version") || "";
  let versions: unknown[] = [];
  let version = "";
  let features: any = {};
  let upstreamError = false;

  try {
    const rawVersions = await chromeStatusAPI.getVersions();
    if (!Array.isArray(rawVersions)) {
      upstreamError = true;
      versions = [];
    } else {
      versions = rawVersions;
      version = versions.some((v) => String(v) === requested)
        ? requested
        : versions.length > 0
        ? String(versions[0])
        : "";
      if (version) {
        features = await chromeStatusAPI.getFeaturesForVersion(version);
        if (
          !features || typeof features !== "object" ||
          !hasValidBuckets(features)
        ) {
          upstreamError = true;
        }
      }
    }
  } catch {
    upstreamError = true;
  }

  const RECENT_COUNT = 8;
  const recent = versions.slice(0, RECENT_COUNT);
  if (version && !recent.some((v) => String(v) === String(version))) {
    const sel = versions.find((v) => String(v) === String(version));
    if (sel !== undefined) recent.unshift(sel);
  }
  const rest = versions.filter((v) => !recent.includes(v));
  const chip = (item: unknown) => {
    const current = String(item) === String(version);
    return template`<a href="?version=${encodeURIComponent(String(item))}"${
      current ? template` class="current" aria-current="page"` : ""
    }>${String(item)}</a>`;
  };
  const chips = (list: unknown[]) =>
    list.flatMap((item, index) => index ? [" ", chip(item)] : [chip(item)]);

  const contentBody = upstreamError
    ? template`<h1>${
      version
        ? template`Chrome ${version} unavailable`
        : template`Chrome release unavailable`
    }</h1>
      <p class="error-notice">Unable to load release data from chromestatus.com. Please try again later.</p>`
    : renderData(version, features);

  return htmlResponse({
    title: `Chrome Release ${version}`,
    canonical: `https://chromestatuslite.com${url.pathname + url.search}`,
    description: version
      ? `Features enabled, in origin trial, behind a flag, deprecated, or removed in Chrome ${version}.`
      : "Fast, lightweight release log over Chrome Platform Status.",
    currentPath: url.pathname,
    cacheControl: upstreamError ? NO_STORE_CACHE_CONTROL : undefined,
    body: template`<p class="page-kicker">Chrome Release Summary</p>
  <div class="versions"><span class="versions-label">Chrome version:</span>
    <span class="version-list">${chips(recent)}</span>
    ${
      rest.length
        ? template`<details class="more-versions"><summary title="Show ${rest.length} earlier versions" aria-label="Show ${rest.length} earlier versions">+${rest.length}</summary><div class="version-list">${
          chips(rest)
        }</div></details>`
        : template``
    }
  </div>
  <div id="output">
  ${contentBody}
  </div>`,
  });
}
