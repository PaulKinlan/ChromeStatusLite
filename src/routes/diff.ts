import template from "../flora.ts";
import type { StatusClient } from "../handler.ts";
import { escapeHtml } from "https://deno.land/x/escape_html/mod.ts";
import nav from "../ui-components/nav.ts";

const STATUSES = [
  "Enabled by default",
  "Origin trial",
  "In developer trial (Behind a flag)",
  "Deprecated",
  "Removed",
];

// A milestone response records what happened *in that release*, not the full
// set of features currently available. Avoid describing an absent record as a
// feature removed from the web platform.
const renderMilestone = (version: string, groups: Record<string, any[]>) =>
  template`
  <section class="diff-milestone" aria-label="Chrome ${
    escapeHtml(version)
  } release notes">
    <h2>Chrome ${escapeHtml(version)}</h2>
    ${
    STATUSES.map((status) => {
      const items = groups[status] || [];
      return template`<section>
        <h3>${escapeHtml(status)} (${items.length})</h3>
        ${
        items.length
          ? template`<ul>${
            items.map((item) =>
              template`<li>
          <a href="/feature/${encodeURIComponent(String(item.id))}">${
                escapeHtml(item.name)
              }</a>
          ${
                item.summary
                  ? template`<p>${escapeHtml(item.summary)}</p>`
                  : template``
              }
        </li>`
            )
          }</ul>`
          : template`<p>None recorded.</p>`
      }
      </section>`;
    })
  }
  </section>`;

export default async function render(
  request: Request,
  client: StatusClient,
): Promise<Response> {
  const url = new URL(request.url);
  let versions: string[] = [];
  let upstreamError = false;

  try {
    versions = (await client.getVersions()).map(String);
  } catch {
    upstreamError = true;
  }

  const from = url.searchParams.get("from") ?? versions[1] ?? versions[0] ?? "";
  const to = url.searchParams.get("to") ?? versions[0] ?? "";
  const valid = !upstreamError && from && to && versions.includes(from) && versions.includes(to);
  // Do not send an arbitrary user-supplied milestone to the upstream API.
  const status = upstreamError ? 200 : (valid ? 200 : 400);

  let groups: any[] = [];
  if (valid && !upstreamError) {
    try {
      groups = await Promise.all([
        client.getFeaturesForVersion(from),
        from === to ? Promise.resolve(null) : client.getFeaturesForVersion(to),
      ]);
    } catch {
      upstreamError = true;
    }
  }

  const fromGroups = groups[0] || {};
  const toGroups = from === to ? fromGroups : groups[1] || {};
  const canonical = `https://chromestatuslite.com${
    escapeHtml(url.pathname + url.search)
  }`;
  const option = (version: string, selected: string) =>
    template`<option value="${escapeHtml(version)}"${
      version === selected ? " selected" : ""
    }>Chrome ${escapeHtml(version)}</option>`;

  let diffContent;
  if (upstreamError) {
    diffContent = template`<p class="error-notice">Unable to load release comparison from chromestatus.com. Please try again later.</p>`;
  } else if (!valid) {
    diffContent = template`<p role="alert">Choose two available Chrome milestones to compare.</p>`;
  } else {
    diffContent = template`
      ${
        from === to
          ? template`<p>Both selections are Chrome ${
            escapeHtml(from)
          }. Choose different milestones to compare releases.</p>`
          : template``
      }
      <div class="diff-columns">
        ${renderMilestone(from, fromGroups)}
        ${renderMilestone(to, toGroups)}
      </div>`;
  }

  return template`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Compare Chrome milestones — Chrome Platform Status</title>
  <link rel="canonical" href="${canonical}">
  <link rel="stylesheet" href="/styles/index.css">
  <link rel="stylesheet" href="/styles/diff.css">
</head>
<body>
  ${nav()}
  <main>
    <h1>Compare Chrome milestones</h1>
    <p>Compare features recorded for two Chrome releases, grouped by their milestone status. These are release notes, not a complete inventory of browser support.</p>
    <form method="get" action="/diff">
      <label for="from">From milestone</label>
      <select id="from" name="from" required>${
    versions.map((version: string) => option(version, from))
  }</select>
      <label for="to">To milestone</label>
      <select id="to" name="to" required>${
    versions.map((version: string) => option(version, to))
  }</select>
      <button type="submit">Compare milestones</button>
    </form>
    ${diffContent}
  </main>
</body>
</html>`.then((html) =>
    new Response(html, { status, headers: { "content-type": "text/html" } })
  );
}
