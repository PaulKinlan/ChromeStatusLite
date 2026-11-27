import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { createHandler, type StaticAssetFetcher } from "../src/handler.ts";
import worker from "../src/worker.ts";
import { equal, fixtureClient, includes } from "./fixture.ts";

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

function createDiskAssets(staticRoot: string): StaticAssetFetcher {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const filePath = path.join(staticRoot, url.pathname);
      const ext = path.extname(url.pathname);
      const type = MIME_TYPES[ext] || "application/octet-stream";
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) return new Response("Not found", { status: 404 });
        if (request.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: {
              "content-type": type,
              "content-length": String(stat.size),
            },
          });
        }
        const data = await fs.readFile(filePath);
        return new Response(data, {
          status: 200,
          headers: { "content-type": type },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  };
}

function resolveChromeBin(): string {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const macChrome =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(macChrome)) return macChrome;
  return "google-chrome";
}

function assertStylesheetLoaded(statuses: number[]): void {
  if (statuses.length === 0 || statuses.some((status) => status !== 200)) {
    throw new Error(
      `Browser stylesheet request failed: ${JSON.stringify(statuses)}`,
    );
  }
}

const FOCUS_PROBE_IDS = [
  "link",
  "button",
  "select",
  "input",
  "textarea",
  "summary",
  "chip",
];
const NAV_PLACEHOLDER = "<!--nav-->";
const styleProbePage =
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
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

const CHROME = resolveChromeBin();
const FOCUS_RING = "outline=solid 2px rgb(0, 100, 193)";

type CdpReply = { result?: any; error?: { message?: string } };
type CdpPage = {
  call: (method: string, params?: Record<string, unknown>) => Promise<CdpReply>;
  evaluate: (expression: string) => Promise<unknown>;
  close: () => Promise<void>;
};

function cdpClient(
  ws: WebSocket,
): { attach: (url: string) => Promise<CdpPage> } {
  let nextId = 1;
  const pending = new Map<number, (reply: CdpReply) => void>();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number };
    if (message.id === undefined) return;
    const resolve = pending.get(message.id);
    if (resolve === undefined) return;
    pending.delete(message.id);
    resolve(message as CdpReply);
  };
  const send = (
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ) =>
    new Promise<CdpReply>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId === undefined ? {} : { sessionId }),
        }),
      );
    });
  return {
    async attach(url: string): Promise<CdpPage> {
      const target = await send("Target.createTarget", { url });
      const targetId = target.result?.targetId as string | undefined;
      if (targetId === undefined) {
        throw new Error(
          `Could not open ${url}: ${target.error?.message ?? "no target"}`,
        );
      }
      const attached = await send("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      const sessionId = attached.result?.sessionId as string | undefined;
      if (sessionId === undefined) {
        throw new Error(
          `Could not attach to ${url}: ${
            attached.error?.message ?? "no session"
          }`,
        );
      }
      const call = (method: string, params: Record<string, unknown> = {}) =>
        send(method, params, sessionId);
      const evaluate = async (expression: string) => {
        const reply = await call("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        const details = reply.result?.exceptionDetails;
        if (reply.error || details) {
          throw new Error(
            `Probe expression failed: ${
              reply.error?.message ?? details?.text
            } ${details?.exception?.description ?? ""}`.trim(),
          );
        }
        return reply.result?.result?.value;
      };
      for (
        const domain of [
          "Page.enable",
          "Runtime.enable",
          "DOM.enable",
          "CSS.enable",
        ]
      ) {
        const enabled = await call(domain);
        if (enabled.error) {
          throw new Error(`${domain} failed: ${enabled.error.message}`);
        }
      }
      return {
        call,
        evaluate,
        close: async () => {
          await send("Target.closeTarget", { targetId });
        },
      };
    },
  };
}

async function launchDebugChrome(): Promise<
  { ws: WebSocket; close: () => Promise<void> }
> {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "csl-chrome-"));
  const child = spawn(
    CHROME,
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  let log = "";
  let announce = (_: string) => {};
  const endpoint = new Promise<string>((resolve) => {
    announce = resolve;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    log = (log + chunk.toString("utf8")).slice(-4096);
    const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
    if (match) announce(match[1]);
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), 20_000);
  });
  const browserUrl = await Promise.race([endpoint, expired]);
  clearTimeout(timer);

  if (browserUrl === "") {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Chrome reported no DevTools endpoint: ${log.slice(-400)}`);
  }

  const ws = new WebSocket(browserUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () =>
      reject(new Error(`DevTools WebSocket ${browserUrl} failed to open`));
  });

  return {
    ws,
    close: async () => {
      try {
        ws.close();
      } catch {
        // already closed
      }
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
      await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}

const focusMeasure = (id: string): string =>
  `(() => {
  const control = document.getElementById(${JSON.stringify(id)});
  const style = getComputedStyle(control);
  return ["fv=" + (control.matches(":focus-visible") ? 1 : 0),
    "outline=" + style.outlineStyle + " " + style.outlineWidth + " " + style.outlineColor,
    "offset=" + style.outlineOffset,
    "border=" + style.borderTopWidth + " " + style.borderTopColor].join("|");
})()`;

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
  lines.push("WRAP|heading=" + getComputedStyle(document.getElementById("heading")).textWrap +
    "|date=" + getComputedStyle(document.getElementById("date")).textWrap +
    "|canvas=" + getComputedStyle(document.getElementById("canvas")).textWrap);
  const arrowStyle = getComputedStyle(document.getElementById("select"));
  const arrowFill = arrowStyle.backgroundImage.match(/fill='rgb\\(([\\d.]+), ([\\d.]+), ([\\d.]+)\\)'/);
  if (arrowFill) {
    const rgb = "rgb(" + arrowFill.slice(1).join(", ") + ")";
    lines.push("ARROW|fill=" + rgb + "|surface=" + arrowStyle.backgroundColor +
      "|contrast=" + ratio(rgb, arrowStyle.backgroundColor).toFixed(2));
  } else {
    lines.push("ARROW|fill=none");
  }
  return lines;
})()`;

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

async function probeStyles(root: string): Promise<{
  focus: string[];
  withoutCss: string[];
  light: string[];
  dark: string[];
  targets: string[];
  clip: string[];
}> {
  const browser = await launchDebugChrome();
  try {
    const page = await cdpClient(browser.ws).attach(`${root}/__style_probe`);
    try {
      const deadline = performance.now() + 15_000;
      for (;;) {
        const ready = await page
          .evaluate(
            `document.readyState === "complete" && (document.styleSheets[0]?.cssRules?.length ?? 0) > 0`,
          )
          .catch(() => false);
        if (ready === true) break;
        if (performance.now() > deadline) {
          throw new Error("The probe page never parsed the served stylesheet");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const light = (await page.evaluate(themeMeasure)) as string[];
      const clipOn = `css-on|${await page.evaluate(clipMeasure)}`;
      const document_ = await page.call("DOM.getDocument", { depth: -1 });
      const documentNodeId = document_.result?.root?.nodeId as
        | number
        | undefined;
      if (documentNodeId === undefined) {
        throw new Error("DevTools returned no document node for the probe page");
      }
      const nodes = new Map<string, number>();
      for (const id of FOCUS_PROBE_IDS) {
        const found = await page.call("DOM.querySelector", {
          nodeId: documentNodeId,
          selector: `#${id}`,
        });
        const nodeId = found.result?.nodeId as number | undefined;
        if (!nodeId) throw new Error(`The probe page has no #${id} control`);
        nodes.set(id, nodeId);
      }
      const forceFocusVisible = async () => {
        for (const [id, nodeId] of nodes) {
          const forced = await page.call("CSS.forcePseudoState", {
            nodeId,
            forcedPseudoClasses: ["focus-visible"],
          });
          if (forced.error) {
            throw new Error(
              `Could not force :focus-visible on #${id}: ${forced.error.message}`,
            );
          }
        }
      };
      await forceFocusVisible();
      const focus: string[] = [];
      for (const id of FOCUS_PROBE_IDS) {
        focus.push(`css-on|${id}|${await page.evaluate(focusMeasure(id))}`);
      }
      await page.evaluate(`document.styleSheets[0].disabled = true`);
      const clipOff = `css-off|${await page.evaluate(clipMeasure)}`;
      await forceFocusVisible();
      const withoutCss: string[] = [];
      for (const id of FOCUS_PROBE_IDS) {
        withoutCss.push(`css-off|${id}|${await page.evaluate(focusMeasure(id))}`);
      }
      await page.evaluate(`document.styleSheets[0].disabled = false`);
      const targets = (await page.evaluate(targetMeasure)) as string[];
      await page.call("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: "dark" }],
      });
      const dark = (await page.evaluate(themeMeasure)) as string[];
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

const LIGHT_THEME = {
  PAGE: "bg=rgb(255, 255, 255)|color=rgb(0, 0, 0)",
  SURFACE: "bg=rgb(255, 255, 255)|color=rgb(0, 0, 0)",
  LINK: "color=rgb(0, 100, 193)",
  BADGE: "bg=rgb(255, 235, 238)|color=rgb(198, 40, 40)",
  ADD: "bg=rgb(230, 255, 236)|color=rgb(17, 99, 41)",
  DATE: "color=rgb(102, 102, 102)",
  WRAP: "heading=balance|date=pretty|canvas=wrap",
  ARROW: "fill=rgb(118, 118, 118)",
};
const DARK_THEME = {
  PAGE: "bg=rgb(20, 22, 26)|color=rgb(236, 238, 241)",
  SURFACE: "bg=rgb(20, 22, 26)|color=rgb(236, 238, 241)",
  LINK: "color=rgb(108, 182, 255)",
  BADGE: "bg=rgb(59, 26, 30)|color=rgb(255, 154, 154)",
  ADD: "bg=rgb(18, 48, 28)|color=rgb(126, 226, 168)",
  DATE: "color=rgb(194, 199, 207)",
  WRAP: "heading=balance|date=pretty|canvas=wrap",
  ARROW: "fill=rgb(118, 118, 118)",
};

function assertThemeTokens(
  lines: string[],
  expected: Record<string, string>,
): void {
  for (const [tag, needle] of Object.entries(expected)) {
    includes(probeLine(lines, tag), needle);
  }
  for (
    const [tag, minimum] of [
      ["PAGE", 4.5],
      ["SURFACE", 4.5],
      ["ARROW", 3],
    ] as const
  ) {
    const match = probeLine(lines, tag).match(/contrast=([\d.]+)/);
    if (!match) throw new Error(`Style probe reported no contrast for ${tag}`);
    if (!(Number(match[1]) >= minimum)) {
      throw new Error(
        `${tag} contrast ${match[1]} is below ${minimum}:1: ${
          probeLine(lines, tag)
        }`,
      );
    }
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
  equal(numberField(line, "navCount"), 7);
  for (const key of ["navMinW", "navMinH", "chipW", "chipH"]) {
    const measured = numberField(line, key);
    if (!(measured >= MIN_TARGET_PX)) {
      throw new Error(
        `${key} ${measured}px is under the ${MIN_TARGET_PX}px target size: ${line}`,
      );
    }
  }
}

function assertNavMarkup(html: string): void {
  if (!html.includes('class="menu-button"')) {
    throw new Error("Primary nav lost its menu button");
  }
  if (!/<ul id="site-menu" class="site-menu" popover="auto">/.test(html)) {
    throw new Error(
      "Nav list is not a popover, so the menu button cannot open it",
    );
  }
}

function assertFocusRing(focus: string[], withoutCss: string[]): void {
  for (const id of FOCUS_PROBE_IDS) {
    const line = focusProbeLine(focus, "css-on", id);
    includes(line, "fv=1");
    includes(line, FOCUS_RING);
    includes(line, "offset=2px");
  }
  for (const id of FOCUS_PROBE_IDS) {
    const line = focusProbeLine(withoutCss, "css-off", id);
    if (line.includes(FOCUS_RING)) {
      throw new Error(
        `Author focus ring survived a disabled stylesheet: ${line}`,
      );
    }
  }
  includes(
    focusProbeLine(focus, "css-on", "chip"),
    "border=1px rgb(240, 0, 0)",
  );
}

function assertDiffClipsWithoutScrolling(clip: string[]): void {
  const on = probeLine(clip, "css-on");
  includes(on, "overflowY=clip");
  includes(on, "overflowX=clip");
  includes(on, "scrollY=0");
  includes(on, "scrollX=0");
  includes(on, "contentOverflows=1");
  const off = probeLine(clip, "css-off");
  includes(off, "overflowY=visible");
  includes(off, "overflowX=visible");
}

function runChromeDump(
  url: string,
  profile: string,
  screenshot: string,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      CHROME,
      [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        `--user-data-dir=${profile}`,
        "--virtual-time-budget=2000",
        `--screenshot=${screenshot}`,
        "--dump-dom",
        url,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(chunks).toString("utf8"),
      });
    });
  });
}

test("real HTTP and headless browser render a fixture page and load its stylesheet", async () => {
  equal(typeof worker.fetch, "function");
  equal(typeof worker.scheduled, "function");

  const assets = createDiskAssets(path.join(process.cwd(), "static"));
  const handler = createHandler({ client: fixtureClient(), assets });
  let denyStylesheet = false;
  let browserCssStatuses: number[] = [];

  const homeHtml = await (await handler(
    new Request("https://chromestatuslite.com/?version=112"),
  )).text();
  const renderedNav = homeHtml.match(/<nav[^>]*>[\s\S]*?<\/nav>/);
  if (!renderedNav) throw new Error("Rendered page carries no <nav> to measure");
  includes(renderedNav[0], 'popover="auto"');
  const probePage = styleProbePage.replace(NAV_PLACEHOLDER, renderedNav[0]);

  const server = http.createServer(async (req, res) => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const rawUrl = `http://127.0.0.1:${port}${req.url || "/"}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) headers.set(k, v.join(", "));
      else if (v !== undefined) headers.set(k, v);
    }
    const request = new Request(rawUrl, { method: req.method, headers });

    let response: Response;
    if (request.headers.get("x-fixture-host")) {
      const url = new URL(request.url);
      url.hostname = "preview.deno.net";
      response = await handler(new Request(url, request));
    } else if (new URL(request.url).pathname === "/__style_probe") {
      response = new Response(probePage, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } else {
      const isCss = new URL(request.url).pathname === "/styles/index.css";
      response = isCss && denyStylesheet
        ? new Response("Not found", { status: 404 })
        : await handler(request);
      if (isCss) browserCssStatuses.push(response.status);
    }

    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    const body = Buffer.from(await response.arrayBuffer());
    res.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const root = `http://127.0.0.1:${port}`;
  const profiles: string[] = [];

  const browser = async (routePath = "/?version=112") => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), "csl-dump-"));
    profiles.push(profile);
    const screenshot = path.join(profile, "render.png");
    const result = await runChromeDump(`${root}${routePath}`, profile, screenshot);
    equal(result.code, 0);
    return { html: result.stdout, screenshot };
  };

  try {
    const redirect = await fetch(`${root}/feature/123?x=1`, {
      headers: { "x-fixture-host": "preview.deno.net" },
      redirect: "manual",
    });
    equal(redirect.status, 301);
    equal(
      redirect.headers.get("location"),
      "https://chromestatuslite.com/feature/123?x=1",
    );

    const css = await fetch(`${root}/styles/index.css`);
    equal(css.status, 200);
    includes(css.headers.get("content-type") || "", "text/css");

    const robots = await fetch(`${root}/robots.txt`);
    equal(robots.status, 200);
    includes(await robots.text(), "User-agent: *");

    const favicon = await fetch(`${root}/favicon.svg`);
    equal(favicon.status, 200);
    includes(favicon.headers.get("content-type") || "", "image/svg+xml");

    const missing = await fetch(`${root}/missing`);
    equal(missing.status, 404);

    const feed = await fetch(`${root}/feed.xml`);
    equal(feed.status, 200);
    includes(feed.headers.get("content-type") || "", "application/rss+xml");
    includes(await feed.text(), "<title>Chrome Status Lite</title>");

    const apiVersion = await fetch(`${root}/api/version/120`);
    equal(apiVersion.status, 200);
    includes(apiVersion.headers.get("content-type") || "", "application/json");
    const apiJson = (await apiVersion.json()) as {
      version: number;
      total_features: number;
    };
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
    assertStylesheetLoaded(browserCssStatuses);
    assertNavMarkup(html);
    if ((await fs.stat(screenshot)).size < 1000) {
      throw new Error("Empty browser screenshot");
    }

    const probe = await probeStyles(root);
    assertFocusRing(probe.focus, probe.withoutCss);
    assertTapTargets(probe.targets);
    assertDiffClipsWithoutScrolling(probe.clip);
    assertThemeTokens(probe.light, LIGHT_THEME);
    assertThemeTokens(probe.dark, DARK_THEME);

    denyStylesheet = true;
    browserCssStatuses = [];
    const broken = await browser();
    includes(broken.html, "Chrome Release 112");
    let rejected = false;
    try {
      assertStylesheetLoaded(browserCssStatuses);
    } catch {
      rejected = true;
    }
    equal(rejected, true);
    equal(browserCssStatuses[0], 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const profile of profiles) {
      await fs.rm(profile, { recursive: true, force: true });
    }
  }
});
