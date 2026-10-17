import { createHandler } from "../src/handler.ts";
import { equal, fixtureClient, includes } from "./fixture.ts";

Deno.test("import-safe handler redirects Deno hosts without querying upstream", async () => {
  const handler = createHandler(fixtureClient({ getVersions: () => { throw Error("unexpected fetch"); } }));
  for (const host of ["preview.deno.net", "preview.deno.dev"]) {
    const response = await handler(new Request(`https://${host}/feature/123?x=1`));
    equal(response.status, 301);
    equal(response.headers.get("location"), "https://chromestatuslite.com/feature/123?x=1");
  }
});

Deno.test("static assets and unknown paths", async () => {
  const handler = createHandler(fixtureClient());
  const asset = await handler(new Request("https://chromestatuslite.com/styles/index.css"));
  equal(asset.status, 200);
  includes(asset.headers.get("content-type") || "", "text/css");
  includes(await asset.text(), "body");
  equal((await handler(new Request("https://chromestatuslite.com/unknown"))).status, 404);
  equal((await handler(new Request("https://chromestatuslite.com/scripts/missing.js"))).status, 404);
  const verification = await handler(new Request("https://chromestatuslite.com/google1bf7ef037ae116eb.html"));
  equal(verification.status, 200);
  includes(verification.headers.get("content-type") || "", "text/html");
  includes(await verification.text(), "google-site-verification: google1bf7ef037ae116eb.html");
  // Encoded separators must not escape the explicit static asset whitelist.
  equal((await handler(new Request("https://chromestatuslite.com/scripts/%2e%2e%2fmain.ts"))).status, 404);
});
