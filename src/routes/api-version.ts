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
          "cache-control": "no-store",
          ...corsHeaders,
        },
      },
    );
  }

  let milestone: number;
  let versions: unknown[] | null = null;
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
              "cache-control": "no-store",
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
            "cache-control": "no-store",
            ...corsHeaders,
          },
        },
      );
    }
  } else {
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
            "cache-control": "no-store",
            ...corsHeaders,
          },
        },
      );
    }
    milestone = parsed;
  }

  if (versions === null) {
    versions = await chromeStatusAPI.getVersions().catch(() => []);
  }
  if (
    Array.isArray(versions) && versions.length > 0 &&
    !versions.includes(milestone)
  ) {
    return new Response(
      JSON.stringify({ error: `Chrome milestone ${milestone} not found` }),
      {
        status: 404,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
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

    const channelData = channels?.[String(milestone)] ?? channels?.[milestone] ??
      null;
    const stableDate = channelData?.stable_date ?? null;

    const typeBuckets = (featuresByType && typeof featuresByType === "object")
      ? featuresByType
      : {};

    const features: unknown[] = [];
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
        "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
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
          "cache-control": "no-store",
          ...corsHeaders,
        },
      },
    );
  }
}
