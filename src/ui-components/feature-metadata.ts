import template from "../flora.ts";
import { escapeHtml } from "https://deno.land/x/escape_html/mod.ts";

// The milestone API returns a summary (including impact and maturity), while
// flag_name and WPT are normally only present in the individual feature API.
// Omit unavailable fields rather than implying a negative answer.
type FeatureMetadata = {
  breaking_change?: boolean;
  enterprise_impact?: number;
  flag_name?: string;
  wpt?: boolean;
  standards?: { maturity?: { short_text?: string; text?: string } };
};

export const renderFeatureMetadata = (
  feature: FeatureMetadata,
  detailed = false,
) => {
  const impacts: Record<number, string> = {
    1: "None",
    2: "Low",
    3: "Medium",
    4: "High",
  };
  const impact = feature.enterprise_impact === undefined
    ? undefined
    : impacts[feature.enterprise_impact];
  const maturity = feature.standards?.maturity?.short_text ||
    feature.standards?.maturity?.text;
  const rows: ([string, string] | null)[] = [
    typeof feature.breaking_change === "boolean" &&
      (detailed || feature.breaking_change)
      ? ["Breaking change", feature.breaking_change ? "Yes" : "No"]
      : null,
    impact && (detailed || impact !== "None")
      ? ["Enterprise impact", impact]
      : null,
    feature.flag_name ? ["Chromium flag", feature.flag_name] : null,
    maturity ? ["Spec maturity", maturity] : null,
    typeof feature.wpt === "boolean"
      ? ["Web Platform Tests", feature.wpt ? "Yes" : "No"]
      : null,
  ];
  const visibleRows = rows.filter((row): row is [string, string] =>
    row !== null
  );
  if (!visibleRows.length) return template``;
  return template`<ul class="feature-metadata">${
    visibleRows.map(([label, value]) =>
      template`<li><strong>${escapeHtml(label)}:</strong> ${
        escapeHtml(value)
      }</li>`
    )
  }</ul>`;
};
