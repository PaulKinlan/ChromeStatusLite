import type { StatusClient } from "../handler.ts";

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
  if (versionParam === "latest") {
    try {
      const versions = await chromeStatusAPI.getVersions();
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
  } else if (/^\d+$/.test(versionParam)) {
    milestone = Number.parseInt(versionParam, 10);
  } else {
    return new Response(
      JSON.stringify({
        error: "Invalid version parameter: expected integer milestone or 'latest'",
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

    if (features.length === 0) {
      const versions = await chromeStatusAPI.getVersions().catch(() => []);
      if (Array.isArray(versions) && !versions.includes(milestone)) {
        return new Response(
          JSON.stringify({
            error: `Chrome milestone ${milestone} not found`,
          }),
          {
            status: 404,
            headers: {
              "content-type": "application/json; charset=utf-8",
              ...corsHeaders,
            },
          },
        );
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
