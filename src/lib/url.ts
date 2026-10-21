import { escapeHtml } from "https://deno.land/x/escape_html/mod.ts";

// Sanitizes an upstream-derived URL for use in an href. Only http: and
// https: schemes are admitted; the returned value is HTML-escaped and safe
// to interpolate into an attribute. Anything else (javascript:, data:,
// relative paths, unparseable input) returns null so callers drop the link
// entirely rather than rendering a clickable script URL.
export function sanitizeUrl(urlStr?: string): string | null {
  if (!urlStr || typeof urlStr !== "string") return null;
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return escapeHtml(urlStr);
    }
  } catch {
    // invalid URL format
  }
  return null;
}
