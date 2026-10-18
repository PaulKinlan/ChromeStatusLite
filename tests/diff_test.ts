import { createHandler } from "../src/handler.ts";
import { equal, fixtureClient, includes } from "./fixture.ts";

const left = {
  "Enabled by default": [
    { id: 111, name: "Older feature", summary: "Old summary" },
  ],
};
const right = {
  "Enabled by default": [{
    id: 222,
    name: "New <feature>",
    summary: "New & improved",
  }],
  "Removed": [{ id: 333, name: "Removed feature" }],
};

Deno.test("/diff compares two release milestones with distinct grouped columns", async () => {
  const calls: string[] = [];
  const client = fixtureClient({
    getFeaturesForVersion: async (version) => {
      calls.push(String(version));
      return String(version) === "119" ? left : right;
    },
  });
  const response = await createHandler(client)(
    new Request("https://chromestatuslite.com/diff?from=119&to=120"),
  );
  equal(response.status, 200);
  equal(calls.join(","), "119,120");
  const html = await response.text();
  includes(
    html,
    'href="https://chromestatuslite.com/diff?from=119&amp;to=120"',
  );
  includes(html, 'action="/diff"');
  // The shared nav must keep advertising the comparison route (review 8gx:
  // deleting the nav entry previously stayed green).
  includes(html, '<li><a href="/diff">Compare releases</a></li>');
  includes(html, '<li><a href="/deprecations">Deprecation Calendar</a></li>');
  includes(html, '<label for="from">From milestone</label>');
  includes(html, '<label for="to">To milestone</label>');
  includes(html, '<option value="119" selected>Chrome 119</option>');
  includes(html, '<option value="120" selected>Chrome 120</option>');
  includes(html, '<a href="/feature/111">Older feature</a>');
  includes(html, '<a href="/feature/222">New &lt;feature&gt;</a>');
  includes(html, "New &amp; improved");
  includes(html, "Removed (1)");
  includes(html, '<a href="/feature/333">Removed feature</a>');
  includes(html, "Origin trial (0)");
  equal(html.includes("New <feature>"), false);
});

Deno.test("/diff defaults to adjacent milestones, renders same-version notice, and fetches once", async () => {
  const calls: string[] = [];
  const handler = createHandler(
    fixtureClient({
      getFeaturesForVersion: async (version) => {
        calls.push(String(version));
        return left;
      },
    }),
  );
  const defaults = await handler(
    new Request("https://chromestatuslite.com/diff"),
  );
  equal(defaults.status, 200);
  includes(await defaults.text(), "Chrome 119");
  equal(calls.join(","), "119,120");
  calls.length = 0;
  const identical = await handler(
    new Request("https://chromestatuslite.com/diff?from=120&to=120"),
  );
  equal(identical.status, 200);
  includes(await identical.text(), "Choose different milestones");
  equal(calls.join(","), "120");
});

Deno.test("/diff rejects unknown milestones before requesting upstream data", async () => {
  let fetches = 0;
  const handler = createHandler(
    fixtureClient({
      getFeaturesForVersion: async () => {
        fetches++;
        return right;
      },
    }),
  );
  for (
    const query of [
      "?from=999&to=120",
      "?from=%3Cscript%3E&to=120",
      "?from=&to=120",
    ]
  ) {
    const response = await handler(
      new Request(`https://chromestatuslite.com/diff${query}`),
    );
    equal(response.status, 400);
    includes(await response.text(), "Choose two available Chrome milestones");
  }
  equal(fetches, 0);
});
