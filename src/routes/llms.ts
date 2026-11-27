import type { StatusClient } from "../handler.ts";
import { hasValidBuckets } from "../lib/buckets.ts";
import { WIKI_TOPICS } from "../lib/wiki.ts";
import {
  HTML_CACHE_CONTROL,
  NO_STORE_CACHE_CONTROL,
} from "../ui-components/layout.ts";

const CANONICAL_ORIGIN = "https://chromestatuslite.com";

const FEATURE_BUCKETS: Array<[string, string]> = [
  ["Enabled by default", "Enabled by default"],
  ["Origin trial", "Origin trial"],
  ["In developer trial (Behind a flag)", "Behind a flag"],
  ["Deprecated", "Deprecated"],
  ["Removed", "Removed"],
];

function compactSummary(value: unknown, maxLen = 140): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1).trimEnd()}…`;
}

function renderLatestReleaseSection(
  version: string,
  featuresByType: Record<string, unknown>,
): string {
  const lines: string[] = [
    `## Latest Release Features (Chrome ${version})`,
    "",
    `Direct Markdown links for features in Chrome ${version} (drop \`.md\` for HTML or send \`Accept: text/markdown\` to any \`/feature/{id}\` URL):`,
    "",
  ];
  let total = 0;

  for (const [bucketKey, label] of FEATURE_BUCKETS) {
    const raw = featuresByType[bucketKey];
    if (!Array.isArray(raw) || raw.length === 0) continue;
    const items = raw.filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && "id" in item &&
        item.id !== undefined && item.id !== null,
    );
    if (items.length === 0) continue;

    lines.push(`### ${label} (${items.length})`, "");
    for (const item of items) {
      const id = encodeURIComponent(String(item.id));
      const name = typeof item.name === "string" && item.name.trim()
        ? item.name.trim().replace(/\s+/g, " ")
        : `Feature ${id}`;
      const summary = compactSummary(item.summary);
      lines.push(
        summary
          ? `- [${name}](${CANONICAL_ORIGIN}/feature/${id}.md): ${summary}`
          : `- [${name}](${CANONICAL_ORIGIN}/feature/${id}.md)`,
      );
      total++;
    }
    lines.push("");
  }

  return total > 0 ? lines.join("\n") : "";
}

export default async function render(
  _request: Request,
  chromeStatusAPI: StatusClient,
): Promise<Response> {
  let latestSection = "";
  let upstreamOk = false;

  try {
    const versions = await chromeStatusAPI.getVersions();
    if (Array.isArray(versions) && versions.length > 0) {
      const latest = String(versions[0]);
      const features = await chromeStatusAPI.getFeaturesForVersion(latest);
      if (features && typeof features === "object" && hasValidBuckets(features)) {
        latestSection = renderLatestReleaseSection(
          latest,
          features as Record<string, unknown>,
        );
        upstreamOk = true;
      }
    }
  } catch {
    upstreamOk = false;
  }

  const topicLines = WIKI_TOPICS.map(
    (topic) =>
      `- [${topic.title}](${CANONICAL_ORIGIN}/wiki/${topic.slug}.md): ${topic.description}`,
  );

  const sections = [
    `# ChromeStatusLite

> Fast, zero-JavaScript, server-rendered reader over the Chrome Platform Status API (\`chromestatus.com/api/v0\`) with Baseline status from \`webstatus.dev\`. Built by Paul Kinlan for quick access to Chrome release details for both humans and agents that cannot run JavaScript.

## For Agents & Content Negotiation

- **Markdown via \`Accept\` header:** Send \`Accept: text/markdown\` to any HTML route (including any individual feature at \`${CANONICAL_ORIGIN}/feature/{id}\`) to receive clean Markdown with \`Content-Type: text/markdown; charset=utf-8\`, \`Vary: Accept\`, \`X-Markdown-Tokens\`, absolute links, and GFM tables.
- **Markdown via \`.md\` URLs:** Append \`.md\` to any page URL when custom headers are unavailable — for example \`${CANONICAL_ORIGIN}/index.md\`, \`${CANONICAL_ORIGIN}/feature/{id}.md\`, \`${CANONICAL_ORIGIN}/deprecations.md\`, \`${CANONICAL_ORIGIN}/wiki/webgpu.md\`, or \`${CANONICAL_ORIGIN}/about.md\`.
- **No JavaScript required:** Every HTML page is complete server-rendered semantic HTML.
- **Discovering any historical feature:** Fetch \`${CANONICAL_ORIGIN}/?version={milestone}\` (or \`/index.md?version={milestone}\`), \`${CANONICAL_ORIGIN}/api/version/{milestone}\`, \`${CANONICAL_ORIGIN}/deprecations.md\`, or any topic wiki page to find feature IDs, then fetch \`${CANONICAL_ORIGIN}/feature/{id}.md\` (or \`/feature/{id}\` with \`Accept: text/markdown\`).

## Core Pages

- [Home / Latest Chrome Release](${CANONICAL_ORIGIN}/index.md): Release summary grouped by Enabled by default, Origin trial, Behind a flag, Deprecated, and Removed. Pass \`?version={milestone}\` (e.g. \`${CANONICAL_ORIGIN}/index.md?version=135\`) for any Chrome milestone.
- [Compare Releases](${CANONICAL_ORIGIN}/diff.md): Side-by-side comparison of two Chrome releases (\`?from={m1}&to={m2}\`).
- [Breaking Changes Timeline](${CANONICAL_ORIGIN}/breaking.md): Deprecated APIs, removals, and breaking changes across recent Chrome milestones with enterprise impact.
- [Origin Trials Tracker](${CANONICAL_ORIGIN}/origin-trials.md): Active, upcoming, and historical Chrome Origin Trials.
- [Deprecation Calendar](${CANONICAL_ORIGIN}/deprecations.md): GFM Markdown table of deprecated/removed features sorted by Chrome milestone and estimated UTC stable date.
- [Feature Detail Template](${CANONICAL_ORIGIN}/feature/{id}.md): Full details for any ChromeStatus feature ID — summary, motivation, Baseline status & browser versions (\`webstatus.dev\`), cross-browser signals (Firefox, Safari, web developers), WPT results, specs, docs, and samples. Also available at \`${CANONICAL_ORIGIN}/feature/{id}\` with \`Accept: text/markdown\`.
- [Feature Snapshot History](${CANONICAL_ORIGIN}/feature/{id}/history.md): Change history captured lazily as readers view \`/feature/{id}\`.
- [Feature Snapshot Diff](${CANONICAL_ORIGIN}/feature/{id}/diff.md): Field-by-field diff between stored captures (\`?from={iso}&to={iso}\`).
- [Topic Wiki Directory](${CANONICAL_ORIGIN}/wiki.md): Curated web platform topic pages with cross-browser consensus, stage groupings, and timelines.
- [About ChromeStatusLite](${CANONICAL_ORIGIN}/about.md): Background on Paul Kinlan, why ChromeStatusLite was created, and how to use \`/llms.txt\` and \`text/markdown\`.`,
  ];

  if (latestSection) {
    sections.push(latestSection.trimEnd());
  }

  sections.push(`## Topic Wiki Slugs

Each slug resolves as HTML at \`${CANONICAL_ORIGIN}/wiki/{slug}\` and as Markdown at \`${CANONICAL_ORIGIN}/wiki/{slug}.md\` (or with \`Accept: text/markdown\`):

${topicLines.join("\n")}

## Machine-Readable Endpoints

- [Latest Milestone JSON](${CANONICAL_ORIGIN}/api/version/latest): JSON payload with \`version\`, \`stable_date\`, \`total_features\`, \`features_by_type\`, and \`features\`.
- [Milestone JSON by Number](${CANONICAL_ORIGIN}/api/version/{milestone}): Same JSON schema for any available integer Chrome milestone.
- [RSS 2.0 Feed](${CANONICAL_ORIGIN}/feed.xml): Recent Chrome releases (\`?limit=1..25\`, default 10).

## Optional

- [Paul Kinlan](https://paul.kinlan.me/): Creator of ChromeStatusLite.
- [Source Repository](https://github.com/PaulKinlan/ChromeStatusLite): GitHub repository (Cloudflare Workers + D1).
- [Chrome Platform Showcase](https://chrome-platform-showcase.com): Interactive demos for new Chrome platform features.
- [GenDN](https://gendn.dev): Generated API reference documentation for Chrome features not yet on MDN.
- [Web Platform Dashboard](https://webstatus.dev): Baseline status and browser interoperability tracker.
- [Chrome Platform Status](https://chromestatus.com): Upstream data source.
`);

  return new Response(sections.join("\n\n"), {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": upstreamOk ? HTML_CACHE_CONTROL : NO_STORE_CACHE_CONTROL,
    },
  });
}
