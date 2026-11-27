import template from "../flora.ts";
import type { StatusClient } from "../handler.ts";
import linkify from "../lib/linkify.ts";
import {
  htmlResponse,
  NO_STORE_CACHE_CONTROL,
} from "../ui-components/layout.ts";

const STATUSES = [
  "Enabled by default",
  "Origin trial",
  "In developer trial (Behind a flag)",
  "Deprecated",
  "Removed",
];

// A milestone response records what happened *in that release*, not the full
// set of features currently available.
const renderMilestone = (version: string, groups: Record<string, any[]>) =>
  template`
  <section class="diff-milestone" aria-label="Chrome ${version} release notes">
    <h2>Chrome ${version}</h2>
    ${
    STATUSES.map((status) => {
      const items = groups[status] || [];
      return template`<section>
        <h3>${status} (${items.length})</h3>
        ${
        items.length
          ? template`<ul>${
            items.map((item) =>
              template`<li>
          <a href="/feature/${encodeURIComponent(String(item.id))}">${item.name}</a>
          ${item.summary ? template`<p>${linkify(item.summary)}</p>` : template``}
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
  const valid = !upstreamError && Boolean(from) && Boolean(to) &&
    versions.includes(from) && versions.includes(to);
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
    url.pathname + url.search
  }`;
  const option = (version: string, selected: string) =>
    template`<option value="${version}"${
      version === selected ? template` selected` : template``
    }>Chrome ${version}</option>`;

  let diffContent: unknown;
  if (upstreamError) {
    diffContent =
      template`<p class="error-notice">Unable to load release comparison from chromestatus.com. Please try again later.</p>`;
  } else if (!valid) {
    diffContent =
      template`<p role="alert">Choose two available Chrome milestones to compare.</p>`;
  } else {
    diffContent = template`
      ${
      from === to
        ? template`<p>Both selections are Chrome ${from}. Choose different milestones to compare releases.</p>`
        : template``
    }
      <div class="diff-columns">
        ${renderMilestone(from, fromGroups)}
        ${renderMilestone(to, toGroups)}
      </div>`;
  }

  // TODO(baseline/webmcp-form-attributes): Annotate the milestone <form> below
  // with toolname/tooldescription once WebMCP declarative form attributes
  // reach Baseline.
  return htmlResponse({
    status,
    cacheControl: upstreamError || status !== 200
      ? NO_STORE_CACHE_CONTROL
      : undefined,
    title: "Compare Chrome milestones — Chrome Platform Status",
    canonical,
    description:
      "Compare Chrome features side by side across any two Chrome milestones.",
    currentPath: url.pathname,
    extraStylesheets: ["/styles/diff.css"],
    body: template`<h1>Compare Chrome milestones</h1>
    <p>Compare features recorded for two Chrome releases, grouped by their milestone status. These are release notes, not a complete inventory of browser support.</p>
    <form method="get" action="/diff" class="diff-form">
      <div class="field">
        <label for="from">From milestone</label>
        <select id="from" name="from" required>${
      versions.map((version: string) => option(version, from))
    }</select>
      </div>
      <div class="field">
        <label for="to">To milestone</label>
        <select id="to" name="to" required>${
      versions.map((version: string) => option(version, to))
    }</select>
      </div>
      <button type="submit">Compare milestones</button>
    </form>
    ${diffContent}`,
  });
}
