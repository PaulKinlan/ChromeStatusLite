import template from "../flora.ts";
import { escapeHtml } from "https://deno.land/x/escape_html/mod.ts";

// Trackers and code hosts whose references turn up in chromestatus prose
// without a scheme (e.g. "crbug.com/500967896", "github.com/whatwg/html/pull/123").
const BARE_HOSTS = [
  "crbug\\.com",
  "issues\\.chromium\\.org",
  "github\\.com",
  "bugs\\.webkit\\.org",
  "bugzilla\\.mozilla\\.org",
  "wpt\\.fyi",
  "chromestatus\\.com",
  "drafts\\.csswg\\.org",
].join("|");

// Matches http(s) URLs plus scheme-less references on BARE_HOSTS. Whitespace,
// angle brackets and both quote characters are excluded from every match, so a
// matched URL can neither open a tag nor break out of a double-quoted href
// attribute; other schemes (javascript:, data:, ftp:) never match at all.
// The lookbehind keeps a bare host from matching inside a longer host name.
const URL_RE = new RegExp(
  `(https?://[^\\s<>"']+|(?<![\\w.@/:-])(?:${BARE_HOSTS})/[^\\s<>"']+)`,
  "g",
);

// Trailing punctuation that usually belongs to the surrounding sentence
// rather than the URL (e.g. "see https://crbug.com/123.").
const TRAILING_PUNCTUATION = ".,;:!?)\u005d";

// Converts plain text into flora template nodes with URLs turned into
// clickable anchors. All non-URL text stays escaped plain text, and URL
// display text is escaped too, so upstream data can never inject markup
// through this path. A scheme-less reference is displayed as written and
// linked with an explicit https scheme.
export default function linkify(text: string) {
  const nodes = [];
  let last = 0;
  if (text && typeof text === "string") {
    for (const match of text.matchAll(URL_RE)) {
      const start = match.index!;
      let href = match[0];
      let end = start + href.length;
      while (
        href.length > 0 && TRAILING_PUNCTUATION.includes(href[href.length - 1])
      ) {
        href = href.slice(0, -1);
        end--;
      }
      if (end === start) continue;
      if (start > last) {
        nodes.push(template`${escapeHtml(text.slice(last, start))}`);
      }
      nodes.push(
        template`<a href="${href.startsWith("http") ? href : `https://${href}`}" rel="noopener noreferrer">${escapeHtml(
          href,
        )}</a>`,
      );
      last = end;
    }
    if (last < text.length) {
      nodes.push(template`${escapeHtml(text.slice(last))}`);
    }
  }
  if (nodes.length === 0) return template``;
  if (nodes.length === 1) return nodes[0];
  return nodes;
}
