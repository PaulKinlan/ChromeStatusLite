import template from "../flora.ts";
import type { StatusClient } from "../handler.ts";
import { escapeHtml } from "https://deno.land/x/escape_html/mod.ts";
import { format } from "https://deno.land/std@0.152.0/datetime/mod.ts";

import { sanitizeUrl } from "../lib/url.ts";
import nav from "../ui-components/nav.ts";

interface OriginTrialFeature {
  id: number | string;
  name?: string;
  summary?: string;
  motivation?: string;
  intent_stage?: string;
  standards?: { spec?: string };
  resources?: { docs?: string[]; samples?: string[] };
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

  let channelsData: any = null;
  let milestonesFeatures: any[] = [];
  let featureErrors = 0;
  let totalFeatureCalls = 0;

  if (recentVersions.length > 0) {
    try {
      totalFeatureCalls = recentVersions.length;
      const results = await Promise.all([
        chromeStatusAPI.getChannels().catch(() => ({})),
        chromeStatusAPI.getChannels(
          recentVersions[recentVersions.length - 1],
          recentVersions[0],
        ).catch(() => ({})),
        ...recentVersions.map((v) =>
          chromeStatusAPI.getFeaturesForVersion(v).catch(() => {
            featureErrors++;
            return {};
          })
        ),
      ]);
      channelsData = results[0];
      const milestoneChannels = results[1];
      milestonesFeatures = results.slice(2);

      // Merge milestone channels into channelsData if needed
      if (milestoneChannels && typeof milestoneChannels === "object") {
        channelsData = { ...channelsData, ...milestoneChannels };
      }
    } catch {
      upstreamError = true;
    }
  }

  // Determine current stable and dev versions
  const stableVersion = Number.parseInt(channelsData?.stable?.version || "", 10) ||
    (recentVersions.length > 2 ? recentVersions[2] : recentVersions[0]);
  const devVersion = Number.parseInt(channelsData?.dev?.version || "", 10) ||
    recentVersions[0];

  const trialsByMilestone: Map<number, OriginTrialFeature[]> = new Map();
  let totalActiveTrialsCount = 0;
  let totalPastTrialsCount = 0;

  for (let i = 0; i < recentVersions.length; i++) {
    const v = recentVersions[i];
    const featuresByType = milestonesFeatures[i] || {};
    const trials: OriginTrialFeature[] = featuresByType["Origin trial"] || [];
    if (trials.length > 0) {
      trialsByMilestone.set(v, trials);
      if (v >= stableVersion) {
        totalActiveTrialsCount += trials.length;
      } else {
        totalPastTrialsCount += trials.length;
      }
    }
  }

  const milestonesWithTrials = Array.from(trialsByMilestone.keys()).sort((a, b) => b - a);

  if (featureErrors > 0 && (featureErrors === totalFeatureCalls || (totalActiveTrialsCount === 0 && totalPastTrialsCount === 0))) {
    upstreamError = true;
  }

  const renderTrialItem = (item: OriginTrialFeature, milestone: number) => {
    const safeId = encodeURIComponent(String(item.id));
    const name = escapeHtml(item.name || "Unnamed origin trial");
    const summary = item.summary ? escapeHtml(item.summary) : "";
    const stage = item.intent_stage ? escapeHtml(item.intent_stage) : "Origin trial";
    const spec = sanitizeUrl(item.standards?.spec);

    let statusBadge = template`<span class="badge ot">Active in ${milestone}</span>`;
    if (milestone > devVersion) {
      statusBadge = template`<span class="badge ot upcoming">Upcoming in ${milestone}</span>`;
    } else if (milestone < stableVersion) {
      statusBadge = template`<span class="badge ot past">Ended (Chrome ${milestone})</span>`;
    }

    return template`
    <article class="origin-trial-item">
      <h3>
        <a href="/feature/${safeId}">${name}</a>
        ${statusBadge}
      </h3>
      <p>${summary}</p>
      <p><small>Stage: ${stage}</small>${spec ? template` | <small><a href="${spec}">Specification</a></small>` : template``}</p>
      ${item.motivation ? template`<blockquote><small>${escapeHtml(item.motivation)}</small></blockquote>` : template``}
    </article>`;
  };

  const renderMilestoneSection = (milestone: number) => {
    const trials = trialsByMilestone.get(milestone) || [];
    const channelData = channelsData?.[String(milestone)] ?? channelsData?.[milestone];
    const stableDate = channelData?.stable_date
      ? format(new Date(channelData.stable_date), "yyyy-MM-dd")
      : null;

    const isCurrentActive = milestone >= stableVersion && milestone <= devVersion;
    const isUpcoming = milestone > devVersion;
    const count = trials.length;
    const trialWord = count === 1 ? "trial" : "trials";
    const windowLabel = isCurrentActive
      ? `${count} active origin ${trialWord}`
      : isUpcoming
      ? `${count} upcoming origin ${trialWord}`
      : `${count} historical ${trialWord} (ended)`;

    return template`
    <section class="milestone-trials">
      <h2>
        Chrome ${milestone}
        ${stableDate ? template`<small class="milestone-date">(${stableDate})</small>` : template``}
      </h2>
      <p>${windowLabel} in this milestone</p>
      ${trials.map((t) => renderTrialItem(t, milestone))}
    </section>`;
  };

  let contentBody;
  if (upstreamError) {
    contentBody = template`<p class="error-notice">Unable to load origin trial data from chromestatus.com. Please try again later.</p>`;
  } else if (milestonesWithTrials.length > 0) {
    contentBody = milestonesWithTrials.map((m) => renderMilestoneSection(m));
  } else {
    contentBody = template`<p>No active origin trials found in recent milestones.</p>`;
  }

  return template`
  <!doctype html>
<html>

<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chrome Origin Trials Tracker</title>
  <link rel="canonical" href="https://chromestatuslite.com${escapeHtml(url.pathname + url.search)}">
  <link rel="stylesheet" href="/styles/index.css">
</head>

<body>
  ${nav()}
  <h1>Origin Trials Tracker</h1>
  <p>Track active experimental Origin Trials running in Chrome ${stableVersion}–${devVersion}, plus recent trial history (${totalActiveTrialsCount} active trials, ${totalPastTrialsCount} past trials).</p>
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
