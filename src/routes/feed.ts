import type { StatusClient } from "../handler.ts";

function escapeXml(unsafe: string): string {
  return unsafe
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function cdata(content: string): string {
  return `<![CDATA[${content.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

export default async function feed(
  request: Request,
  chromeStatusAPI: StatusClient,
): Promise<Response> {
  const url = new URL(request.url);
  const limitParam = Number.parseInt(url.searchParams.get("limit") || "10", 10);
  const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 10, 1), 25);

  let versions: number[] = [];
  try {
    const rawVersions = await chromeStatusAPI.getVersions();
    if (Array.isArray(rawVersions)) {
      versions = rawVersions.map((v) => Number(v)).filter((v) => Number.isFinite(v));
    }
  } catch {
    versions = [];
  }

  const selectedVersions = versions.slice(0, limit);

  const [channels, ...milestonesFeatures] = await Promise.all([
    chromeStatusAPI.getChannels().catch(() => ({})),
    ...selectedVersions.map((v) =>
      chromeStatusAPI.getFeaturesForVersion(v).catch(() => ({}))
    ),
  ]);

  const itemsXml: string[] = [];

  for (let i = 0; i < selectedVersions.length; i++) {
    const version = selectedVersions[i];
    const featuresByType = milestonesFeatures[i] || {};

    const enabled: any[] = featuresByType["Enabled by default"] || [];
    const originTrials: any[] = featuresByType["Origin trial"] || [];
    const flagged: any[] = featuresByType["In developer trial (Behind a flag)"] || [];
    const deprecated: any[] = featuresByType["Deprecated"] || [];
    const removed: any[] = featuresByType["Removed"] || [];

    const totalCount =
      enabled.length +
      originTrials.length +
      flagged.length +
      deprecated.length +
      removed.length;

    const channelData = channels?.[String(version)];
    const stableDate = channelData?.stable_date;
    const pubDateTag = stableDate
      ? `      <pubDate>${new Date(stableDate).toUTCString()}</pubDate>\n`
      : "";

    const formatList = (title: string, list: any[]) => {
      if (!list || list.length === 0) return "";
      const items = list
        .map((item) => {
          const name = escapeXml(String(item.name || "Unnamed feature"));
          const summary = item.summary ? escapeXml(String(item.summary)) : "";
          const link = `https://chromestatuslite.com/feature/${item.id}`;
          return `<li><a href="${link}">${name}</a>${summary ? `: ${summary}` : ""}</li>`;
        })
        .join("");
      return `<h3>${title} (${list.length})</h3><ul>${items}</ul>`;
    };

    const descriptionHtml = [
      `<p>Chrome ${version} includes ${totalCount} feature changes.</p>`,
      formatList("Enabled by default", enabled),
      formatList("Origin Trials", originTrials),
      formatList("In developer trial (Behind a flag)", flagged),
      formatList("Deprecated", deprecated),
      formatList("Removed", removed),
    ]
      .filter(Boolean)
      .join("\n");

    const itemLink = `https://chromestatuslite.com/?version=${version}`;

    itemsXml.push(`    <item>
      <title>Chrome ${version}</title>
      <link>${escapeXml(itemLink)}</link>
      <guid isPermaLink="true">${escapeXml(itemLink)}</guid>
${pubDateTag}      <description>${cdata(descriptionHtml)}</description>
    </item>`);
  }

  const now = new Date().toUTCString();
  const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Chrome Status Lite</title>
    <link>https://chromestatuslite.com/</link>
    <description>Recent Chrome releases and feature updates</description>
    <language>en-us</language>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="https://chromestatuslite.com/feed.xml" rel="self" type="application/rss+xml"/>
${itemsXml.join("\n")}
  </channel>
</rss>`;

  return new Response(rssXml, {
    status: 200,
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
