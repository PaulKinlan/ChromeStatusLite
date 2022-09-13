import template from "../flora.ts";
import { StripStream } from "../stream-utils.ts";
import { escapeHtml } from "https://deno.land/x/escape_html/mod.ts";

const renderData = async (version, versionData) => {
  const featuresByType = versionData.features_by_type;

  const enabled = featuresByType["Enabled by default"];
  const originTrials = featuresByType["Origin trial"];
  const flaggedFeatures = featuresByType["In developer trial (Behind a flag)"];
  const removed = featuresByType["Removed"];
  const deprecated = featuresByType["Deprecated"];

  return template`
  <h1>Chrome ${version}</h1>
  <a href="#enabled">Enabled (${enabled.length})</a> |
  <a href="#origin-trial">Origin Trial (${originTrials.length})</a> |
  <a href="#flagged">Flagged (${flaggedFeatures.length})</a> |
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
}

const renderResources = (resources) => {
  return (resources.length > 0)
    ? template`<h4>Resources</h4>
      ${('docs' in resources) ? template`<p>Docs: ${resources.docs.map(resource => template`<a href=${resource}>${resource}</a>`)}</p>` : template`No linked docs`}</p>
      ${('samples' in resources) ? template`<p>Samples: ${resources.samples.map(resource => template`<a href=${resource}>${resource}</a>`)}</p>` : template`No linked samples`}</p>`
    : template``;
};

const renderEnabled = (enabled, version) => template`
    <h2 id="enabled">Enabled by default in ${version}</h2>
    <p>This release of Chrome had ${enabled.length} new features.</p>
    ${enabled.map(item =>
  template`<h3>${item.name}</h3>
      <p>${escapeHtml(item.summary)} <a href=${item.launch_bug_url}>#</a></p>
      ${('motivation' in item) ? template`<p>${item.creator} created this feature because: <blockquote>${escapeHtml(item.motivation)}</blockquote></p>` : template``}
      <p>This feature was initially proposed in <a href=${item.initial_public_proposal_url}>${item.initial_public_proposal_url}</a></p>
      <p>This feature specified in "<a href=${item.standards.spec}>${escapeHtml(item.standards.status.text)}</a>"
      ${renderResources(item.resources)}`
)}`;

const renderOriginTrials = (ot, version) => template`
    <h2 id="origin-trial">Origin Trials in-progress in ${version}</h2>
    <p>This release of Chrome had ${ot.length} new origin trials.</p>
    ${ot.map(item =>
  template`<h3>${item.name}</h3>
      <p>${escapeHtml(item.summary)} <a href=${item.launch_bug_url}>#</a></p>
      ${('motivation' in item) ? template`<p>${item.creator} created this feature because: <blockquote>${escapeHtml(item.motivation)}</blockquote></p>` : template``}
      <p>This feature was initially proposed in <a href=${item.initial_public_proposal_url}>${item.initial_public_proposal_url}</a></p>
      <p>This feature specified in "<a href=${item.standards.spec}>${escapeHtml(item.standards.status.text)}</a>"
      ${renderResources(item.resources)}`
)}`;

const renderFlaggedFeatures = (flagged, version) => template`
    <h2 id="flagged">Flagged features in ${version}</h2>
    <p>This release of Chrome had ${flagged.length} are available behind a flag.</p>
    ${flagged.map(item =>
  template`<h3>${item.name}</h3>
      <p>${escapeHtml(item.summary)} <a href=${item.launch_bug_url}>#</a></p>
      ${('motivation' in item) ? template`<p>${item.creator} created this feature because: <blockquote>${escapeHtml(item.motivation)}</blockquote></p>` : template``}
      <p>This feature was initially proposed in <a href=${item.initial_public_proposal_url}>${item.initial_public_proposal_url}</a></p>
      <p>This feature specified in "<a href=${item.standards.spec}>${escapeHtml(item.standards.status.text)}</a>"
      ${renderResources(item.resources)}`
)}`;

const renderDeprecatedFeatures = (deprecated, version) => template`
    <h3 id="deprecated">Deprecated features in ${version}</h3>
    <p>This release of Chrome had ${deprecated.length} features deprecated.</p>
    ${deprecated.map(item =>
  template`<h4>${item.name}</h4>
      <p>${escapeHtml(item.summary)} <a href=${item.launch_bug_url}>#</a></p>
      ${('motivation' in item) ? template`<p>${item.creator} created this feature because: <blockquote>${escapeHtml(item.motivation)}</blockquote></p>` : template``}
      <p>This feature was initially proposed in <a href=${item.initial_public_proposal_url}>${item.initial_public_proposal_url}</a></p>
      <p>This feature specified in "<a href=${item.standards.spec}>${escapeHtml(item.standards.status.text)}</a>"
      ${renderResources(item.resources)}`
)}`;

const renderRemovedFeatures = (removed, version) => template`
    <h3 id="removed">Removed features in ${version}</h3>
    <p>This release of Chrome had ${removed.length} features removed.</p>
    ${removed.map(item =>
  template`<h4>${item.name}</h4>
      <p>${escapeHtml(item.summary)} <a href=${item.launch_bug_url}>#</a></p>
      ${('motivation' in item) ? template`<p>${item.creator} created this feature because: <blockquote>${escapeHtml(item.motivation)}</blockquote></p>` : template``}
      <p>This feature was initially proposed in <a href=${item.initial_public_proposal_url}>${item.initial_public_proposal_url}</a></p>
      <p>This feature specified in "<a href=${item.standards.spec}>${escapeHtml(item.standards.status.text)}</a>"
      ${renderResources(item.resources)}`
)}`;

const getChannels = () => {
  return fetch(`https://chromestatus.com/api/v0/channels`)
    .then(resposnse => new Response(resposnse.body.pipeThrough(new StripStream()), {
      status: 200, headers: {
        'content-type': 'application/json'
      }
    }))
    .then(response => response.json());
};

const getVersions = async () => {
  const versionData = await getChannels();
  const lastVersion = Number.parseInt(versionData.canary.version);

  return [...Array(lastVersion).keys()].reverse();
};

const getFeaturesForVersion = (version) => {
  return fetch(`https://chromestatus.com/api/v0/features?milestone=${version}`)
    .then(resposnse => new Response(resposnse.body.pipeThrough(new StripStream()), {
      status: 200, headers: {
        'content-type': 'application/json'
      }
    }))
    .then(response => response.json());
};

export default async function render(request: Request): Response {
  const url = new URL(request.url);
  const version = url.searchParams.get("version") || 106;
  const versions = await getVersions();
  const features = await getFeaturesForVersion(version);

  return template`
  <!doctype html>
<html>

<head>
  <script src="/scripts/index.js" type="module"></script>
  <title>Chrome Release ${version}</title>
  <link rel="stylesheet" href="/styles/index.css">
</head>

<body>
  <h1>Create the release blog</h1>
  <form method="GET" action="">
    <label for="version">Chrome version</label>
    <select name="version" id="version">
      <option>Pick a version</option>
      ${template`${versions.map((item) => template`<option value=${item}>${item}</option>`)}`};
      </select>
      <noscript><input type=submit></noscript>
  </form>
  <div id="output">
  ${renderData(version, features)}
  </div>
</body>

</html>`
    .then(data => new Response(data, { status: 200, headers: { 'content-type': 'text/html' } }));
};