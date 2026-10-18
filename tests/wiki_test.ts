import { createHandler } from "../src/handler.ts";
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
  includes(html, "1 features");
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
});

Deno.test("getTopic resolves slugs", () => {
  equal(getTopic("webgpu")?.title, "WebGPU");
  equal(getTopic("nope"), undefined);
});
