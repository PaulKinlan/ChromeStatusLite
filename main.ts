import { serve } from "https://deno.land/std@0.152.0/http/server.ts";
import { join } from "https://deno.land/std@0.152.0/path/mod.ts";

import { Route } from "./src/types.ts";
import { StripStream } from "./src/stream-utils.ts";

class StaticFileHandler {

  #basePath: string = "";

  constructor(base: string) {
    this.#basePath = base;
  }

  handler(request: Request): Response {
    const pathname = new URL(request.url).pathname;
    const resolvedPathname = (pathname == "" || pathname == "/") ? pathname = "/index.html" : pathname;

    console.log(pathname, resolvedPathname);
    const path = join(Deno.cwd(), this.#basePath, resolvedPathname)
    
    try {
      const file = Deno.readFile(path);
      return file.then(data => new Response(data));
    } catch (fileErr) {
      console.log(fileErr);
      return null;
    }
  }

  get pattern(): URLPattern {
    return new URLPattern({ pathname: "*" })
  }
}

serve((req: Request) => {
  const url = req.url;
  console.log(url)
  const staticFiles = new StaticFileHandler('static');
  let response: Response = new Response("<html>404</html>", { status: 404 });

  const routes: Array<Route> = [
    [
      new URLPattern({ pathname: "/api/features" }),
      (request) => {
        const version = new URL(req.url).searchParams.get("version") || 100;
        const featuresResponse = fetch(`https://chromestatus.com/api/v0/features?milestone=${version}`);
        return featuresResponse.then(response => new Response(response.body.pipeThrough(new StripStream())));
      }
    ],
    // Fall through.
    [
      staticFiles.pattern,
      staticFiles.handler.bind(staticFiles)
    ]
  ];

  for (const [pattern, handler] of routes) {
    if (pattern.test(url)) {
      const responseFromHandler = handler(req);

      if (responseFromHandler == null) {
        continue;
      }

      response = responseFromHandler;

      break;
    }
  }

  return response;
});
