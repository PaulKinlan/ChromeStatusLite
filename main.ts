import { join } from "https://deno.land/std@0.152.0/path/mod.ts";
import { contentType } from "https://deno.land/std@0.152.0/media_types/mod.ts";

import { Route } from "./src/types.ts";
import { StripStream } from "./src/stream-utils.ts";
import index from "./src/routes/index.ts";
import deprecations from "./src/routes/deprecations.ts";
import feature from "./src/routes/feature.ts";

class StaticFileHandler {
  #basePath: string = "";

  constructor(base: string) {
    this.#basePath = base;
  }

  handler(request: Request): Response {
    const pathname = new URL(request.url).pathname;
    const extension = pathname.substr(pathname.lastIndexOf("."));
    const resolvedPathname =
      pathname == "" || pathname == "/" ? "/index.html" : pathname;
    const path = join(Deno.cwd(), this.#basePath, resolvedPathname);
    const file = Deno.readFile(path)
      .then(
        (data) =>
          new Response(data, {
            status: 200,
            headers: { "content-type": contentType(extension) },
          })
      ) // Need to think about content tyoes.
      .catch((_) => new Response("Not found", { status: 404 }));

    return file;
  }

  get pattern(): URLPattern {
    return new URLPattern({ pathname: "*" });
  }
}

// Deno Deploy injects the port to listen on via the PORT env var and
// expects the server to bind to 0.0.0.0. Deno.serve handles both by
// default; fall back to 8000 for local development.
const port = Number(Deno.env.get("PORT")) || 8000;

// Canonical custom domain. The app is also reachable on its *.deno.net deploy
// URL, but that host should not be indexed: requests arriving on a *.deno.net
// (or *.deno.dev) host are 301'd to the custom domain, and every page also
// carries a <link rel="canonical"> to this origin.
const CANONICAL_ORIGIN = "https://chromestatuslite.com";

Deno.serve({ port }, (req: Request) => {
  const reqUrl = new URL(req.url);
  if (
    reqUrl.hostname.endsWith(".deno.net") ||
    reqUrl.hostname.endsWith(".deno.dev")
  ) {
    return new Response(null, {
      status: 301,
      headers: {
        location: `${CANONICAL_ORIGIN}${reqUrl.pathname}${reqUrl.search}`,
      },
    });
  }

  const url = req.url;
  const staticFiles = new StaticFileHandler("static");
  let response: Response = new Response(
    new Response("Not found", { status: 404 })
  );

  const routes: Array<Route> = [
    [
      new URLPattern({ pathname: "/" }),
      (request) => {
        return index(request);
      },
    ],
    [
      new URLPattern({ pathname: "/deprecations" }),
      (request) => {
        return deprecations(request);
      },
    ],
    [
      new URLPattern({ pathname: "/feature/:id" }),
      (request, match) => {
        return feature(request, match);
      },
    ],
    // Fall through.
    [staticFiles.pattern, staticFiles.handler.bind(staticFiles)],
  ];

  for (const [pattern, handler] of routes) {
    const patternResult = pattern.exec(url);
    if (patternResult != null) {
      // Find the first matching route.
      response = handler(req, patternResult);
      break;
    }
  }

  return response;
});
