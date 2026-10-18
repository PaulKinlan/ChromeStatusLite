import template from "../flora.ts";
import { escapeHtml } from "https://deno.land/x/escape_html/mod.ts";

// Matches http(s) URLs only. Whitespace, angle brackets and both quote
// characters are excluded from the match, so a matched URL can neither
// open a tag nor break out of a double-quoted href attribute; other
// schemes (javascript:, data:, ...) never match at all.
const URL_RE = /https?:\/\/[^\s<>"']+/g;

// Trailing punctuation that usually belongs to the surrounding sentence
// rather than the URL (e.g. "see https://crbug.com/123.").
const TRAILING_PUNCTUATION = ".,;:!?)\u005d";

// Converts plain text into flora template nodes with http(s) URLs turned
// into clickable anchors. All non-URL text stays escaped plain text, and
// URL display text is escaped too, so upstream data can never inject
// markup through this path.
export default function linkify(text: string) {
  const nodes = [];
  let last = 0;
  if (text && typeof text === "string") {
    for (const match of text.matchAll(URL_RE)) {
      const start = match.index!;
      let url = match[0];
      let end = start + url.length;
      while (url.length > 0 && TRAILING_PUNCTUATION.includes(url[url.length - 1])) {
        url = url.slice(0, -1);
        end--;
      }
      if (end === start) continue;
      if (start > last) {
        nodes.push(template`${escapeHtml(text.slice(last, start))}`);
      }
      nodes.push(
        template`<a href="${url}" rel="noopener noreferrer">${escapeHtml(
          url
        )}</a>`
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
