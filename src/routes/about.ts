import template from "../flora.ts";
import { htmlResponse } from "../ui-components/layout.ts";

export default async function render(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const canonical = `https://chromestatuslite.com${url.pathname + url.search}`;

  return htmlResponse({
    title: "About — ChromeStatusLite",
    canonical,
    description:
      "Why Paul Kinlan created ChromeStatusLite: quick, zero-JavaScript access to chromestatus.com with /llms.txt and text/markdown for humans and AI agents.",
    currentPath: url.pathname,
    body: template`
  <h1>About ChromeStatusLite</h1>
  <p>ChromeStatusLite is a fast, lightweight, server-rendered reader over the
    <a href="https://chromestatus.com" rel="noopener noreferrer">Chrome Platform Status</a>
    API, created by <a href="https://paul.kinlan.me/" rel="noopener noreferrer">Paul Kinlan</a>.</p>

  <h2>Why I created it</h2>
  <p>I created ChromeStatusLite because I wanted quick, low-friction access to
    the release and feature details on <code>chromestatus.com</code> — and I
    wanted all of that information to be directly accessible to agents, CLI
    tools, and readers that can't run JavaScript.</p>
  <p>Every page is plain, server-rendered HTML with zero client-side JavaScript.
    You can inspect what shipped, what is in origin trial, what is behind a
    flag, and what is being deprecated or removed without waiting for a heavy
    client-side app to boot.</p>

  <h2>Built for humans and agents</h2>
  <ul>
    <li><strong>Zero JavaScript:</strong> Every route renders complete semantic HTML directly on the server.</li>
    <li><strong><code>Accept: text/markdown</code> on every page:</strong> Request any page — including the release summary, deprecation calendar, topic wiki, and every individual <code>/feature/:id</code> page, history, and diff — with <code>Accept: text/markdown</code> to receive clean, token-efficient Markdown with absolute links and GFM tables.</li>
    <li><strong>Direct <code>.md</code> URLs:</strong> If your agent or tool cannot send custom HTTP headers, append <code>.md</code> to any route (for example <a href="/index.md">/index.md</a>, <code>/feature/{id}.md</code>, <a href="/deprecations.md">/deprecations.md</a>, <a href="/wiki/webgpu.md">/wiki/webgpu.md</a>, or <a href="/about.md">/about.md</a>).</li>
    <li><strong>Live <code>/llms.txt</code> index:</strong> Read <a href="/llms.txt">/llms.txt</a> for an agent-ready directory of all routes, topic wiki slugs, machine-readable endpoints, and direct Markdown links to features in the latest Chrome release.</li>
    <li><strong>Structured feeds &amp; API:</strong> Subscribe via <a href="/feed.xml">RSS 2.0</a> or query milestone JSON at <a href="/api/version/latest">/api/version/latest</a>.</li>
  </ul>

  <h3>Quick examples for agents &amp; CLI</h3>
  <pre><code># Discover routes, topic slugs, and latest release features
curl https://chromestatuslite.com/llms.txt

# Fetch any page or feature as Markdown via Accept header
curl -H "Accept: text/markdown" https://chromestatuslite.com/
curl -H "Accept: text/markdown" https://chromestatuslite.com/feature/5160724576993280

# Or append .md directly when custom headers aren't available
curl https://chromestatuslite.com/feature/5160724576993280.md
curl https://chromestatuslite.com/deprecations.md</code></pre>

  <h2>About Paul Kinlan &amp; related projects</h2>
  <ul>
    <li>Website &amp; blog: <a href="https://paul.kinlan.me/" rel="noopener noreferrer">https://paul.kinlan.me/</a></li>
    <li>Source code: <a href="https://github.com/PaulKinlan/ChromeStatusLite" rel="noopener noreferrer">https://github.com/PaulKinlan/ChromeStatusLite</a></li>
    <li><a href="https://chrome-platform-showcase.com" rel="noopener noreferrer">Chrome Platform Showcase</a> — interactive demos of new Chrome web platform features</li>
    <li><a href="https://gendn.dev" rel="noopener noreferrer">GenDN</a> — generated API reference documentation for Chrome features not yet documented on MDN</li>
  </ul>

  <h2>Data sources</h2>
  <p>Chrome release and feature data comes from the public Chrome Platform
    Status API at <code>https://chromestatus.com/api/v0</code>, enriched with
    optional Baseline status from
    <a href="https://webstatus.dev" rel="noopener noreferrer">webstatus.dev</a>.
    ChromeStatusLite runs on Cloudflare Workers and D1, and is an independent
    project not affiliated with Google or Chromium.</p>
  `,
  });
}
