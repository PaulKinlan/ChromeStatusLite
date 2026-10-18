import { createHandler } from "../src/handler.ts";
import wiki from "../src/routes/wiki.ts";
import wikiTopic, { fetchQueryFeatures } from "../src/routes/wiki-topic.ts";
import { equal, fixtureClient, includes } from "./fixture.ts";
import {
  WIKI_TOPICS,
  collectTopicFeatures,
  consensus,
  getTopic,
  stageGroups,
  tagFeature,
  timeline,
} from "../src/lib/wiki.ts";

const gpuFeature = {
  id: 1,
  name: "WebGPU",
  summary: "Exposes modern GPU compute and rendering capabilities to the web.",
  search_tags: ["wgpu"],
  browsers: {
    chrome: { status: { text: "Enabled by default", milestone_str: "113" } },
    ff: { view: { text: "Shipped/Shipping" } },
    safari: { view: { text: "Shipped/Shipping" } },
    webdev: { view: { text: "Strongly positive" } },
  },
};

const aiFeature = {
  id: 2,
  name: "Prompt API",
  summary: "On-device language model prompting with Gemini Nano.",
  browsers: {
    chrome: { status: { text: "Origin trial", milestone_str: "131" } },
    ff: { view: { text: "No signal" } },
    safari: { view: { text: "No signal" } },
  },
};

const proposedFeature = {
  id: 3,
  name: "WebGPU texture compression",
  summary: "Proposed extension to WebGPU.",
  browsers: {
    chrome: { status: { text: "Proposed", milestone_str: "Proposed" } },
  },
};

Deno.test("wiki tagger classifies deterministically and offline", () => {
  equal(tagFeature(gpuFeature).join(","), "webgpu");
  equal(tagFeature(aiFeature).join(","), "web-ai");
  // Cross-tagging: a GPU AI feature belongs to both topics, sorted by slug.
  const cross = tagFeature({ name: "WebGPU AI accelerator", summary: "Prompt API on GPU." });
  includes(cross.join(","), "webgpu");
  includes(cross.join(","), "web-ai");
  equal(cross.join(","), [...cross].sort().join(","));
  equal(tagFeature(null).length, 0);
  equal(tagFeature({}).length, 0);
  // Every topic definition has a unique slug and a query.
  const slugs = WIKI_TOPICS.map((topic) => topic.slug);
  equal(new Set(slugs).size, slugs.length);
  for (const topic of WIKI_TOPICS) {
    if (topic.queries.length === 0) throw new Error(`${topic.slug} has no queries`);
  }
});

Deno.test("wiki grouping, consensus, and timeline helpers", () => {
  const features = [aiFeature, gpuFeature, proposedFeature];

  const groups = stageGroups(features);
  equal(groups.map((group) => group.stage).join(","), "Enabled by default,Origin trial,Proposed");

  const tally = consensus(features);
  equal(tally.Firefox["Shipped/Shipping"], 1);
  equal(tally.Safari["No signal"], 1);
  equal(tally["Web developers"]["Strongly positive"], 1);

  // Non-numeric milestone labels ("Proposed") are not timeline entries.
  const entries = timeline(features);
  equal(entries.length, 2);
  equal(entries[0].milestone, 131);
  equal(entries[1].milestone, 113);

  // collectTopicFeatures dedupes by id across query results and sorts by name.
  const merged = collectTopicFeatures([
    { features: [gpuFeature, aiFeature] },
    { features: [gpuFeature] },
    null,
    { bogus: true },
  ]);
  equal(merged.length, 2);
  equal(merged[0].id, 2);
});

Deno.test("/wiki lists every topic with links and counts", async () => {
  const handler = createHandler(fixtureClient());
  const res = await handler(new Request("https://chromestatuslite.com/wiki"));
  equal(res.status, 200);
  const html = await res.text();
  includes(html, "Web Platform Topic Wiki");
  includes(html, '<a href="/wiki/webgpu">WebGPU</a>');
  includes(html, '<a href="/wiki/web-ai">Built-in Web AI</a>');
  includes(html, "1 feature</a>"); // fixture total_count: 1, singular form
});

Deno.test("/wiki tolerates a topic whose queries all fail", async () => {
  const handler = createHandler(fixtureClient({
    getFeaturesByQuery: () => Promise.reject(new Error("upstream down")),
  }));
  const res = await handler(new Request("https://chromestatuslite.com/wiki"));
  equal(res.status, 200);
  const html = await res.text();
  includes(html, '<a href="/wiki/webgpu">WebGPU</a>');
});

Deno.test("/wiki/:topic groups features by stage with consensus and timeline", async () => {
  const handler = createHandler(fixtureClient({
    getFeaturesByQuery: async (query: string) => {
      if (query === "webgpu") {
        return { total_count: 3, features: [gpuFeature, gpuFeature, proposedFeature] };
      }
      return { total_count: 0, features: [] };
    },
  }));
  const res = await handler(new Request("https://chromestatuslite.com/wiki/webgpu"));
  equal(res.status, 200);
  const html = await res.text();
  includes(html, "2 features tagged with this topic"); // deduped
  includes(html, "Cross-browser consensus");
  includes(html, "Shipped/Shipping (1)");
  includes(html, "Features by stage");
  includes(html, "Enabled by default (1)");
  includes(html, "Proposed (1)");
  includes(html, "Timeline");
  includes(html, '<a href="/?version=113">113</a>');
  includes(html, '<a href="/feature/1">WebGPU</a>');
});

Deno.test("/wiki/:topic renders cross-topic links for multi-tagged features", async () => {
  const handler = createHandler(fixtureClient({
    getFeaturesByQuery: async () => ({
      total_count: 1,
      features: [{
        ...gpuFeature,
        name: "WebGPU on-device AI",
        summary: "GPU acceleration for the Prompt API.",
      }],
    }),
  }));
  const res = await handler(new Request("https://chromestatuslite.com/wiki/webgpu"));
  const html = await res.text();
  includes(html, "Also tagged:");
  includes(html, '<a href="/wiki/web-ai">Built-in Web AI</a>');
});

Deno.test("/wiki/:topic shows an error notice when every query fails", async () => {
  const handler = createHandler(fixtureClient({
    getFeaturesByQuery: () => Promise.reject(new Error("upstream down")),
  }));
  const res = await handler(new Request("https://chromestatuslite.com/wiki/webgpu"));
  equal(res.status, 200);
  includes(await res.text(), "Unable to load topic data from chromestatus.com");
});

Deno.test("/wiki/:topic is 404 for unknown slugs without querying upstream", async () => {
  const handler = createHandler(fixtureClient({
    getFeaturesByQuery: () => { throw new Error("unexpected fetch"); },
  }));
  const res = await handler(new Request("https://chromestatuslite.com/wiki/no-such-topic"));
  equal(res.status, 404);
  includes(await res.text(), "Topic not found");

  // Direct route-module coverage: the 404 path must not consult the client.
  const match = new URLPattern({ pathname: "/wiki/:topic" }).exec("https://chromestatuslite.com/wiki/no-such-topic")!;
  const direct = await wikiTopic(
    new Request("https://chromestatuslite.com/wiki/no-such-topic"),
    match,
    fixtureClient({ getFeaturesByQuery: () => { throw new Error("unexpected fetch"); } }),
  );
  equal(direct.status, 404);
});

Deno.test("/wiki route module renders the directory directly", async () => {
  const res = await wiki(new Request("https://chromestatuslite.com/wiki"), fixtureClient());
  equal(res.status, 200);
  includes(await res.text(), "Web Platform Topic Wiki");
});

Deno.test("wiki tagger avoids bare-common-word false positives (review chrome-status-lite-asn)", () => {
  // A WGSL memory layout is not CSS Layout, and WGSL storage buffers are not
  // the Storage & Files topic.
  equal(
    tagFeature({ name: "WebGPU: Uniform buffer standard layout", summary: "Uniform buffer standard layout for WGSL storage buffers." }).join(","),
    "webgpu",
  );
  equal(
    tagFeature({ name: "WGSL: unrestricted pointer parameters", summary: "Pointers to storage/uniform/workgroup address spaces are allowed." }).join(","),
    "webgpu",
  );
  // A canvas text-direction getter is not the Fonts & Text topic.
  equal(
    tagFeature({ name: "Canvas2D getConfiguration", summary: "Returns the text-direction of a canvas context." }).length,
    0,
  );
  // Real topic members still tag: CSS container queries hit css-layout,
  // IndexedDB hits storage, an install prompt hits pwa.
  equal(tagFeature({ name: "CSS container queries", summary: "Size container queries for elements." }).join(","), "css-layout");
  includes(tagFeature({ name: "IndexedDB 3.0", summary: "IndexedDB improvements." }).join(","), "storage");
  includes(tagFeature({ name: "Richer install UI", summary: "App install prompt improvements." }).join(","), "pwa");
});

Deno.test("fetchQueryFeatures paginates past the 100-result default page (review chrome-status-lite-9am)", async () => {
  const calls: { options: { num?: number; start?: number } }[] = [];
  const client = fixtureClient({
    getFeaturesByQuery: async (_query: string, options: { num?: number; start?: number } = {}) => {
      calls.push({ options });
      const start = options.start ?? 0;
      return {
        total_count: 250,
        features: Array.from({ length: Math.min(100, 250 - start) }, (_, i) => ({
          id: start + i,
          name: `Feature ${start + i}`,
        })),
      };
    },
  });
  const result = await fetchQueryFeatures("javascript", client);
  equal(result.features.length, 250);
  equal(result.total_count, 250);
  equal(result.complete, true);
  equal(calls.length, 3);
  equal(calls[0].options.start, undefined);
  equal(calls[1].options.start, 100);
  equal(calls[2].options.start, 200);
  for (const call of calls) equal(call.options.num, 100);
});

Deno.test("fetchQueryFeatures reports incomplete when a continuation fails twice (review chrome-status-lite-lmj)", async () => {
  let attempts = 0;
  const client = fixtureClient({
    getFeaturesByQuery: async (_query: string, options: { num?: number; start?: number } = {}) => {
      const start = options.start ?? 0;
      if (start >= 200) {
        attempts++;
        throw new Error("page lost");
      }
      return {
        total_count: 300,
        features: Array.from({ length: 100 }, (_, i) => ({ id: start + i, name: `F${start + i}` })),
      };
    },
  });
  const result = await fetchQueryFeatures("javascript", client);
  equal(result.features.length, 200);
  equal(result.complete, false);
  equal(attempts, 2); // one retry, not silent acceptance
});

Deno.test("/wiki/:topic marks the inventory incomplete when a continuation page fails (review chrome-status-lite-lmj)", async () => {
  const handler = createHandler(fixtureClient({
    getFeaturesByQuery: async (query: string, options: { num?: number; start?: number } = {}) => {
      if (query !== "javascript") return { total_count: 0, features: [] };
      const start = options.start ?? 0;
      if (start === 100) throw new Error("503 page 2");
      return {
        total_count: 250,
        features: Array.from({ length: start === 200 ? 50 : 100 }, (_, i) => ({
          id: start + i,
          name: `${query} feature ${start + i}`,
        })),
      };
    },
  }));
  const res = await handler(new Request("https://chromestatuslite.com/wiki/javascript"));
  equal(res.status, 200);
  const html = await res.text();
  includes(html, "the list below is incomplete");
  includes(html, "150 features tagged with this topic");
  includes(html, "javascript feature 200"); // later pages still render
  if (html.includes("javascript feature 100")) throw new Error("failed page rendered as present");
});

Deno.test("/wiki/:topic omits the consensus section when no feature has view data (review chrome-status-lite-098)", async () => {
  const handler = createHandler(fixtureClient({
    getFeaturesByQuery: async () => ({
      total_count: 1,
      features: [{ id: 9, name: "Bare feature", summary: "No upstream view data." }],
    }),
  }));
  const res = await handler(new Request("https://chromestatuslite.com/wiki/webgpu"));
  equal(res.status, 200);
  const html = await res.text();
  if (html.includes("Cross-browser consensus")) {
    throw new Error("consensus section rendered with zero view data");
  }
});

Deno.test("/wiki directory counts use one cheap num=1 request per topic (review chrome-status-lite-avm)", async () => {
  const calls: { options: { num?: number; start?: number } }[] = [];
  const handler = createHandler(fixtureClient({
    getFeaturesByQuery: async (_query: string, options: { num?: number; start?: number } = {}) => {
      calls.push({ options });
      return { total_count: 488, features: [] };
    },
  }));
  const res = await handler(new Request("https://chromestatuslite.com/wiki"));
  equal(res.status, 200);
  const html = await res.text();
  includes(html, "488 features");
  equal(calls.length, WIKI_TOPICS.length);
  for (const call of calls) {
    equal(call.options.num, 1);
    equal(call.options.start, undefined);
  }
});


Deno.test("/wiki/:topic shows the incomplete notice even when nothing rendered (review chrome-status-lite-lmj)", async () => {
  // Exact round-3 repro: primary query throws, secondary returns zero
  // results. The page must not claim "No features are currently tagged".
  const handler = createHandler(fixtureClient({
    getFeaturesByQuery: async (query: string) => {
      if (query === "javascript") throw new Error("503 primary");
      return { total_count: 0, features: [] };
    },
  }));
  const res = await handler(new Request("https://chromestatuslite.com/wiki/javascript"));
  equal(res.status, 200);
  const html = await res.text();
  includes(html, "is incomplete");
  if (html.includes("No features are currently tagged")) {
    throw new Error("false empty-topic claim rendered alongside a failed query");
  }
});

Deno.test("/wiki/:topic says no features only when every query succeeded empty", async () => {
  const handler = createHandler(fixtureClient({
    getFeaturesByQuery: async () => ({ total_count: 0, features: [] }),
  }));
  const res = await handler(new Request("https://chromestatuslite.com/wiki/webgpu"));
  equal(res.status, 200);
  const html = await res.text();
  includes(html, "No features are currently tagged with this topic.");
  if (html.includes("is incomplete")) throw new Error("false incomplete notice on clean empty result");
});

Deno.test("fetchQueryFeatures reports incomplete on a short successful continuation (review chrome-status-lite-lmj round 4)", async () => {
  const client = fixtureClient({
    getFeaturesByQuery: async (_query: string, options: { num?: number; start?: number } = {}) => {
      const start = options.start ?? 0;
      return {
        total_count: 250,
        // Page start=100 succeeds with zero features; start=200 returns 50.
        features: Array.from({ length: start === 100 ? 0 : start === 200 ? 50 : 100 }, (_, i) => ({
          id: start + i,
          name: `F${start + i}`,
        })),
      };
    },
  });
  const result = await fetchQueryFeatures("javascript", client);
  equal(result.features.length, 150);
  equal(result.complete, false);
});

Deno.test("/wiki/:topic marks the inventory incomplete on a short successful continuation (review chrome-status-lite-lmj round 4)", async () => {
  const handler = createHandler(fixtureClient({
    getFeaturesByQuery: async (query: string, options: { num?: number; start?: number } = {}) => {
      const start = options.start ?? 0;
      return {
        total_count: 250,
        features: Array.from({ length: start === 100 ? 0 : start === 200 ? 50 : 100 }, (_, i) => ({
          id: `${query}-${start + i}`,
          name: `${query} feature ${start + i}`,
        })),
      };
    },
  }));
  const res = await handler(new Request("https://chromestatuslite.com/wiki/javascript"));
  equal(res.status, 200);
  const html = await res.text();
  includes(html, "is incomplete");
  includes(html, "javascript feature 200"); // later pages still render
  if (html.includes("javascript feature 100")) throw new Error("short page rendered as present");
});

Deno.test("getTopic resolves slugs", () => {
  equal(getTopic("webgpu")?.title, "WebGPU");
  equal(getTopic("nope"), undefined);
});
