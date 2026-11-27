import template from "../flora.ts";
import { htmlResponse } from "../ui-components/layout.ts";

export default async function render(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const canonical = `https://chromestatuslite.com${url.pathname + url.search}`;

  return htmlResponse({
    title: "About — ChromeStatusLite",
    canonical,
    description:
      "Why Paul Kinlan created ChromeStatusLite: quick, zero-JavaScript access to chromestatus.com for both humans and AI agents.",
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
    <li><strong>Markdown content negotiation:</strong> Send <code>Accept: text/markdown</code> to any page to receive clean, token-efficient Markdown with absolute links and tables.</li>
    <li><strong>Agent index:</strong> Read <a href="/llms.txt">/llms.txt</a> for a concise directory of all routes, topic slugs, and machine-readable endpoints.</li>
    <li><strong>Structured feeds &amp; API:</strong> Subscribe via <a href="/feed.xml">RSS 2.0</a> or query milestone JSON at <a href="/api/version/latest">/api/version/latest</a>.</li>
  </ul>

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
