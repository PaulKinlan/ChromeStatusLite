import { createHandler } from "../src/handler.ts";
import { main } from "../main.ts"; // loads the deploy entrypoint on every gate (import-safe)
import { equal, fixtureClient, includes } from "./fixture.ts";

function assertStylesheetLoaded(statuses: number[]): void {
  if (statuses.length === 0 || statuses.some((status) => status !== 200)) {
    throw new Error(`Browser stylesheet request failed: ${JSON.stringify(statuses)}`);
  }
}

// A page that measures the keyboard focus ring the SERVED stylesheet actually
// paints (chrome-status-lite-2x9): the stylesheet is not asserted as text, the
// browser is asked for the computed outline of each interactive control while
// it is focused, then again with that same stylesheet disabled, so a probe that
// would pass on a stylesheet-free page cannot pass here.
const FOCUS_PROBE_IDS = ["link", "button", "select", "input", "textarea", "summary", "chip"];
const focusProbePage = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="/styles/index.css"><title>focus probe</title></head><body><main>
<a id="link" href="#x">link</a>
<button id="button">button</button>
<select id="select"><option>1</option></select>
<input id="input" type="text">
<textarea id="textarea"></textarea>
<details><summary id="summary">summary</summary></details>
<div class="versions"><a id="chip" href="#y">chrome 112</a></div>
<pre id="out"></pre></main><script>
const ids = ${JSON.stringify(FOCUS_PROBE_IDS)};
const lines = [];
function probe(tag) {
  for (const id of ids) {
    const el = document.getElementById(id);
    el.focus();
    const cs = getComputedStyle(el);
    lines.push([tag, id, "fv=" + (el.matches(":focus-visible") ? 1 : 0),
      "outline=" + cs.outlineStyle + " " + cs.outlineWidth + " " + cs.outlineColor,
      "offset=" + cs.outlineOffset, "border=" + cs.borderTopWidth + " " + cs.borderTopColor].join("|"));
    el.blur();
  }
}
probe("css-on");
document.styleSheets[0].disabled = true;
probe("css-off");
document.styleSheets[0].disabled = false;
document.getElementById("out").textContent = String.fromCharCode(10) + lines.join(String.fromCharCode(10)) + String.fromCharCode(10) + "PROBE-DONE";
</script></body></html>`;
const FOCUS_RING = "outline=solid 2px rgb(0, 100, 193)";

function focusProbeLine(html: string, tag: string, id: string): string {
  const line = html.split("\n").find((entry) => entry.startsWith(`${tag}|${id}|`));
  if (!line) throw new Error(`Focus probe produced no ${tag}|${id} line`);
  return line;
}

function assertFocusRing(html: string): void {
  includes(html, "PROBE-DONE"); // the probe script ran to completion
  for (const id of FOCUS_PROBE_IDS) {
    const line = focusProbeLine(html, "css-on", id);
    includes(line, "fv=1"); // the control really matched :focus-visible
    includes(line, FOCUS_RING);
    includes(line, "offset=2px");
  }
  // Sensitivity: the same probe with the served stylesheet disabled must NOT
  // report the author ring, so a 404/absent rule cannot pass the loop above.
  for (const id of FOCUS_PROBE_IDS) {
    const line = focusProbeLine(html, "css-off", id);
    if (line.includes(FOCUS_RING)) {
      throw new Error(`Author focus ring survived a disabled stylesheet: ${line}`);
    }
  }
  // Keyboard parity with the hover affordance on the version chips.
  includes(focusProbeLine(html, "css-on", "chip"), "border=1px rgb(240, 0, 0)");
}

Deno.test("real HTTP and headless browser render a fixture page and load its stylesheet", async () => {
  equal(typeof main, "function"); // the deploy entrypoint wiring loads
  const handler = createHandler(fixtureClient());
  let denyStylesheet = false;
  let browserCssStatuses: number[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (request) => {
    // Route a fixture host through the actual HTTP listener; fetch cannot override Host.
    if (request.headers.get("x-fixture-host")) {
      const url = new URL(request.url);
      url.hostname = "preview.deno.net";
      return handler(new Request(url, request));
    }
    if (new URL(request.url).pathname === "/__focus_probe") {
      return new Response(focusProbePage, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    const isCss = new URL(request.url).pathname === "/styles/index.css";
    const response = isCss && denyStylesheet
      ? new Response("Not found", { status: 404 })
      : await handler(request);
    if (isCss) browserCssStatuses.push(response.status);
    return response;
  });
  const port = (server.addr as Deno.NetAddr).port;
  const root = `http://127.0.0.1:${port}`;
  const profiles: string[] = [];
  const browser = async (path = "/?version=112") => {
    const profile = await Deno.makeTempDir();
    profiles.push(profile);
    const screenshot = `${profile}/render.png`;
    const chrome = new Deno.Command(Deno.env.get("CHROME_BIN") || "google-chrome", {
      args: ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
        "--disable-background-networking", `--user-data-dir=${profile}`,
        "--virtual-time-budget=2000", `--screenshot=${screenshot}`, "--dump-dom", `${root}${path}`],
      stdout: "piped", stderr: "piped",
    });
    const result = await chrome.output();
    equal(result.code, 0);
    return { html: new TextDecoder().decode(result.stdout), screenshot };
  };
  try {
    const redirect = await fetch(`${root}/feature/123?x=1`, {
      headers: { "x-fixture-host": "preview.deno.net" }, redirect: "manual",
    });
    equal(redirect.status, 301);
    equal(redirect.headers.get("location"), "https://chromestatuslite.com/feature/123?x=1");
    const css = await fetch(`${root}/styles/index.css`);
    equal(css.status, 200);
    includes(css.headers.get("content-type") || "", "text/css");
    const missing = await fetch(`${root}/missing`);
    equal(missing.status, 404);

    const feed = await fetch(`${root}/feed.xml`);
    equal(feed.status, 200);
    includes(feed.headers.get("content-type") || "", "application/rss+xml");
    includes(await feed.text(), "<title>Chrome Status Lite</title>");

    const apiVersion = await fetch(`${root}/api/version/120`);
    equal(apiVersion.status, 200);
    includes(apiVersion.headers.get("content-type") || "", "application/json");
    const apiJson = await apiVersion.json();
    equal(apiJson.version, 120);
    equal(apiJson.total_features, 1);

    const breaking = await fetch(`${root}/breaking`);
    equal(breaking.status, 200);
    includes(breaking.headers.get("content-type") || "", "text/html");
    includes(await breaking.text(), "Breaking Changes");

    const originTrials = await fetch(`${root}/origin-trials`);
    equal(originTrials.status, 200);
    includes(originTrials.headers.get("content-type") || "", "text/html");
    includes(await originTrials.text(), "Origin Trials Tracker");

    browserCssStatuses = [];
    const { html, screenshot } = await browser();
    includes(html, "Chrome Release 112");
    includes(html, "Fixture feature");
    includes(html, "Breaking change:</strong> Yes");
    includes(html, "Enterprise impact:</strong> Medium");
    includes(html, "Spec maturity:</strong> Working draft");
    includes(html, "Web Platform Tests:</strong> Yes");
    includes(html, "https://chromestatuslite.com/?version=112");
    // The listener records the browser's CSS request and its response status.
    assertStylesheetLoaded(browserCssStatuses);
    if ((await Deno.stat(screenshot)).size < 1000) throw new Error("Empty browser screenshot");

    // The keyboard focus ring is measured in the browser, from the served
    // stylesheet, in the same run (chrome-status-lite-2x9).
    assertFocusRing((await browser("/__focus_probe")).html);

    denyStylesheet = true;
    browserCssStatuses = [];
    const broken = await browser();
    includes(broken.html, "Chrome Release 112"); // DOM alone still looks healthy.
    let rejected = false;
    try { assertStylesheetLoaded(browserCssStatuses); } catch { rejected = true; }
    equal(rejected, true); // The assertion detects a real browser stylesheet 404.
    equal(browserCssStatuses[0], 404);
  } finally {
    await server.shutdown();
    for (const profile of profiles) await Deno.remove(profile, { recursive: true });
  }
});
