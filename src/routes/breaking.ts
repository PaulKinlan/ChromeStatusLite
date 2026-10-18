import template from "../flora.ts";
import type { StatusClient } from "../handler.ts";
import { escapeHtml } from "https://deno.land/x/escape_html/mod.ts";
import { format } from "https://deno.land/std@0.152.0/datetime/mod.ts";

import nav from "../ui-components/nav.ts";

interface Feature {
  id: number | string;
  name?: string;
  summary?: string;
  motivation?: string;
  intent_stage?: string;
  breaking_change?: boolean;
  enterprise_impact?: number;
  browsers?: {
    chrome?: {
      desktop?: string;
      status?: { text?: string; milestone_str?: string };
    };
  };
}

export default async function render(
  request: Request,
  chromeStatusAPI: StatusClient,
): Promise<Response> {
  const url = new URL(request.url);

  let versions: number[] = [];
  let upstreamError = false;

  try {
    const rawVersions = await chromeStatusAPI.getVersions();
    if (Array.isArray(rawVersions)) {
      versions = rawVersions.map((v) => Number(v)).filter((v) => Number.isFinite(v));
    }
  } catch {
    upstreamError = true;
    versions = [];
  }

  const recentVersions = versions.slice(0, 10);

  let deprecationsData: any = { features: [] };
  let milestonesFeatures: any[] = [];
  let featureErrors = 0;
  let totalFeatureCalls = 0;

  if (recentVersions.length > 0) {
    try {
      totalFeatureCalls = 1 + recentVersions.length;
      const results = await Promise.all([
        chromeStatusAPI.getFeaturesByType(3).catch(() => {
          featureErrors++;
          return { features: [] };
        }),
        ...recentVersions.map((v) =>
          chromeStatusAPI.getFeaturesForVersion(v).catch(() => {
            featureErrors++;
            return {};
          })
        ),
      ]);
      deprecationsData = results[0];
      milestonesFeatures = results.slice(1);
    } catch {
      upstreamError = true;
    }
  }

  const allBreakingFeatures: Map<string | number, { milestone: number; feature: Feature; type: string }> = new Map();

  // 1. Process deprecations from type 3 query
  const deprecationList: Feature[] = deprecationsData?.features || [];
  for (const item of deprecationList) {
    const milestoneStr = item.browsers?.chrome?.desktop || item.browsers?.chrome?.status?.milestone_str;
    const m = milestoneStr ? Number.parseInt(milestoneStr, 10) : undefined;
    if (m && Number.isFinite(m)) {
      allBreakingFeatures.set(item.id, { milestone: m, feature: item, type: "Deprecated" });
    }
  }

  // 2. Process features from recent milestones
  for (let i = 0; i < recentVersions.length; i++) {
    const v = recentVersions[i];
    const featuresByType = milestonesFeatures[i] || {};
    const deprecated = featuresByType["Deprecated"] || [];
    const removed = featuresByType["Removed"] || [];

    for (const item of deprecated) {
      allBreakingFeatures.set(item.id, { milestone: v, feature: item, type: "Deprecated" });
    }
    for (const item of removed) {
      allBreakingFeatures.set(item.id, { milestone: v, feature: item, type: "Removed" });
    }

    // Also collect features with explicit breaking_change: true
    for (const [statusType, list] of Object.entries(featuresByType)) {
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item?.breaking_change === true && !allBreakingFeatures.has(item.id)) {
            allBreakingFeatures.set(item.id, { milestone: v, feature: item, type: "Breaking change" });
          }
        }
      }
    }
  }

  // Group by milestone
  const byMilestone: Map<number, { feature: Feature; type: string }[]> = new Map();
  for (const entry of allBreakingFeatures.values()) {
    const list = byMilestone.get(entry.milestone) || [];
    list.push({ feature: entry.feature, type: entry.type });
    byMilestone.set(entry.milestone, list);
  }

  const sortedMilestones = Array.from(byMilestone.keys()).sort((a, b) => b - a);

  let channels: Record<string, any> = {};
  if (sortedMilestones.length > 0) {
    const minM = sortedMilestones[sortedMilestones.length - 1];
    const maxM = sortedMilestones[0];
    channels = await chromeStatusAPI.getChannels(minM, maxM).catch(() => ({}));
  }

  const renderBadge = (type: string) => {
    return template`<span class="badge ${escapeHtml(type.toLowerCase().replace(/\s+/g, "-"))}">${escapeHtml(type)}</span>`;
  };

  const renderEnterpriseBadge = (level?: number) => {
    if (level === undefined) return template``;
    const impacts: Record<number, string> = {
      1: "None",
      2: "Low",
      3: "Medium",
      4: "High",
    };
    const impact = impacts[level];
    if (!impact || impact === "None") return template``;
    return template`<span class="badge impact">Enterprise: ${impact}</span>`;
  };

  const renderFeatureItem = (item: Feature, type: string) => {
    const safeId = encodeURIComponent(String(item.id));
    const name = escapeHtml(item.name || "Unnamed feature");
    const summary = item.summary ? escapeHtml(item.summary) : "";
    const stage = item.intent_stage ? escapeHtml(item.intent_stage) : "";

    return template`
    <article class="breaking-item">
      <h3>
        <a href="/feature/${safeId}">${name}</a>
        ${renderBadge(type)}
        ${renderEnterpriseBadge(item.enterprise_impact)}
      </h3>
      <p>${summary}</p>
      ${stage ? template`<p><small>Intent stage: ${stage}</small></p>` : template``}
      ${item.motivation ? template`<blockquote><small>${escapeHtml(item.motivation)}</small></blockquote>` : template``}
    </article>`;
  };

  const renderMilestoneSection = (milestone: number) => {
    const items = byMilestone.get(milestone) || [];
    const channelData = channels?.[String(milestone)] ?? channels?.[milestone];
    const stableDate = channelData?.stable_date
      ? format(new Date(channelData.stable_date), "yyyy-MM-dd")
      : null;

    return template`
    <section class="milestone-timeline">
      <h2>
        Chrome ${milestone}
        ${stableDate ? template`<small class="milestone-date">(${stableDate})</small>` : template``}
      </h2>
      <p>${items.length} breaking or deprecated feature${items.length === 1 ? "" : "s"}</p>
      ${items.map(({ feature, type }) => renderFeatureItem(feature, type))}
    </section>`;
  };

  const totalCount = allBreakingFeatures.size;
  if (featureErrors > 0 && (featureErrors === totalFeatureCalls || totalCount === 0)) {
    upstreamError = true;
  }

  const upstreamTotal = deprecationsData?.total_count;
  const upstreamNote = upstreamTotal && upstreamTotal > deprecationList.length
    ? template`; ${upstreamTotal} deprecations tracked upstream`
    : template``;

  let contentBody;
  if (upstreamError) {
    contentBody = template`<p class="error-notice">Unable to load breaking change data from chromestatus.com. Please try again later.</p>`;
  } else if (sortedMilestones.length > 0) {
    contentBody = sortedMilestones.map((m) => renderMilestoneSection(m));
  } else {
    contentBody = template`<p>No breaking changes found in recent milestones.</p>`;
  }

  return template`
  <!doctype html>
<html>

<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chrome Breaking Changes Timeline</title>
  <link rel="canonical" href="https://chromestatuslite.com${escapeHtml(url.pathname + url.search)}">
  <link rel="stylesheet" href="/styles/index.css">
</head>

<body>
  ${nav()}
  <h1>Breaking Changes &amp; Deprecations Timeline</h1>
  <p>Track deprecated APIs, removals, and breaking changes across Chrome releases (showing ${totalCount} tracked changes across Chrome milestones${upstreamNote}).</p>
  <div id="output">
    ${contentBody}
  </div>
</body>

</html>`.then(
    (data) =>
      new Response(data, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
  );
}
