import { html, render } from 'https://unpkg.com/lit-html?module';

const getVersions = async () => {
  const versionResponse = await fetch(`/api/channels`);
  const versionData = await versionResponse.json();

  const lastVersion = Number.parseInt(versionData.canary.version);

  return [...Array(lastVersion).keys()].reverse();
};

const updateUI = async (version) => {
  if (version == undefined) version = 100;

  const outputEl = document.getElementById("output");

  const versionResponse = await fetch(`/api/features?version=${version}`);
  const versionData = await versionResponse.json();

  const featuresByType = versionData.features_by_type;

  const enabled = featuresByType["Enabled by default"];
  const originTrials = featuresByType["Origin trial"];
  const flaggedFeatures = featuresByType["In developer trial (Behind a flag)"];
  const removed = featuresByType["Removed"];
  const deprecated = featuresByType["Deprecated"];

  render(html`
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
  `, outputEl);
}

window.addEventListener('popstate', (event) => {
  const url = new URL(location);
  const version = url.searchParams.get("version");

  updateUI(version);
});

onload = async () => {
  const versionEl = document.getElementById("version");
  const versions = await getVersions();

  render(html`${versions.map((item) => html`<option value=${item}>${item}</option>`)}`, versionEl);

  const url = new URL(location);
  const loadedVersion = url.searchParams.get("version");

  updateUI(loadedVersion);

  versionEl.onchange = async (e) => {
    const changedVersion = e.target.value;

    history.pushState({}, undefined, `/?version=${changedVersion}`);

    updateUI(changedVersion);
  };
};

const renderResources = (resources) => {
  return (resources.length > 0)
    ? html`<h4>Resources</h4>
      ${('docs' in resources) ? html`<p>Docs: ${resources.docs.map(resource => html`<a href=${resource}>${resource}</a>`)}</p>` : html`No linked docs`}</p>
      ${('samples' in resources) ? html`<p>Samples: ${resources.samples.map(resource => html`<a href=${resource}>${resource}</a>`)}</p>` : html`No linked samples`}</p>`
    : html``;
};

const renderEnabled = (enabled, version) => html`
    <h2 id="enabled">Enabled by default in ${version}</h2>
    <p>This realease of Chrome had ${enabled.length} new features.</p>
    ${enabled.map(item =>
  html`<h3>${item.name}</h3>
      <p>${item.summary} <a href=${item.launch_bug_url}>#</a></p>
      ${('motivation' in item) ? html`<p>${item.creator} created this feature because: <blockquote>${item.motivation}</blockquote></p>` : html``}
      <p>This feature was initially proposed in <a href=${item.initial_public_proposal_url}>${item.initial_public_proposal_url}</a></p>
      <p>This feature specified in "<a href=${item.standards.spec}>${item.standards.status.text}</a>"
      ${renderResources(item.resources)}`
)}`;

const renderOriginTrials = (ot, version) => html`
    <h2 id="origin-trial">Origin Trials in-progress in ${version}</h2>
    <p>This realease of Chrome had ${ot.length} new origin trials.</p>
    ${ot.map(item =>
  html`<h3>${item.name}</h3>
      <p>${item.summary} <a href=${item.launch_bug_url}>#</a></p>
      ${('motivation' in item) ? html`<p>${item.creator} created this feature because: <blockquote>${item.motivation}</blockquote></p>` : html``}
      <p>This feature was initially proposed in <a href=${item.initial_public_proposal_url}>${item.initial_public_proposal_url}</a></p>
      <p>This feature specified in "<a href=${item.standards.spec}>${item.standards.status.text}</a>"
      ${renderResources(item.resources)}``
)}`;

const renderFlaggedFeatures = (flagged, version) => html`
    <h2 id="flagged">Flagged features in ${version}</h2>
    <p>This realease of Chrome had ${flagged.length} are available behind a flag.</p>
    ${flagged.map(item =>
  html`<h3>${item.name}</h3>
      <p>${item.summary} <a href=${item.launch_bug_url}>#</a></p>
      ${('motivation' in item) ? html`<p>${item.creator} created this feature because: <blockquote>${item.motivation}</blockquote></p>` : html``}
      <p>This feature was initially proposed in <a href=${item.initial_public_proposal_url}>${item.initial_public_proposal_url}</a></p>
      <p>This feature specified in "<a href=${item.standards.spec}>${item.standards.status.text}</a>"
      ${renderResources(item.resources)}`
)}`;

const renderDeprecatedFeatures = (deprecated, version) => html`
    <h3 id="deprecated">Deprecated features in ${version}</h3>
    <p>This realease of Chrome had ${deprecated.length} features deprecated.</p>
    ${deprecated.map(item =>
  html`<h4>${item.name}</h4>
      <p>${item.summary} <a href=${item.launch_bug_url}>#</a></p>
      ${('motivation' in item) ? html`<p>${item.creator} created this feature because: <blockquote>${item.motivation}</blockquote></p>` : html``}
      <p>This feature was initially proposed in <a href=${item.initial_public_proposal_url}>${item.initial_public_proposal_url}</a></p>
      <p>This feature specified in "<a href=${item.standards.spec}>${item.standards.status.text}</a>"
      ${renderResources(item.resources)}``
)}`;

const renderRemovedFeatures = (removed, version) => html`
    <h3 id="removed">Removed features in ${version}</h3>
    <p>This realease of Chrome had ${removed.length} features removed.</p>
    ${removed.map(item =>
  html`<h4>${item.name}</h4>
      <p>${item.summary} <a href=${item.launch_bug_url}>#</a></p>
      ${('motivation' in item) ? html`<p>${item.creator} created this feature because: <blockquote>${item.motivation}</blockquote></p>` : html``}
      <p>This feature was initially proposed in <a href=${item.initial_public_proposal_url}>${item.initial_public_proposal_url}</a></p>
      <p>This feature specified in "<a href=${item.standards.spec}>${item.standards.status.text}</a>"
      ${renderResources(item.resources)}``
)}`;