import type { StatusClient } from "../handler.ts";
import { hasValidBuckets } from "../lib/buckets.ts";

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
  let upstreamError = false;
  try {
    const rawVersions = await chromeStatusAPI.getVersions();
    if (Array.isArray(rawVersions)) {
      versions = rawVersions.map((v) => Number(v)).filter((v) => Number.isFinite(v));
      if (versions.length === 0) {
        upstreamError = true;
      }
    } else {
      upstreamError = true;
    }
  } catch {
    upstreamError = true;
    versions = [];
  }

  if (upstreamError) {
    const errorRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Chrome Status Lite</title>
    <link>https://chromestatuslite.com/</link>
    <description>Unable to load release data from chromestatus.com. Please try again later.</description>
    <atom:link href="https://chromestatuslite.com/feed.xml" rel="self" type="application/rss+xml"/>
    <item>
      <title>Notice: Unable to load release feed</title>
      <link>https://chromestatuslite.com/</link>
      <guid isPermaLink="false">https://chromestatuslite.com/notice/upstream-error</guid>
      <pubDate>${new Date().toUTCString()}</pubDate>
      <description>${cdata("<p>Unable to load release data from chromestatus.com. Please try again later.</p>")}</description>
    </item>
  </channel>
</rss>`;
    return new Response(errorRss, {
      status: 200,
      headers: {
        "content-type": "application/rss+xml; charset=utf-8",
      },
    });
  }

  const selectedVersions = versions.slice(0, limit);
  const minMilestone = selectedVersions.length > 0 ? Math.min(...selectedVersions) : undefined;
  const maxMilestone = selectedVersions.length > 0 ? Math.max(...selectedVersions) : undefined;

  // A failed fetch or a malformed payload for a milestone is an upstream
  // outage, not data: it must never render as an authoritative "Chrome N
  // includes 0 feature changes". Validity is decided by the same shared
  // validator the / release page uses, so both routes agree on what real
  // data looks like (a genuinely empty milestone stays valid).
  const [channels, ...milestones] = await Promise.all([
    (minMilestone !== undefined && maxMilestone !== undefined)
      ? chromeStatusAPI.getChannels(minMilestone, maxMilestone).catch(() => ({}))
      : Promise.resolve({}),
    ...selectedVersions.map(async (v) => {
      try {
        const buckets = await chromeStatusAPI.getFeaturesForVersion(v);
        return { ok: hasValidBuckets(buckets), buckets };
      } catch {
        return { ok: false as const, buckets: null };
      }
    }),
  ]);

  const formatList = (title: string, list: any[]) => {
    if (!list || list.length === 0) return "";
    const items = list
      .map((item) => {
        const name = escapeXml(String(item.name || "Unnamed feature"));
        const summary = item.summary ? escapeXml(String(item.summary)) : "";
        const safeId = encodeURIComponent(String(item.id));
        const link = `https://chromestatuslite.com/feature/${safeId}`;
        return `<li><a href="${escapeXml(link)}">${name}</a>${summary ? `: ${summary}` : ""}</li>`;
      })
      .join("");
    return `<h3>${escapeXml(title)} (${list.length})</h3><ul>${items}</ul>`;
  };

  const itemsXml: string[] = [];

  for (let i = 0; i < selectedVersions.length; i++) {
    const version = selectedVersions[i];
    const milestone = milestones[i];
    const featuresByType = milestone.ok ? milestone.buckets : null;

    const typeBuckets = (featuresByType && typeof featuresByType === "object")
      ? featuresByType
      : {};

    let totalCount = 0;
    const bucketSections: string[] = [];
    for (const [statusType, list] of Object.entries(typeBuckets)) {
      if (Array.isArray(list) && list.length > 0) {
        totalCount += list.length;
        bucketSections.push(formatList(statusType, list));
      }
    }

    const channelData = channels?.[String(version)] ?? channels?.[version];
    const stableDate = channelData?.stable_date;
    const pubDateTag = stableDate
      ? `      <pubDate>${new Date(stableDate).toUTCString()}</pubDate>\n`
      : "";

    const descriptionHtml = milestone.ok
      ? [
        `<p>Chrome ${version} includes ${totalCount} feature changes.</p>`,
        ...bucketSections,
      ]
        .filter(Boolean)
        .join("\n")
      : `<p>Unable to load feature data for Chrome ${version} from chromestatus.com. Please try again later.</p>`;

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
