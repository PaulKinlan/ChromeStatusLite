import { html, render } from 'https://unpkg.com/lit-html?module';

const getVersions = async () => {
  const versionResponse = await fetch(`/api/channels`);



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
  <a href="#enabled">Enabled</a> | <a href="#origin-trial">Origin Trial</a> | <a href="#flagged">Flagged</a> | <a href="#deprecated">Deprecated</a> | <a href="#removed">Removed</a>
  ${renderEnabled(enabled, version)}
  ${renderOriginTrials(originTrials, version)}
  ${renderFlaggedFeatures(flaggedFeatures, version)}
  ${renderDeprecatedFeatures(deprecated, version)}
  ${renderRemovedFeatures(removed, version)}
  `, outputEl);
}

window.addEventListener('popstate', (event) => {
  const url = new URL(location);
  const version = url.searchParams.get("version");

  updateUI(version);
});

onload = () => {
  const versionEl = document.getElementById("version");
  const versions = [...Array(107).keys()].reverse();

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

const renderEnabled = (enabled, version) => html`
    <h2 id="enabled">Enabled by default in ${version}</h2>
    <p>This realease of Chrome had ${enabled.length} new features.</p>
    ${enabled.map(item =>
  html`<h3>${item.name}</h3>
      <p>${item.summary} <a href=${item.launch_bug_url}>#</a></p>
      ${('motivation' in item) ? html`<p>${item.creator} created this feature because: <blockquote>${item.motivation}</blockquote></p>` : html``}
      <p>This feature was initially proposed in <a href=${item.initial_public_proposal_url}>${item.initial_public_proposal_url}</a></p>
      <p>This feature specified in "<a href=${item.standards.spec}>${item.standards.status.text}</a>"
      <h4>Resources</h4>
      ${('docs' in item.resources) ? html`<p>Docs: ${item.resources.docs.map(resource => html`<a href=${resource}>${resource}</a>`)}</p>` : html`No linked docs`}</p>
      ${('samples' in item.resources) ? html`<p>Samples: ${item.resources.samples.map(resource => html`<a href=${resource}>${resource}</a>`)}</p>` : html`No linked samples`}</p>`
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
      <h4>Resources</h4>
      ${('docs' in item.resources) ? html`<p>Docs: ${item.resources.docs.map(resource => html`<a href=${resource}>${resource}</a>`)}</p>` : html`No linked docs`}</p>
      ${('samples' in item.resources) ? html`<p>Samples: ${item.resources.samples.map(resource => html`<a href=${resource}>${resource}</a>`)}</p>` : html`No linked samples`}</p>`
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
      <h4>Resources</h4>
      ${('docs' in item.resources) ? html`<p>Docs: ${item.resources.docs.map(resource => html`<a href=${resource}>${resource}</a>`)}</p>` : html`No linked docs`}</p>
      ${('samples' in item.resources) ? html`<p>Samples: ${item.resources.samples.map(resource => html`<a href=${resource}>${resource}</a>`)}</p>` : html`No linked samples`}</p>`
)}`;

const renderDeprecatedFeatures = (deprecated, version) => html`
    <h2 id="deprecated">Deprecated features in ${version}</h2>
    <p>This realease of Chrome had ${deprecated.length} features deprecated.</p>
    ${deprecated.map(item =>
  html`<h3>${item.name}</h3>
      <p>${item.summary} <a href=${item.launch_bug_url}>#</a></p>
      ${('motivation' in item) ? html`<p>${item.creator} created this feature because: <blockquote>${item.motivation}</blockquote></p>` : html``}
      <p>This feature was initially proposed in <a href=${item.initial_public_proposal_url}>${item.initial_public_proposal_url}</a></p>
      <p>This feature specified in "<a href=${item.standards.spec}>${item.standards.status.text}</a>"
      <h4>Resources</h4>
      ${('docs' in item.resources) ? html`<p>Docs: ${item.resources.docs.map(resource => html`<a href=${resource}>${resource}</a>`)}</p>` : html`No linked docs`}</p>
      ${('samples' in item.resources) ? html`<p>Samples: ${item.resources.samples.map(resource => html`<a href=${resource}>${resource}</a>`)}</p>` : html`No linked samples`}</p>`
)}`;

const renderRemovedFeatures = (removed, version) => html`
    <h2 id="removed">Removed features in ${version}</h2>
    <p>This realease of Chrome had ${removed.length} features removed.</p>
    ${removed.map(item =>
  html`<h3>${item.name}</h3>
      <p>${item.summary} <a href=${item.launch_bug_url}>#</a></p>
      ${('motivation' in item) ? html`<p>${item.creator} created this feature because: <blockquote>${item.motivation}</blockquote></p>` : html``}
      <p>This feature was initially proposed in <a href=${item.initial_public_proposal_url}>${item.initial_public_proposal_url}</a></p>
      <p>This feature specified in "<a href=${item.standards.spec}>${item.standards.status.text}</a>"
      <h4>Resources</h4>
      ${('docs' in item.resources) ? html`<p>Docs: ${item.resources.docs.map(resource => html`<a href=${resource}>${resource}</a>`)}</p>` : html`No linked docs`}</p>
      ${('samples' in item.resources) ? html`<p>Samples: ${item.resources.samples.map(resource => html`<a href=${resource}>${resource}</a>`)}</p>` : html`No linked samples`}</p>`
)}`;