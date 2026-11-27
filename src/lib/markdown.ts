// Content negotiation and lightweight, zero-dependency HTML-to-Markdown
// conversion for `Accept: text/markdown` requests (agents, CLI tools, LLMs).

const CANONICAL_ORIGIN = "https://chromestatuslite.com";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  larr: "←",
  rarr: "→",
  mdash: "—",
  ndash: "–",
};

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const SKIP_TAGS = new Set([
  "form",
  "noscript",
  "script",
  "style",
  "svg",
  "template",
]);

const BLOCK_TAGS = new Set([
  "article",
  "aside",
  "blockquote",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "ul",
]);

interface TextNode {
  type: "text";
  value: string;
}

interface ElementNode {
  type: "el";
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
}

type HtmlNode = TextNode | ElementNode;

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (full, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const code = Number.parseInt(entity.slice(2), 16);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : full;
      }
      if (entity.startsWith("#")) {
        const code = Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : full;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? full;
    },
  );
}

/**
 * Returns true when the request's `Accept` header explicitly asks for
 * `text/markdown` with a non-zero quality factor at least as high as
 * `text/html`. Standard browser headers (`text/html, *\/*`) return false.
 */
export function prefersMarkdown(request: Request): boolean {
  const accept = request.headers.get("accept");
  if (!accept) return false;

  let mdQ: number | null = null;
  let htmlQ = 0;

  for (const part of accept.split(",")) {
    const segments = part.split(";").map((s) => s.trim()).filter(Boolean);
    if (segments.length === 0) continue;
    const type = segments[0].toLowerCase();
    if (type !== "text/markdown" && type !== "text/html") continue;

    let q = 1;
    for (let i = 1; i < segments.length; i++) {
      const m = /^q\s*=\s*([0-9]*\.?[0-9]+)$/i.exec(segments[i]);
      if (m) {
        const parsed = Number.parseFloat(m[1]);
        if (Number.isFinite(parsed)) q = Math.min(1, Math.max(0, parsed));
      }
    }

    if (type === "text/markdown") {
      mdQ = mdQ === null ? q : Math.max(mdQ, q);
    } else if (type === "text/html") {
      htmlQ = Math.max(htmlQ, q);
    }
  }

  return mdQ !== null && mdQ > 0 && mdQ >= htmlQ;
}

function isWhitespaceCode(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

function isTagNameChar(code: number): boolean {
  return (
    (code >= 97 && code <= 122) || // a-z
    (code >= 65 && code <= 90) || // A-Z
    (code >= 48 && code <= 57) || // 0-9
    code === 45 || // -
    code === 58 // :
  );
}

/**
 * Single-pass O(n) HTML tokenizer and tree builder. Decodes entities on text
 * and attribute values exactly once so decoded `<tag>` literals and Markdown
 * autolinks are never stripped or double-decoded later.
 */
function parseHtml(html: string): HtmlNode[] {
  const root: ElementNode = { type: "el", tag: "#root", attrs: {}, children: [] };
  const stack: ElementNode[] = [root];
  const len = html.length;
  let pos = 0;

  while (pos < len) {
    const lt = html.indexOf("<", pos);
    if (lt === -1) {
      if (pos < len) {
        stack[stack.length - 1].children.push({
          type: "text",
          value: decodeEntities(html.slice(pos)),
        });
      }
      break;
    }

    if (lt > pos) {
      stack[stack.length - 1].children.push({
        type: "text",
        value: decodeEntities(html.slice(pos, lt)),
      });
    }

    // Comment <!-- ... -->
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      pos = end === -1 ? len : end + 3;
      continue;
    }

    // Declaration / doctype <! ... > or processing instruction <? ... >
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt + 2);
      pos = end === -1 ? len : end + 1;
      continue;
    }

    // Closing tag </tag>
    if (html.startsWith("</", lt)) {
      const end = html.indexOf(">", lt + 2);
      if (end === -1) {
        pos = len;
        break;
      }
      const closeTag = html.slice(lt + 2, end).trim().toLowerCase();
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tag === closeTag) {
          stack.length = i;
          break;
        }
      }
      pos = end + 1;
      continue;
    }

    // Opening tag <tag ...>
    let cursor = lt + 1;
    while (cursor < len && isTagNameChar(html.charCodeAt(cursor))) cursor++;
    if (cursor === lt + 1) {
      // Bare '<' not starting a tag
      stack[stack.length - 1].children.push({ type: "text", value: "<" });
      pos = lt + 1;
      continue;
    }

    const tag = html.slice(lt + 1, cursor).toLowerCase();
    const attrs: Record<string, string> = {};
    let selfClosing = false;

    while (cursor < len) {
      while (cursor < len && isWhitespaceCode(html.charCodeAt(cursor))) cursor++;
      if (cursor >= len) break;
      const ch = html[cursor];
      if (ch === ">") {
        cursor++;
        break;
      }
      if (ch === "/" && html[cursor + 1] === ">") {
        selfClosing = true;
        cursor += 2;
        break;
      }

      const nameStart = cursor;
      while (
        cursor < len &&
        !isWhitespaceCode(html.charCodeAt(cursor)) &&
        html[cursor] !== "=" &&
        html[cursor] !== ">" &&
        html[cursor] !== "/"
      ) {
        cursor++;
      }
      if (cursor === nameStart) {
        cursor++;
        continue;
      }
      const attrName = html.slice(nameStart, cursor).toLowerCase();
      while (cursor < len && isWhitespaceCode(html.charCodeAt(cursor))) cursor++;

      let attrValue = "";
      if (html[cursor] === "=") {
        cursor++;
        while (cursor < len && isWhitespaceCode(html.charCodeAt(cursor))) cursor++;
        const quote = html[cursor];
        if (quote === '"' || quote === "'") {
          cursor++;
          const valStart = cursor;
          const valEnd = html.indexOf(quote, valStart);
          if (valEnd === -1) {
            attrValue = decodeEntities(html.slice(valStart));
            cursor = len;
          } else {
            attrValue = decodeEntities(html.slice(valStart, valEnd));
            cursor = valEnd + 1;
          }
        } else {
          const valStart = cursor;
          while (
            cursor < len &&
            !isWhitespaceCode(html.charCodeAt(cursor)) &&
            html[cursor] !== ">"
          ) {
            cursor++;
          }
          attrValue = decodeEntities(html.slice(valStart, cursor));
        }
      }
      attrs[attrName] = attrValue;
    }

    const el: ElementNode = { type: "el", tag, attrs, children: [] };
    stack[stack.length - 1].children.push(el);
    if (!selfClosing && !VOID_TAGS.has(tag)) {
      stack.push(el);
    }
    pos = cursor;
  }

  return root.children;
}

function hasClass(el: ElementNode, className: string): boolean {
  const cls = el.attrs.class;
  if (!cls) return false;
  return cls.split(/\s+/).includes(className);
}

function shouldSkip(el: ElementNode): boolean {
  if (SKIP_TAGS.has(el.tag)) return true;
  if (el.tag === "details" && hasClass(el, "more-versions")) return true;
  return false;
}

function findFirstElement(
  nodes: HtmlNode[],
  predicate: (el: ElementNode) => boolean,
): ElementNode | undefined {
  for (const node of nodes) {
    if (node.type !== "el") continue;
    if (predicate(node)) return node;
    const found = findFirstElement(node.children, predicate);
    if (found) return found;
  }
  return undefined;
}

function collectElements(
  nodes: HtmlNode[],
  tag: string,
  out: ElementNode[] = [],
): ElementNode[] {
  for (const node of nodes) {
    if (node.type !== "el") continue;
    if (shouldSkip(node)) continue;
    if (node.tag === tag) {
      out.push(node);
    } else {
      collectElements(node.children, tag, out);
    }
  }
  return out;
}

function resolveHref(rawHref: string, baseUrl: string): string {
  const trimmed = rawHref.trim();
  if (!trimmed || trimmed.startsWith("#")) return trimmed;
  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return trimmed;
  }
}

function collapseInline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function collapseLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderPlainText(nodes: HtmlNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") {
      out += node.value;
    } else if (!shouldSkip(node)) {
      if (node.tag === "br") out += "\n";
      else out += renderPlainText(node.children);
    }
  }
  return out;
}

function formatCodeSpan(text: string): string {
  if (!text) return "";
  if (!text.includes("`")) return `\`${text}\``;
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `\`\`${pad}${text}${pad}\`\``;
}

function renderInline(nodes: HtmlNode[], baseUrl: string): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") {
      out += node.value.replace(/\r?\n/g, " ");
      continue;
    }
    if (shouldSkip(node)) continue;

    switch (node.tag) {
      case "br":
        out += "\n";
        break;
      case "a": {
        const href = resolveHref(node.attrs.href ?? "", baseUrl);
        const label = collapseInline(renderInline(node.children, baseUrl));
        if (!href) {
          out += label;
        } else if (!label || label === href) {
          out += `<${href}>`;
        } else {
          out += `[${label}](${href})`;
        }
        break;
      }
      case "code": {
        const text = collapseInline(renderPlainText(node.children));
        out += formatCodeSpan(text);
        break;
      }
      case "strong":
      case "b": {
        const text = collapseInline(renderInline(node.children, baseUrl));
        if (text) out += `**${text}**`;
        break;
      }
      case "em":
      case "i": {
        const text = collapseInline(renderInline(node.children, baseUrl));
        if (text) out += `*${text}*`;
        break;
      }
      case "span": {
        if (hasClass(node, "badge")) {
          const text = collapseInline(renderPlainText(node.children));
          if (text) out += ` [${text}]`;
        } else {
          out += renderInline(node.children, baseUrl);
        }
        break;
      }
      default:
        out += renderInline(node.children, baseUrl);
        break;
    }
  }
  return out;
}

function renderTable(table: ElementNode, baseUrl: string): string {
  const trNodes = collectElements(table.children, "tr");
  const rows: string[][] = [];
  for (const tr of trNodes) {
    const cells: string[] = [];
    for (const child of tr.children) {
      if (child.type === "el" && (child.tag === "th" || child.tag === "td")) {
        const text = collapseInline(renderInline(child.children, baseUrl))
          .replace(/\|/g, "\\|");
        cells.push(text);
      }
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return "";
  const colCount = Math.max(...rows.map((r) => r.length));
  const padRow = (r: string[]) =>
    `| ${Array.from({ length: colCount }, (_, i) => r[i] ?? "").join(" | ")} |`;
  const sep = `| ${Array.from({ length: colCount }, () => "---").join(" | ")} |`;
  return [padRow(rows[0]), sep, ...rows.slice(1).map(padRow)].join("\n");
}

function renderDl(dl: ElementNode, baseUrl: string): string {
  const lines: string[] = [];
  let currentTerm = "";
  for (const child of dl.children) {
    if (child.type !== "el") continue;
    if (child.tag === "dt") {
      currentTerm = collapseInline(renderInline(child.children, baseUrl));
    } else if (child.tag === "dd") {
      const def = collapseInline(renderInline(child.children, baseUrl));
      if (currentTerm) {
        lines.push(`- **${currentTerm}:** ${def}`);
        currentTerm = "";
      } else if (def) {
        lines.push(`- ${def}`);
      }
    }
  }
  return lines.join("\n");
}

function renderList(
  list: ElementNode,
  ordered: boolean,
  baseUrl: string,
): string {
  const items: string[] = [];
  let index = 1;
  for (const child of list.children) {
    if (child.type !== "el" || child.tag !== "li") continue;
    const hasBlockChild = child.children.some(
      (c) => c.type === "el" && BLOCK_TAGS.has(c.tag),
    );
    const body = hasBlockChild
      ? renderBlocks(child.children, baseUrl).join("\n")
      : collapseLines(renderInline(child.children, baseUrl));
    const lines = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) continue;
    const prefix = ordered ? `${index++}. ` : "- ";
    const indent = " ".repeat(prefix.length);
    items.push(
      lines
        .map((line, i) => (i === 0 ? `${prefix}${line}` : `${indent}${line}`))
        .join("\n"),
    );
  }
  return items.join("\n");
}

function renderDiffBlock(block: ElementNode, baseUrl: string): string {
  const lines: string[] = [];
  for (const child of block.children) {
    if (child.type !== "el") continue;
    if (hasClass(child, "diff-field")) {
      const heading = collapseInline(renderInline(child.children, baseUrl));
      if (heading) lines.push(`### ${heading}`);
    } else if (hasClass(child, "diff-line")) {
      const line = collapseInline(renderInline(child.children, baseUrl));
      if (line) lines.push(line);
    }
  }
  return lines.join("\n");
}

function renderBlocks(nodes: HtmlNode[], baseUrl: string): string[] {
  const blocks: string[] = [];
  let inlineBuffer: HtmlNode[] = [];

  const flushInline = () => {
    if (inlineBuffer.length === 0) return;
    const text = collapseLines(renderInline(inlineBuffer, baseUrl));
    inlineBuffer = [];
    if (text) blocks.push(text);
  };

  for (const node of nodes) {
    if (node.type === "text") {
      inlineBuffer.push(node);
      continue;
    }
    if (shouldSkip(node)) continue;

    if (!BLOCK_TAGS.has(node.tag)) {
      inlineBuffer.push(node);
      continue;
    }

    flushInline();

    switch (node.tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const level = Number.parseInt(node.tag[1], 10);
        const text = collapseInline(renderInline(node.children, baseUrl));
        if (text) blocks.push(`${"#".repeat(level)} ${text}`);
        break;
      }
      case "p": {
        const text = collapseLines(renderInline(node.children, baseUrl));
        if (text) blocks.push(text);
        break;
      }
      case "pre": {
        const text = renderPlainText(node.children).replace(/^\n+|\n+$/g, "");
        if (text) blocks.push(`\`\`\`\n${text}\n\`\`\``);
        break;
      }
      case "blockquote": {
        const inner = renderBlocks(node.children, baseUrl).join("\n\n");
        if (inner) {
          blocks.push(
            inner
              .split("\n")
              .map((line) => (line ? `> ${line}` : ">"))
              .join("\n"),
          );
        }
        break;
      }
      case "ul": {
        const md = renderList(node, false, baseUrl);
        if (md) blocks.push(md);
        break;
      }
      case "ol": {
        const md = renderList(node, true, baseUrl);
        if (md) blocks.push(md);
        break;
      }
      case "dl": {
        const md = renderDl(node, baseUrl);
        if (md) blocks.push(md);
        break;
      }
      case "table": {
        const md = renderTable(node, baseUrl);
        if (md) blocks.push(md);
        break;
      }
      case "hr":
        blocks.push("---");
        break;
      case "div": {
        if (hasClass(node, "diff-block")) {
          const md = renderDiffBlock(node, baseUrl);
          if (md) blocks.push(md);
        } else if (hasClass(node, "diff-field")) {
          const heading = collapseInline(renderInline(node.children, baseUrl));
          if (heading) blocks.push(`### ${heading}`);
        } else if (hasClass(node, "diff-line")) {
          const line = collapseInline(renderInline(node.children, baseUrl));
          if (line) blocks.push(line);
        } else if (hasClass(node, "versions")) {
          const text = collapseInline(renderInline(node.children, baseUrl));
          if (text) blocks.push(text);
        } else {
          blocks.push(...renderBlocks(node.children, baseUrl));
        }
        break;
      }
      default:
        blocks.push(...renderBlocks(node.children, baseUrl));
        break;
    }
  }

  flushInline();
  return blocks;
}

/**
 * Converts a ChromeStatusLite HTML page into clean, token-efficient Markdown
 * focused on `<main id="main">` with absolute links and GFM tables.
 */
export function htmlToMarkdown(html: string, requestUrl?: string): string {
  const tree = parseHtml(html);

  const canonicalEl = findFirstElement(
    tree,
    (el) =>
      el.tag === "link" &&
      (el.attrs.rel ?? "").toLowerCase().split(/\s+/).includes("canonical") &&
      Boolean(el.attrs.href),
  );
  const canonical = canonicalEl?.attrs.href || requestUrl || CANONICAL_ORIGIN;
  const baseUrl = canonical || CANONICAL_ORIGIN;

  // Focus on <main id="main"> to omit <head>, skip link, and repeated nav chrome.
  const mainEl = findFirstElement(tree, (el) => el.tag === "main");
  const bodyEl = mainEl
    ? undefined
    : findFirstElement(tree, (el) => el.tag === "body");
  const contentNodes = mainEl
    ? mainEl.children
    : bodyEl
    ? bodyEl.children
    : tree;

  const blocks = renderBlocks(contentNodes, baseUrl);
  const cleaned = blocks
    .join("\n\n")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const header = canonical ? `Source: ${canonical}\n\n` : "";
  return `${header}${cleaned}\n`;
}

function appendVaryAccept(headers: Headers): void {
  const existing = headers.get("vary");
  if (!existing) {
    headers.set("vary", "Accept");
    return;
  }
  const tokens = existing.split(",").map((t) => t.trim().toLowerCase());
  if (!tokens.includes("accept")) {
    headers.set("vary", `${existing}, Accept`);
  }
}

export async function convertHtmlResponseToMarkdown(
  response: Response,
  requestUrl: string,
): Promise<Response> {
  const html = await response.text();
  const markdown = htmlToMarkdown(html, requestUrl);
  const headers = new Headers(response.headers);
  headers.set("content-type", "text/markdown; charset=utf-8");
  headers.set(
    "x-markdown-tokens",
    String(Math.max(1, Math.ceil(markdown.length / 4))),
  );
  headers.delete("content-length");
  headers.delete("speculation-rules");
  appendVaryAccept(headers);
  return new Response(markdown, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
