import { createHandler } from "../src/handler.ts";
import { equal, fixtureClient, includes } from "./fixture.ts";

Deno.test("real HTTP and headless browser render a fixture page and static assets", async () => {
  const handler = createHandler(fixtureClient());
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (request) => {
    // Route a fixture host through the actual HTTP listener; fetch cannot override Host.
    if (request.headers.get("x-fixture-host")) {
      const url = new URL(request.url);
      url.hostname = "preview.deno.net";
      return handler(new Request(url, request));
    }
    return handler(request);
  });
  const port = (server.addr as Deno.NetAddr).port;
  const root = `http://127.0.0.1:${port}`;
  const profile = await Deno.makeTempDir();
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

    const screenshot = `${profile}/render.png`;
    const chrome = new Deno.Command(Deno.env.get("CHROME_BIN") || "google-chrome", {
      args: ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
        "--disable-background-networking", `--user-data-dir=${profile}`,
        "--virtual-time-budget=2000", `--screenshot=${screenshot}`, "--dump-dom", `${root}/?version=112`],
      stdout: "piped", stderr: "piped",
    });
    const result = await chrome.output();
    equal(result.code, 0);
    const html = new TextDecoder().decode(result.stdout);
    includes(html, "Chrome Release 112");
    includes(html, "Fixture feature");
    includes(html, "https://chromestatuslite.com/?version=112");
    // The browser must load the stylesheet, not just receive HTML.
    includes(html, "/styles/index.css");
    if ((await Deno.stat(screenshot)).size < 1000) throw new Error("Empty browser screenshot");
  } finally {
    await server.shutdown();
    await Deno.remove(profile, { recursive: true });
  }
});
