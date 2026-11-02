import type { StatusClient } from "../handler.ts";
import { parseMilestoneParam } from "../lib/utils.ts";

export default async function apiVersion(
  request: Request,
  match: URLPatternResult,
  chromeStatusAPI: StatusClient,
): Promise<Response> {
  const corsHeaders: Record<string, string> = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "*",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  const versionParam = match?.pathname?.groups?.version;
  if (!versionParam) {
    return new Response(
      JSON.stringify({ error: "Missing version parameter" }),
      {
        status: 400,
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...corsHeaders,
        },
      },
    );
  }

  let milestone: number;
  // The upstream version list, once fetched (null = not fetched yet). It is
  // the whitelist every numeric milestone must pass before any
  // per-milestone fetch.
  let versions: any[] | null = null;
  if (versionParam === "latest") {
    try {
      versions = await chromeStatusAPI.getVersions();
      if (!Array.isArray(versions) || versions.length === 0) {
        return new Response(
          JSON.stringify({ error: "No Chrome versions found" }),
          {
            status: 404,
            headers: {
              "content-type": "application/json; charset=utf-8",
              ...corsHeaders,
            },
          },
        );
      }
      milestone = Number(versions[0]);
    } catch {
      return new Response(
        JSON.stringify({ error: "Failed to determine latest version" }),
        {
          status: 500,
          headers: {
            "content-type": "application/json; charset=utf-8",
            ...corsHeaders,
          },
        },
      );
    }
  } else {
    // Bounded at the seam (chrome-status-lite-s9w): an out-of-range or
    // overlong digit string is not a milestone and must not reach the
    // upstream query, where every distinct value mints two LRU keys
    // (features + channels) and two upstream calls before the route can
    // 404 it.
    const parsed = parseMilestoneParam(versionParam);
    if (parsed === null) {
      return new Response(
        JSON.stringify({
          error:
            "Invalid version parameter: expected integer milestone or 'latest'",
        }),
        {
          status: 400,
          headers: {
            "content-type": "application/json; charset=utf-8",
            ...corsHeaders,
          },
        },
      );
    }
    milestone = parsed;
  }

  // Whitelist before any per-milestone fetch (chrome-status-lite-or9): an
  // unknown milestone is answered 404 for the cost of one shared cached
  // lookup (getVersions caches under the single channels key for 1h), not
  // two cache-filling upstream calls per bogus value — otherwise a loop
  // over in-range values 1..2000 still evicts the whole working set.
  //
  // The whitelist is an optimisation, not a hard dependency (review
  // chrome-status-lite-j0p): when the version list itself is unavailable,
  // fall through and fetch the milestone directly - the parent answered
  // such requests from the features/channels endpoints alone, and the
  // try/catch below reports a genuine outage of those. An empty or failed
  // list must never 404 anything: that would state facts about features
  // during an outage.
  if (versions === null) {
    versions = await chromeStatusAPI.getVersions().catch(() => []);
  }
  if (Array.isArray(versions) && versions.length > 0 &&
      !versions.includes(milestone)) {
    return new Response(
      JSON.stringify({ error: `Chrome milestone ${milestone} not found` }),
      {
        status: 404,
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...corsHeaders,
        },
      },
    );
  }

  try {
    const [featuresByType, channels] = await Promise.all([
      chromeStatusAPI.getFeaturesForVersion(milestone),
      chromeStatusAPI.getChannels(milestone, milestone).catch(() => ({})),
    ]);

    const channelData = channels?.[String(milestone)] ?? channels?.[milestone] ?? null;
    const stableDate = channelData?.stable_date ?? null;

    const typeBuckets = (featuresByType && typeof featuresByType === "object")
      ? featuresByType
      : {};

    const features: any[] = [];
    for (const [statusType, list] of Object.entries(typeBuckets)) {
      if (Array.isArray(list)) {
        for (const item of list) {
          features.push({
            status_type: statusType,
            ...item,
          });
        }
      }
    }

    // Membership in the version list was verified before the fetches, so an
    // empty result is upstream data drift for a real milestone and serves
    // as a zero-feature response (chrome-status-lite-or9 removed the
    // redundant second getVersions() call here).

    const body = {
      version: milestone,
      stable_date: stableDate,
      total_features: features.length,
      features_by_type: typeBuckets,
      features,
    };

    return new Response(JSON.stringify(body, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=3600",
        ...corsHeaders,
      },
    });
  } catch {
    return new Response(
      JSON.stringify({
        error: "Failed to fetch milestone features",
      }),
      {
        status: 500,
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...corsHeaders,
        },
      },
    );
  }
}
