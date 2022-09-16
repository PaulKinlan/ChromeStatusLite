import template from "../flora.ts";
import { getVersions, getChannels } from "../lib/utils.ts";
import { StripStream } from "../stream-utils.ts";
import { format } from "https://deno.land/std@0.152.0/datetime/mod.ts";

export default async function render(request: Request): Response {

  const versions = await getVersions();

  return template`
  <!doctype html>
<html>

<head>
  <script src="/scripts/index.js" type="module"></script>
  <title>Chrome Deprection Calendar</title>
  <link rel="stylesheet" href="/styles/index.css">
</head>

<body>
  <h1>Deprecation Calendar</h1>
  <form method="GET" action="/deprecations">
    <label for="version">Chrome version</label>
    <select name="version" id="version">
      <option>Pick a version</option>
      ${template`${versions.map((item) => template`<option value=${item}>${item}</option>`)}`};
      </select>
      <noscript><input type=submit></noscript>
  </form>
  <div id="output">
    ${renderDeprecations()}
  </div>
</body>

</html>`
    .then(data => new Response(data, { status: 200, headers: { 'content-type': 'text/html' } }));
}

const renderDeprecations = async () => {
  const deprecations = (await getDeprecations()).sort((a, b) => a.browsers.chrome.desktop - b.browsers.chrome.desktop);
  const versions = deprecations.map((f) => { return f.browsers.chrome.desktop; }).sort();
  const channels = await getChannels(versions.at(0), versions.at(-1));
  return template`
      <table>
      <tr>
          <th>Date</th>
          <th>Name</th>
          <th>Chrome Version</th>
      </tr>
      ${deprecations.map(deprecation => renderDeprecation(deprecation, channels))}
      </table>
  `;
};

const renderDeprecation = async (deprecation, channels) => {
  let channel = channels[deprecation.browsers.chrome.desktop];
  let date = new Date(channel.stable_date);
  return template`
      <tr>
          <td>${format(date, 'yyyy-MM-dd')}</td>
          <td>${deprecation.name}</td>
          <td>${deprecation.browsers.chrome.desktop}</td>
      </tr>
  `;
};

const getFeatures = () => {
  return fetch(`https://chromestatus.com/api/v0/features`)
    .then(response => new Response(response.body.pipeThrough(new StripStream()), {
      status: 200, headers: {
        'content-type': 'application/json'
      }
    }))
    .then(response => response.json());
};

const getDeprecations = async () => {
  let features = await getFeatures();
  return features.features.filter(f => f['feature_type_int'] === 3)
}