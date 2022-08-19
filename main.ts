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
    console.log(this)
    console.log("handler", this.#basePath)
    const path = join(Deno.cwd(), this.#basePath, new URL(request.url).pathname)
    const file = Deno.readFile(path);
    return file.then(data => new Response(data));
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

      console.log("passed test", pattern, url, handler)
      response = handler(req);
      break;
    }
  }

  return response;
});
