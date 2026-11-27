import template from "../flora.ts";
import type { StatusClient } from "../handler.ts";
import { formatStableDate } from "../lib/utils.ts";
import {
  htmlResponse,
  NO_STORE_CACHE_CONTROL,
} from "../ui-components/layout.ts";

export default async function render(
  request: Request,
  chromeStatusAPI: StatusClient,
): Promise<Response> {
  const url = new URL(request.url);
  let upstreamError = false;
  let tableContent: unknown;

  try {
    const deprecationsSort = (a: any, b: any) => {
      const aDesktop = a?.browsers?.chrome?.desktop;
      const bDesktop = b?.browsers?.chrome?.desktop;

      if (!aDesktop && !bDesktop) return 0;
      if (!bDesktop) return -1;
      if (!aDesktop) return 1;
      return Number.parseInt(bDesktop, 10) - Number.parseInt(aDesktop, 10);
    };

    const res = await chromeStatusAPI.getFeaturesByType(3);
    if (!res || !Array.isArray(res.features)) {
      throw new Error("Malformed deprecations response");
    }
    const deprecations = res.features
      .filter((f: any) => f && typeof f === "object" && f.id)
      .sort(deprecationsSort);

    const versions = deprecations
      .map((f: any) => f?.browsers?.chrome?.desktop)
      .filter((f: unknown) =>
        f !== undefined && Number.isFinite(Number.parseInt(String(f), 10))
      )
      .sort((a: unknown, b: unknown) =>
        Number.parseInt(String(a), 10) - Number.parseInt(String(b), 10)
      );

    const rawChannels = await chromeStatusAPI.getChannels(
      versions.at(0),
      versions.at(-1),
    );
    if (!rawChannels || typeof rawChannels !== "object") {
      throw new Error("Malformed channels response");
    }
    tableContent = template`
          <table>
          <tr>
              <th>Date</th>
              <th>Name</th>
              <th>Intent Stage</th>
              <th>Chrome Version</th>
          </tr>
          ${
      deprecations.map((deprecation: any) =>
        renderDeprecation(deprecation, rawChannels)
      )
    }
          </table>
      `;
  } catch {
    upstreamError = true;
    tableContent =
      template`<p class="error-notice">Unable to load deprecation calendar from chromestatus.com. Please try again later.</p>`;
  }

  return htmlResponse({
    title: "Chrome Deprecation Calendar",
    canonical: `https://chromestatuslite.com${url.pathname + url.search}`,
    description:
      "Calendar of Chrome web platform deprecations and removals sorted by Chrome milestone and estimated stable date.",
    currentPath: url.pathname,
    cacheControl: upstreamError ? NO_STORE_CACHE_CONTROL : undefined,
    body: template`<h1>Deprecation Calendar</h1>
  <div id="output">
    ${tableContent}
  </div>`,
  });
}

const renderDeprecation = (deprecation: any, channels: Record<string, any>) => {
  const desktopVersion = deprecation?.browsers?.chrome?.desktop;
  const channel = (channels && desktopVersion)
    ? channels[desktopVersion]
    : undefined;
  const date = formatStableDate(channel?.stable_date) ?? "N/A";

  const name = deprecation?.name || "Unnamed feature";
  const id = deprecation?.id ? encodeURIComponent(String(deprecation.id)) : "";
  const intentStage = deprecation?.intent_stage || "";
  const versionStr = desktopVersion || "";
  const versionCell = versionStr
    ? template`<a href="/?version=${versionStr}">${versionStr}</a>`
    : template`N/A`;
  return template`
        <tr>
            <td>${date}</td>
            <td><a href="/feature/${id}">${name}</a></td>
            <td>${intentStage}</td>
            <td>${versionCell}</td>
        </tr>
    `;
};
