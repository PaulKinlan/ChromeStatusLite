import template from "../flora.ts";
import type { StatusClient } from "../handler.ts";
import { formatStableDate } from "../lib/utils.ts";

import nav from "../ui-components/nav.ts";

export default async function render(request: Request, chromeStatusAPI: StatusClient): Response {
  const url = new URL(request.url);
  return template`
  <!doctype html>
<html>

<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chrome Deprecation Calendar</title>
  <link rel="canonical" href="https://chromestatuslite.com${url.pathname + url.search}">
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

    // Map features to browser versions, removing features that don't have a
    // version. A defined-but-unparseable milestone (desktop: "") must be
    // excluded too: getChannels() strictly coerces its bounds
    // (chrome-status-lite-3tl) and
    // throws on a NaN bound, so letting such a value through poisons
    // versions.at(0) and crashes the whole calendar into the error-notice
    // instead of rendering its 'N/A' row (chrome-status-lite-b6s). The
    // filter mirrors getChannels' own Number.parseInt acceptance exactly.
    const versions = deprecations
        .map(f => f?.browsers?.chrome?.desktop)
        .filter(f =>
          f !== undefined && Number.isFinite(Number.parseInt(String(f), 10))
        )
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

  let name = deprecation?.name || 'Unnamed feature';
  let id = deprecation?.id ? encodeURIComponent(String(deprecation.id)) : '';
  let intentStage = deprecation?.intent_stage || '';
  let versionStr = desktopVersion || '';
  // A feature with no desktop milestone has nothing to link to (the release
  // summary defaults to latest), so the cell is plain text, not an empty
  // dead anchor (chrome-status-lite-5i3). 'N/A' matches the date column.
  let versionCell = versionStr
    ? template`<a href="/?version=${versionStr}">${versionStr}</a>`
    : template`N/A`;
  return template`
        <tr>
            <td>${date}</td>
            <td><a href="/feature/${id}">${name}</a></td>
            <td>${intentStage}</td>
            <td>${versionCell}</td>
        </tr>
    `;
};

