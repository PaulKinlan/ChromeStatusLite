import { createHandler } from "../src/handler.ts";
import { main } from "../main.ts"; // loads the deploy entrypoint on every gate (import-safe)
import { equal, fixtureClient, includes } from "./fixture.ts";

function assertStylesheetLoaded(statuses: number[]): void {
  if (statuses.length === 0 || statuses.some((status) => status !== 200)) {
    throw new Error(`Browser stylesheet request failed: ${JSON.stringify(statuses)}`);
  }
}

// A page that measures what the SERVED stylesheet actually paints: the
// keyboard focus ring (chrome-status-lite-2x9) and the colour scheme's tokens
// (chrome-status-lite-ci1). The stylesheet is never asserted as text - the
// browser is asked for computed styles - and the focus half is measured a
// second time with that same stylesheet disabled, so a probe that would pass
// on a stylesheet-free page cannot pass here.
//
// The focus half is driven over the DevTools protocol instead of by focusing
// the controls (chrome-status-lite-0hn): Chrome matches :focus-visible only
// while the DOCUMENT itself has focus, and a headless window does not always
// have it (document.hasFocus() was false on a first visit, true on later ones),
// so a focus()-driven probe failed the merger's full gate on a byte-identical
// tree and retries could only shrink that window. CSS.forcePseudoState applies
// the served rule deterministically - verified on Chrome 155 with
// document.hasFocus() false - and the stylesheet still has to paint the ring,
// so a missing or regressed rule fails every run.
const FOCUS_PROBE_IDS = ["link", "button", "select", "input", "textarea", "summary", "chip"];
// The nav under test is the REAL component markup, lifted out of a rendered page
// (chrome-status-lite-brf / nc9), so the tap targets are measured from what the
// routes actually emit rather than from a hand-copy.
const NAV_PLACEHOLDER = "<!--nav-->";
const styleProbePage = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="/styles/index.css"><title>style probe</title></head><body>${NAV_PLACEHOLDER}<main>
<a id="link" href="#x">link</a>
<button id="button">button</button>
<select id="select"><option>1</option></select>
<input id="input" type="text">
<textarea id="textarea"></textarea>
<details><summary id="summary">summary</summary></details>
<div class="versions"><a id="chip" href="#y">chrome 112</a></div>
<span class="badge breaking" id="badge">breaking</span>
<div class="diff-add" id="add">+added</div>
<div class="diff" id="diff" style="height:60px"><div id="diff-body" style="height:400px">tall diff body</div></div>
<p class="milestone-date" id="date">date</p>
<h2 id="heading">heading</h2>
<div id="canvas" style="background:var(--surface);color:var(--text)">canvas</div>
</main></body></html>`;

const CHROME = Deno.env.get("CHROME_BIN") || "google-chrome";
const FOCUS_RING = "outline=solid 2px rgb(0, 100, 193)";

type CdpReply = { result?: any; error?: { message?: string } };
type CdpPage = {
  call: (method: string, params?: Record<string, unknown>) => Promise<CdpReply>;
  evaluate: (expression: string) => Promise<unknown>;
  close: () => Promise<void>;
};

// A WebSocket client for the browser-level DevTools endpoint. Sessions are
// flattened, so this single socket also drives the one page the probe opens.
function cdpClient(ws: WebSocket): { attach: (url: string) => Promise<CdpPage> } {
  let nextId = 1;
  const pending = new Map<number, (reply: CdpReply) => void>();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data as string) as { id?: number };
    const resolve = message.id === undefined ? undefined : pending.get(message.id);
    if (resolve === undefined) return;
    pending.delete(message.id as number);
    resolve(message as CdpReply);
  };
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<CdpReply>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
  return {
    async attach(url: string): Promise<CdpPage> {
      const target = await send("Target.createTarget", { url });
      const targetId = target.result?.targetId as string | undefined;
      if (targetId === undefined) throw new Error(`Could not open ${url}: ${target.error?.message ?? "no target"}`);
      const attached = await send("Target.attachToTarget", { targetId, flatten: true });
      const sessionId = attached.result?.sessionId as string | undefined;
      if (sessionId === undefined) throw new Error(`Could not attach to ${url}: ${attached.error?.message ?? "no session"}`);
      const call = (method: string, params: Record<string, unknown> = {}) => send(method, params, sessionId);
      // runtime.evaluate failures are surfaced, not turned into undefined: a
      // probe expression that throws has to fail the test loudly.
      const evaluate = async (expression: string) => {
        const reply = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        const details = reply.result?.exceptionDetails;
        if (reply.error || details) {
          throw new Error(`Probe expression failed: ${reply.error?.message ?? details?.text} ${details?.exception?.description ?? ""}`.trim());
        }
        return reply.result?.result?.value;
      };
      for (const domain of ["Page.enable", "Runtime.enable", "DOM.enable", "CSS.enable"]) {
        const enabled = await call(domain);
        if (enabled.error) throw new Error(`${domain} failed: ${enabled.error.message}`);
      }
      return { call, evaluate, close: async () => { await send("Target.closeTarget", { targetId }); } };
    },
  };
}

// --remote-debugging-port=0 makes Chrome pick a free port and report the
// endpoint on stderr, so two gates on one machine cannot collide on it.
async function launchDebugChrome(): Promise<{ ws: WebSocket; close: () => Promise<void> }> {
  const profile = await Deno.makeTempDir();
  const child = new Deno.Command(CHROME, {
    args: ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--disable-background-networking", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"],
    stdout: "null", stderr: "piped",
  }).spawn();
  const decoder = new TextDecoder();
  const reader = child.stderr.getReader();
  let log = "";
  let announce = (_: string) => {};
  const endpoint = new Promise<string>((resolve) => { announce = resolve; });
  // Keep draining stderr after the endpoint is found: a full pipe would block
  // Chrome in the middle of the probe.
  const drain = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        log = (log + decoder.decode(value, { stream: true })).slice(-4096);
        const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) announce(match[1]);
      }
    } catch { /* browser closed */ }
  })();
  let timer = 0;
  const expired = new Promise<string>((resolve) => { timer = setTimeout(() => resolve(""), 20_000); });
  const browserUrl = await Promise.race([endpoint, expired]);
  clearTimeout(timer);
  if (browserUrl === "") {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    await child.status;
    await Deno.remove(profile, { recursive: true }).catch(() => {});
    throw new Error(`Chrome reported no DevTools endpoint: ${log.slice(-400)}`);
  }
  const ws = new WebSocket(browserUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`DevTools WebSocket ${browserUrl} failed to open`));
  });
  return {
    ws,
    close: async () => {
      try { ws.close(); } catch { /* already closed */ }
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      await child.status;
      await drain.catch(() => {});
      await Deno.remove(profile, { recursive: true }).catch(() => {});
    },
  };
}

// One line per control, in the format assertFocusRing parses.
const focusMeasure = (id: string): string => `(() => {
  const control = document.getElementById(${JSON.stringify(id)});
  const style = getComputedStyle(control);
  return ["fv=" + (control.matches(":focus-visible") ? 1 : 0),
    "outline=" + style.outlineStyle + " " + style.outlineWidth + " " + style.outlineColor,
    "offset=" + style.outlineOffset,
    "border=" + style.borderTopWidth + " " + style.borderTopColor].join("|");
})()`;

// WCAG relative luminance, so the probe reports measured contrast rather than
// just "the colours changed".
const themeMeasure = `(() => {
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const parse = (value) => value.match(/[\\d.]+/g).slice(0, 3).map(Number);
  const ratio = (a, b) => { const pair = [lum(parse(a)), lum(parse(b))].sort((m, n) => n - m); return (pair[0] + 0.05) / (pair[1] + 0.05); };
  const page = getComputedStyle(document.documentElement);
  const canvas = getComputedStyle(document.getElementById("canvas"));
  const lines = ["PAGE|bg=" + page.backgroundColor + "|color=" + page.color + "|contrast=" + ratio(page.backgroundColor, page.color).toFixed(2),
    "SURFACE|bg=" + canvas.backgroundColor + "|color=" + canvas.color + "|contrast=" + ratio(canvas.backgroundColor, canvas.color).toFixed(2)];
  for (const id of ["link", "badge", "add", "date"]) {
    const style = getComputedStyle(document.getElementById(id));
    lines.push(id.toUpperCase() + "|bg=" + style.backgroundColor + "|color=" + style.color);
  }
  // The shared stylesheet's wrapping policy (chrome-status-lite-qs9l): measured,
  // not grepped, so a vendored-CSS regeneration that drops the rule fails here.
  // #canvas (a div) must stay at the initial wrap value: it pins the policy's
  // SCOPE, so a global *{text-wrap:pretty} mutation fails too (chrome-status-lite-yv5p).
  lines.push("WRAP|heading=" + getComputedStyle(document.getElementById("heading")).textWrap +
    "|date=" + getComputedStyle(document.getElementById("date")).textWrap +
    "|canvas=" + getComputedStyle(document.getElementById("canvas")).textWrap);
  return lines;
})()`;

// Tap targets (chrome-status-lite-brf / nc9): measured in the COLLAPSED layout,
// because that is the one a phone visitor taps - the list is a closed popover
// until the menu button is pressed, and a nav whose button stops opening it
// measures 0x0 here and fails. Every link and the version chip has to reach the
// 44px preferred target size (WCAG 2.5.5) in both dimensions.
const targetMeasure = `(() => {
  const button = document.querySelector("nav .menu-button");
  if (button) button.click();
  const links = [...document.querySelectorAll("nav a")].map((el) => el.getBoundingClientRect());
  const chip = document.getElementById("chip").getBoundingClientRect();
  const min = (values) => Math.min(...values).toFixed(1);
  return ["TARGETS|navCount=" + links.length +
    "|navMinW=" + min(links.map((r) => r.width)) +
    "|navMinH=" + min(links.map((r) => r.height)) +
    "|chipW=" + chip.width.toFixed(1) + "|chipH=" + chip.height.toFixed(1)];
})()`;

// The diff panel clips its children to its radius without becoming a scroll
// container (chrome-status-lite-wde): overflow: hidden was used only to round
// the corner and silently made every diff panel programmatically scrollable,
// adding scroll anchoring and breaking inner sticky positioning. The child is
// tall enough to overflow, so the clip path is exercised; scrollTop/scrollLeft
// are SET and have to stay 0 on an element that is not a scroll container.
const clipMeasure = `(() => {
  const diff = document.getElementById("diff");
  const body = document.getElementById("diff-body");
  diff.scrollTop = 40;
  diff.scrollLeft = 40;
  const style = getComputedStyle(diff);
  return ["overflowY=" + style.overflowY, "overflowX=" + style.overflowX,
    "scrollY=" + diff.scrollTop, "scrollX=" + diff.scrollLeft,
    "contentOverflows=" + (body.getBoundingClientRect().height > diff.getBoundingClientRect().height ? 1 : 0)].join("|");
})()`;

// Measures the served stylesheet from a real browser: the colour tokens in both
// schemes, and the keyboard focus ring with and without that stylesheet.
async function probeStyles(
  root: string,
  probePage: string,
): Promise<{ focus: string[]; withoutCss: string[]; light: string[]; dark: string[]; targets: string[]; clip: string[] }> {
  const browser = await launchDebugChrome();
  try {
    const page = await cdpClient(browser.ws).attach(`${root}/__style_probe`);
    try {
      const deadline = performance.now() + 15_000;
      for (;;) {
        const ready = await page.evaluate(`document.readyState === "complete" && (document.styleSheets[0]?.cssRules?.length ?? 0) > 0`).catch(() => false);
        if (ready === true) break;
        if (performance.now() > deadline) throw new Error("The probe page never parsed the served stylesheet");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const light = await page.evaluate(themeMeasure) as string[];
      const clipOn = `css-on|${await page.evaluate(clipMeasure)}`;
      const document_ = await page.call("DOM.getDocument", { depth: -1 });
      const documentNodeId = document_.result?.root?.nodeId as number | undefined;
      if (documentNodeId === undefined) throw new Error("DevTools returned no document node for the probe page");
      const nodes = new Map<string, number>();
      for (const id of FOCUS_PROBE_IDS) {
        const found = await page.call("DOM.querySelector", { nodeId: documentNodeId, selector: `#${id}` });
        const nodeId = found.result?.nodeId as number | undefined;
        if (!nodeId) throw new Error(`The probe page has no #${id} control`);
        nodes.set(id, nodeId);
      }
      const forceFocusVisible = async () => {
        for (const [id, nodeId] of nodes) {
          const forced = await page.call("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["focus-visible"] });
          if (forced.error) throw new Error(`Could not force :focus-visible on #${id}: ${forced.error.message}`);
        }
      };
      await forceFocusVisible();
      const focus: string[] = [];
      for (const id of FOCUS_PROBE_IDS) focus.push(`css-on|${id}|${await page.evaluate(focusMeasure(id))}`);
      // Sensitivity: with the served stylesheet disabled, the same forced
      // controls must fall back to the user agent ring.
      await page.evaluate(`document.styleSheets[0].disabled = true`);
      const clipOff = `css-off|${await page.evaluate(clipMeasure)}`;
      await forceFocusVisible();
      const withoutCss: string[] = [];
      for (const id of FOCUS_PROBE_IDS) withoutCss.push(`css-off|${id}|${await page.evaluate(focusMeasure(id))}`);
      await page.evaluate(`document.styleSheets[0].disabled = false`);
      // prefers-color-scheme: dark is emulated on the page - the same CSS path
      // the browser takes, without a second browser launch.
      // Tap targets come from the same visit and the same served stylesheet; a
      // second browser launch would only add time to the gate.
      const targets = await page.evaluate(targetMeasure) as string[];
      await page.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
      const dark = await page.evaluate(themeMeasure) as string[];
      return { focus, withoutCss, light, dark, targets, clip: [clipOn, clipOff] };
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

function focusProbeLine(lines: string[], tag: string, id: string): string {
  const line = lines.find((entry) => entry.startsWith(`${tag}|${id}|`));
  if (!line) throw new Error(`Focus probe produced no ${tag}|${id} line`);
  return line;
}

function probeLine(lines: string[], tag: string): string {
  const line = lines.find((entry) => entry.startsWith(`${tag}|`));
  if (!line) throw new Error(`Style probe produced no ${tag} line`);
  return line;
}

// The colour tokens in both schemes, measured from the served stylesheet
// (chrome-status-lite-ci1). The same page is measured twice - once in the
// browser's light scheme, once under prefers-color-scheme: dark - so "the page
// adapts" is asserted end to end in a real browser instead of by grepping the
// CSS text for a media query.
const LIGHT_THEME = {
  PAGE: "bg=rgb(255, 255, 255)|color=rgb(0, 0, 0)",
  SURFACE: "bg=rgb(255, 255, 255)|color=rgb(0, 0, 0)",
  LINK: "color=rgb(0, 100, 193)",
  BADGE: "bg=rgb(255, 235, 238)|color=rgb(198, 40, 40)",
  ADD: "bg=rgb(230, 255, 236)|color=rgb(17, 99, 41)",
  DATE: "color=rgb(102, 102, 102)",
  WRAP: "heading=balance|date=pretty|canvas=wrap",
};
const DARK_THEME = {
  PAGE: "bg=rgb(20, 22, 26)|color=rgb(236, 238, 241)",
  SURFACE: "bg=rgb(20, 22, 26)|color=rgb(236, 238, 241)",
  LINK: "color=rgb(108, 182, 255)",
  BADGE: "bg=rgb(59, 26, 30)|color=rgb(255, 154, 154)",
  ADD: "bg=rgb(18, 48, 28)|color=rgb(126, 226, 168)",
  DATE: "color=rgb(194, 199, 207)",
  WRAP: "heading=balance|date=pretty|canvas=wrap",
};

function assertThemeTokens(lines: string[], expected: Record<string, string>): void {
  for (const [tag, needle] of Object.entries(expected)) includes(probeLine(lines, tag), needle);
  // Not just "the colours changed": body text has to stay readable in both
  // schemes (WCAG 2.1 AA asks 4.5:1 for normal text).
  for (const tag of ["PAGE", "SURFACE"]) {
    const match = probeLine(lines, tag).match(/contrast=([\d.]+)/);
    if (!match) throw new Error(`Style probe reported no contrast for ${tag}`);
    if (!(Number(match[1]) >= 4.5)) throw new Error(`${tag} contrast ${match[1]} is below 4.5:1: ${probeLine(lines, tag)}`);
  }
}

const MIN_TARGET_PX = 44;

function numberField(line: string, key: string): number {
  const match = line.match(new RegExp(`${key}=([\\d.]+)`));
  if (!match) throw new Error(`Tap-target probe reported no ${key}: ${line}`);
  return Number(match[1]);
}

function assertTapTargets(lines: string[]): void {
  const line = probeLine(lines, "TARGETS");
  equal(numberField(line, "navCount"), 7); // the real nav, not an empty shell
  for (const key of ["navMinW", "navMinH", "chipW", "chipH"]) {
    const measured = numberField(line, key);
    if (!(measured >= MIN_TARGET_PX)) {
      throw new Error(`${key} ${measured}px is under the ${MIN_TARGET_PX}px target size: ${line}`);
    }
  }
}

// Both nav layouts are CSS only (chrome-status-lite-nc9), so the markup never
// changes with the viewport: the Menu button and the popover attribute are
// always present and the media query alone decides which presentation is
// painted. A layout that needed script would show up here as a missing
// attribute, and the project deliberately ships no client script
// (tests/deprecations_test.ts).
function assertNavMarkup(html: string): void {
  if (!html.includes('class="menu-button"')) {
    throw new Error("Primary nav lost its menu button");
  }
  if (!/<ul id="site-menu" class="site-menu" popover="auto">/.test(html)) {
    throw new Error("Nav list is not a popover, so the menu button cannot open it");
  }
}

function assertFocusRing(focus: string[], withoutCss: string[]): void {
  for (const id of FOCUS_PROBE_IDS) {
    const line = focusProbeLine(focus, "css-on", id);
    includes(line, "fv=1"); // the control really matched :focus-visible
    includes(line, FOCUS_RING);
    includes(line, "offset=2px");
  }
  // Sensitivity: the same controls with the served stylesheet disabled must
  // NOT report the author ring, so a 404/absent rule cannot pass the loop above.
  for (const id of FOCUS_PROBE_IDS) {
    const line = focusProbeLine(withoutCss, "css-off", id);
    if (line.includes(FOCUS_RING)) {
      throw new Error(`Author focus ring survived a disabled stylesheet: ${line}`);
    }
  }
  // Keyboard parity with the hover affordance on the version chips.
  includes(focusProbeLine(focus, "css-on", "chip"), "border=1px rgb(240, 0, 0)");
}

// The diff panel clips without scrolling (chrome-status-lite-wde): measured from
// the served stylesheet over the same DevTools visit, with an overflowing child
// so the clip is real.
function assertDiffClipsWithoutScrolling(clip: string[]): void {
  const on = probeLine(clip, "css-on");
  includes(on, "overflowY=clip");
  includes(on, "overflowX=clip");
  includes(on, "scrollY=0"); // setting scrollTop was ignored: no scroll container
  includes(on, "scrollX=0");
  includes(on, "contentOverflows=1"); // the child really does overflow the panel
  // Sensitivity: without the served stylesheet the panel has no clip at all.
  const off = probeLine(clip, "css-off");
  includes(off, "overflowY=visible");
  includes(off, "overflowX=visible");
}

Deno.test("real HTTP and headless browser render a fixture page and load its stylesheet", async () => {
  equal(typeof main, "function"); // the deploy entrypoint wiring loads
  const handler = createHandler(fixtureClient());
  let denyStylesheet = false;
  let browserCssStatuses: number[] = [];
  // The probe page carries the real nav, lifted from a rendered page once, before
  // anything is served (chrome-status-lite-brf / nc9). Taken from the SERVER
  // response rather than a browser dump, so the markup measured is exactly what
  // the routes emit at every width.
  const homeHtml = await (await handler(new Request("https://chromestatuslite.com/?version=112"))).text();
  const renderedNav = homeHtml.match(/<nav[^>]*>[\s\S]*?<\/nav>/);
  if (!renderedNav) throw new Error("Rendered page carries no <nav> to measure");
  includes(renderedNav[0], 'popover="auto"'); // collapsed: the layout a phone gets
  const probePage = styleProbePage.replace(NAV_PLACEHOLDER, renderedNav[0]);
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (request) => {
    // Route a fixture host through the actual HTTP listener; fetch cannot override Host.
    if (request.headers.get("x-fixture-host")) {
      const url = new URL(request.url);
      url.hostname = "preview.deno.net";
      return handler(new Request(url, request));
    }
    if (new URL(request.url).pathname === "/__style_probe") {
      return new Response(probePage, { headers: { "content-type": "text/html; charset=utf-8" } });
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
    const chrome = new Deno.Command(CHROME, {
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
    assertNavMarkup(html);
    if ((await Deno.stat(screenshot)).size < 1000) throw new Error("Empty browser screenshot");

    // The keyboard focus ring and the colour tokens are measured over the
    // DevTools protocol from the served stylesheet (chrome-status-lite-2x9,
    // chrome-status-lite-ci1): forced :focus-visible, then the same controls
    // with the stylesheet disabled, then prefers-color-scheme: dark. No retry
    // loop - the measurement no longer depends on the headless window's focus
    // state, which is what flaked the merger gate (chrome-status-lite-0hn).
    const probe = await probeStyles(root, probePage);
    assertFocusRing(probe.focus, probe.withoutCss);
    assertTapTargets(probe.targets);
    assertDiffClipsWithoutScrolling(probe.clip);
    assertThemeTokens(probe.light, LIGHT_THEME);
    assertThemeTokens(probe.dark, DARK_THEME);

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
