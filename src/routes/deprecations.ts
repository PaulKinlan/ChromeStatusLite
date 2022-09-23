import template from "../flora.ts";
import { ChromeStatusAPI } from "../lib/utils.ts";
import { StripStream } from "../stream-utils.ts";
import { format } from "https://deno.land/std@0.152.0/datetime/mod.ts";
import { escapeHtml } from "https://deno.land/x/escape_html/mod.ts";

import nav from "../ui-components/nav.ts";

export default async function render(request: Request): Response {
  return template`
  <!doctype html>
<html>

<head>
  <script src="/scripts/deprecations.js" type="module"></script>
  <title>Chrome Deprection Calendar</title>
  <link rel="stylesheet" href="/styles/index.css">
</head>

<body>
  ${nav()}
  <h1>Deprecation Calendar</h1>
  <div id="output">
    ${renderDeprecations()}
  </div>
</body>

</html>`
    .then(data => new Response(data, { status: 200, headers: { 'content-type': 'text/html' } }));
}

const renderDeprecations = async () => {
  const deprecationsSort = (a, b) => {
    // Move features without versions to end of list.
    if (!b.browsers.chrome.desktop) {
      return -1;
    }

    if (!a.browsers.chrome.desktop) {
      return 1;
    }

    // Sort by most recent feature.
    return parseInt(b.browsers.chrome.desktop) - parseInt(a.browsers.chrome.desktop);
  };

  const deprecations = (await getDeprecations()).sort(deprecationsSort);

  // Map features to browser versions, removing features that don't have version.
  const versions = deprecations
      .map(f => f.browsers.chrome.desktop)
      .filter(f => f !== undefined)
      .sort((a, b) => parseInt(a) - parseInt(b));

  const chromeStatusAPI = ChromeStatusAPI.getInstance();
  const channels = await chromeStatusAPI.getChannels(versions.at(0), versions.at(-1));
  return template`
        <table>
        <tr>
            <th>Date</th>
            <th>Name</th>
            <th>Intent Stage</th>
            <th>Chrome Version</th>
        </tr>
        ${deprecations.map(deprecation => renderDeprecation(deprecation, channels))}
        </table>
    `;
};

const renderDeprecation = async (deprecation, channels) => {
  let channel = channels[deprecation.browsers.chrome.desktop];
  let date = 'N/A';
  if (channel && channel.stable_date) {
    date = format(new Date(channel.stable_date), 'yyyy-MM-dd');
  }

  let name = escapeHtml(deprecation.name);
  return template`
        <tr>
            <td>${date}</td>
            <td><a href="https://chromestatus.com/feature/${deprecation.id}">${name}</a></td>
            <td>${escapeHtml(deprecation.intent_stage)}</td>
            <td><a href="/?version=${deprecation.browsers.chrome.desktop}">${deprecation.browsers.chrome.desktop}</a></td>
        </tr>
    `;
};

const getDeprecations = async () => {
  const chromeStatusAPI = ChromeStatusAPI.getInstance();
  return (await chromeStatusAPI.getFeaturesByType(3)).features;
}
