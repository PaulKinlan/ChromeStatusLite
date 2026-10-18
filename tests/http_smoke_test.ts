import { createHandler } from "../src/handler.ts";
import { main } from "../main.ts"; // loads the deploy entrypoint on every gate (import-safe)
import { equal, fixtureClient, includes } from "./fixture.ts";

function assertStylesheetLoaded(statuses: number[]): void {
  if (statuses.length === 0 || statuses.some((status) => status !== 200)) {
    throw new Error(`Browser stylesheet request failed: ${JSON.stringify(statuses)}`);
  }
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
  const browser = async () => {
    const profile = await Deno.makeTempDir();
    profiles.push(profile);
    const screenshot = `${profile}/render.png`;
    const chrome = new Deno.Command(Deno.env.get("CHROME_BIN") || "google-chrome", {
      args: ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
        "--disable-background-networking", `--user-data-dir=${profile}`,
        "--virtual-time-budget=2000", `--screenshot=${screenshot}`, "--dump-dom", `${root}/?version=112`],
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

    browserCssStatuses = [];
    const { html, screenshot } = await browser();
    includes(html, "Chrome Release 112");
    includes(html, "Fixture feature");
    includes(html, "https://chromestatuslite.com/?version=112");
    // The listener records the browser's CSS request and its response status.
    assertStylesheetLoaded(browserCssStatuses);
    if ((await Deno.stat(screenshot)).size < 1000) throw new Error("Empty browser screenshot");

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
