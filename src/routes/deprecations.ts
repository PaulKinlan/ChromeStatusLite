import template from "../flora.ts";
import type { StatusClient } from "../handler.ts";
import { formatStableDate } from "../lib/utils.ts";
import { escapeHtml } from "https://deno.land/x/escape_html/mod.ts";

import nav from "../ui-components/nav.ts";

export default async function render(request: Request, chromeStatusAPI: StatusClient): Response {
  const url = new URL(request.url);
  return template`
  <!doctype html>
<html>

<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="/scripts/deprecations.js" type="module"></script>
  <title>Chrome Deprecation Calendar</title>
  <link rel="canonical" href="https://chromestatuslite.com${escapeHtml(url.pathname + url.search)}">
  <link rel="stylesheet" href="/styles/index.css">
</head>

<body>
  ${nav()}
  <h1>Deprecation Calendar</h1>
  <div id="output">
    ${renderDeprecations(chromeStatusAPI)}
  </div>
</body>

</html>`
    .then(data => new Response(data, { status: 200, headers: { 'content-type': 'text/html' } }));
}

const renderDeprecations = async (chromeStatusAPI: StatusClient) => {
  try {
    const deprecationsSort = (a, b) => {
      const aDesktop = a?.browsers?.chrome?.desktop;
      const bDesktop = b?.browsers?.chrome?.desktop;

      // Move features without versions to end of list.
      if (!aDesktop && !bDesktop) {
        return 0;
      }
      if (!bDesktop) {
        return -1;
      }
      if (!aDesktop) {
        return 1;
      }

      // Sort by most recent feature.
      return parseInt(bDesktop) - parseInt(aDesktop);
    };

    const res = await chromeStatusAPI.getFeaturesByType(3);
    if (!res || !Array.isArray(res.features)) {
      throw new Error("Malformed deprecations response");
    }
    const deprecations = res.features
      .filter((f) => f && typeof f === "object" && f.id)
      .sort(deprecationsSort);

    // Map features to browser versions, removing features that don't have version.
    const versions = deprecations
        .map(f => f?.browsers?.chrome?.desktop)
        .filter(f => f !== undefined)
        .sort((a, b) => parseInt(a) - parseInt(b));

    const rawChannels = await chromeStatusAPI.getChannels(versions.at(0), versions.at(-1));
    if (!rawChannels || typeof rawChannels !== "object") {
      throw new Error("Malformed channels response");
    }
    const channels = rawChannels;
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
  } catch {
    return template`<p class="error-notice">Unable to load deprecation calendar from chromestatus.com. Please try again later.</p>`;
  }
};

const renderDeprecation = (deprecation, channels) => {
  const desktopVersion = deprecation?.browsers?.chrome?.desktop;
  let channel = (channels && desktopVersion) ? channels[desktopVersion] : undefined;
  let date = formatStableDate(channel?.stable_date) ?? 'N/A';

  let name = escapeHtml(deprecation?.name || 'Unnamed feature');
  let id = deprecation?.id ? encodeURIComponent(String(deprecation.id)) : '';
  let intentStage = escapeHtml(deprecation?.intent_stage || '');
  let versionStr = escapeHtml(desktopVersion || '');
  return template`
        <tr>
            <td>${date}</td>
            <td><a href="https://chromestatus.com/feature/${id}">${name}</a></td>
            <td>${intentStage}</td>
            <td><a href="/?version=${versionStr}">${versionStr}</a></td>
        </tr>
    `;
};

