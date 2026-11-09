// Sanitizes an upstream-derived URL for use in an href. Only http: and
// https: schemes are admitted; the returned value is the parser's
// serialization of the URL that passed that check — not the raw input — so
// the emitted href equals the validated value by construction rather than
// by trust (whitespace/control padding, backslash-as-slash, case, and
// characters the parser percent-encodes are all normalized first). The
// return value is NOT HTML-escaped: every consumer interpolates it into a
// flora template, which escapes strings at interpolation.
// Anything else (javascript:, data:, relative paths, unparseable input)
// returns null so callers drop the link entirely rather than rendering a
// clickable script URL.
export function sanitizeUrl(urlStr?: string): string | null {
  if (!urlStr || typeof urlStr !== "string") return null;
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch {
    // invalid URL format
  }
  return null;
}
