import { env } from "cloudflare:test";
import { beforeEach, test } from "vitest";
import { createHandler, type StatusClient } from "../src/handler.ts";
import wiki from "../src/routes/wiki.ts";
import wikiTopic, { fetchQueryFeatures } from "../src/routes/wiki-topic.ts";
import { equal, fixtureClient, includes } from "./fixture.ts";
import {
  collectTopicFeatures,
  consensus,
  getTopic,
  stageGroups,
  tagFeature,
  timeline,
  WIKI_TOPICS,
} from "../src/lib/wiki.ts";
import {
  CONTINUATION_POOL_SIZE,
  D1WikiTopicStore,
  getTopicData,
  refreshStaleWikiTopics,
  TOPIC_RETRY_TTL,
} from "../src/lib/wiki-data.ts";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM wiki_topic_cache").run();
});

const gpuFeature = {
  id: 1,
  name: "WebGPU",
  summary:
    "Exposes modern GPU compute and rendering capabilities. See https://gpuweb.github.io/gpuweb/.",
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

test("wiki tagger classifies deterministically and offline", () => {
  equal(tagFeature(gpuFeature).join(","), "webgpu");
  equal(tagFeature(aiFeature).join(","), "web-ai");
  const cross = tagFeature({
    name: "WebGPU AI accelerator",
    summary: "Prompt API on GPU.",
  });
  includes(cross.join(","), "webgpu");
  includes(cross.join(","), "web-ai");
  equal(cross.join(","), [...cross].sort().join(","));
  equal(tagFeature(null).length, 0);
  equal(tagFeature({}).length, 0);
  const slugs = WIKI_TOPICS.map((topic) => topic.slug);
  equal(new Set(slugs).size, slugs.length);
  for (const topic of WIKI_TOPICS) {
    if (topic.queries.length === 0) {
      throw new Error(`${topic.slug} has no queries`);
    }
  }
});

test("wiki grouping, consensus, and timeline helpers", () => {
  const features = [aiFeature, gpuFeature, proposedFeature];

  const groups = stageGroups(features);
  equal(
    groups.map((group) => group.stage).join(","),
    "Enabled by default,Origin trial,Proposed",
  );

  const tally = consensus(features);
  equal(tally.Firefox["Shipped/Shipping"], 1);
  equal(tally.Safari["No signal"], 1);
  equal(tally["Web developers"]["Strongly positive"], 1);

  const entries = timeline(features);
  equal(entries.length, 2);
  equal(entries[0].milestone, 131);
  equal(entries[1].milestone, 113);

  const merged = collectTopicFeatures([
    { features: [gpuFeature, aiFeature] },
    { features: [gpuFeature] },
    null,
    { bogus: true },
  ]);
  equal(merged.length, 2);
  equal(merged[0].id, 2);
});

test("/wiki lists every topic with links and counts", async () => {
  const handler = createHandler({ client: fixtureClient() });
  const res = await handler(new Request("https://chromestatuslite.com/wiki"));
  equal(res.status, 200);
  const html = await res.text();
  includes(html, "Web Platform Topic Wiki");
  includes(html, '<a href="/wiki/webgpu">WebGPU</a>');
  includes(html, '<a href="/wiki/web-ai">Built-in Web AI</a>');
  includes(html, "1 feature</a>");
});

test("/wiki tolerates a topic whose queries all fail", async () => {
  const handler = createHandler({
    client: fixtureClient({
      getFeaturesByQuery: () => Promise.reject(new Error("upstream down")),
    }),
  });
  const res = await handler(new Request("https://chromestatuslite.com/wiki"));
  equal(res.status, 200);
  const html = await res.text();
  includes(html, '<a href="/wiki/webgpu">WebGPU</a>');
});

test("/wiki/:topic groups features by stage with consensus, timeline, and linkified summaries", async () => {
  const handler = createHandler({
    client: fixtureClient({
      getFeaturesByQuery: async (query: string) => {
        if (query === "webgpu") {
          return {
            total_count: 3,
            features: [gpuFeature, gpuFeature, proposedFeature],
          };
        }
        return { total_count: 0, features: [] };
      },
    }),
  });
  const res = await handler(
    new Request("https://chromestatuslite.com/wiki/webgpu"),
  );
  equal(res.status, 200);
  const html = await res.text();
  includes(html, "2 features tagged with this topic");
  includes(html, "Cross-browser consensus");
  includes(html, "Shipped/Shipping (1)");
  includes(html, "Features by stage");
  includes(html, "Enabled by default (1)");
  includes(html, "Proposed (1)");
  includes(html, "Timeline");
  includes(html, '<a href="/?version=113">113</a>');
  includes(html, '<a href="/feature/1">WebGPU</a>');
  includes(
    html,
    '<a href="https://gpuweb.github.io/gpuweb/" rel="noopener noreferrer">https://gpuweb.github.io/gpuweb/</a>.',
  );
});

test("/wiki/:topic renders cross-topic links for multi-tagged features", async () => {
  const handler = createHandler({
    client: fixtureClient({
      getFeaturesByQuery: async () => ({
        total_count: 1,
        features: [
          {
            ...gpuFeature,
            name: "WebGPU on-device AI",
            summary: "GPU acceleration for the Prompt API.",
          },
        ],
      }),
    }),
  });
  const res = await handler(
    new Request("https://chromestatuslite.com/wiki/webgpu"),
  );
  const html = await res.text();
  includes(html, "Also tagged:");
  includes(html, '<a href="/wiki/web-ai">Built-in Web AI</a>');
});

test("/wiki/:topic shows an error notice when every query fails", async () => {
  const handler = createHandler({
    client: fixtureClient({
      getFeaturesByQuery: () => Promise.reject(new Error("upstream down")),
    }),
  });
  const res = await handler(
    new Request("https://chromestatuslite.com/wiki/webgpu"),
  );
  equal(res.status, 200);
  equal(res.headers.get("cache-control"), "no-store");
  includes(await res.text(), "Unable to load topic data from chromestatus.com");
});

test("/wiki/:topic is 404 for unknown slugs without querying upstream", async () => {
  const handler = createHandler({
    client: fixtureClient({
      getFeaturesByQuery: () => {
        throw new Error("unexpected fetch");
      },
    }),
  });
  const res = await handler(
    new Request("https://chromestatuslite.com/wiki/no-such-topic"),
  );
  equal(res.status, 404);
  includes(await res.text(), "Topic not found");

  const match = new URLPattern({ pathname: "/wiki/:topic" }).exec(
    "https://chromestatuslite.com/wiki/no-such-topic",
  )!;
  const direct = await wikiTopic(
    new Request("https://chromestatuslite.com/wiki/no-such-topic"),
    match,
    fixtureClient({
      getFeaturesByQuery: () => {
        throw new Error("unexpected fetch");
      },
    }),
  );
  equal(direct.status, 404);
});

test("/wiki route module renders the directory directly", async () => {
  const res = await wiki(
    new Request("https://chromestatuslite.com/wiki"),
    fixtureClient(),
  );
  equal(res.status, 200);
  includes(await res.text(), "Web Platform Topic Wiki");
});

test("wiki tagger avoids bare-common-word false positives (review chrome-status-lite-asn)", () => {
  equal(
    tagFeature({
      name: "WebGPU: Uniform buffer standard layout",
      summary: "Uniform buffer standard layout for WGSL storage buffers.",
    }).join(","),
    "webgpu",
  );
  equal(
    tagFeature({
      name: "WGSL: unrestricted pointer parameters",
      summary:
        "Pointers to storage/uniform/workgroup address spaces are allowed.",
    }).join(","),
    "webgpu",
  );
  equal(
    tagFeature({
      name: "Canvas2D getConfiguration",
      summary: "Returns the text-direction of a canvas context.",
    }).length,
    0,
  );
  equal(
    tagFeature({
      name: "CSS container queries",
      summary: "Size container queries for elements.",
    }).join(","),
    "css-layout",
  );
  includes(
    tagFeature({
      name: "IndexedDB 3.0",
      summary: "IndexedDB improvements.",
    }).join(","),
    "storage",
  );
  includes(
    tagFeature({
      name: "Richer install UI",
      summary: "App install prompt improvements.",
    }).join(","),
    "pwa",
  );
});

test("fetchQueryFeatures paginates past the 100-result default page (review chrome-status-lite-9am)", async () => {
  const calls: { options: { num?: number; start?: number } }[] = [];
  const client = fixtureClient({
    getFeaturesByQuery: async (
      _query: string,
      options: { num?: number; start?: number } = {},
    ) => {
      calls.push({ options });
      const start = options.start ?? 0;
      return {
        total_count: 250,
        features: Array.from(
          { length: Math.min(100, 250 - start) },
          (_, i) => ({
            id: start + i,
            name: `Feature ${start + i}`,
          }),
        ),
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

test("a synchronously throwing continuation leaks no pool slot (chrome-status-lite-1qp)", async () => {
  const client = fixtureClient({
    getFeaturesByQuery: ((
      _query: string,
      options: { num?: number; start?: number } = {},
    ) => {
      if (options.start !== undefined) {
        throw new Error("sync throw from continuation");
      }
      return Promise.resolve({
        total_count: 300,
        features: Array.from({ length: 100 }, (_, i) => ({
          id: i,
          name: `F${i}`,
        })),
      });
    }) as StatusClient["getFeaturesByQuery"],
  });
  const first = await fetchQueryFeatures("q", client);
  equal(first.complete, false);
  const second = await Promise.race([
    fetchQueryFeatures("q", client),
    new Promise<"HUNG">((resolve) => setTimeout(() => resolve("HUNG"), 1500)),
  ]);
  if (second === "HUNG") {
    throw new Error("pool wedged: second fetchQueryFeatures never settled");
  }
  equal(second.complete, false);
});

test("fetchQueryFeatures reports incomplete when a continuation fails twice (review chrome-status-lite-lmj)", async () => {
  let attempts = 0;
  const client = fixtureClient({
    getFeaturesByQuery: async (
      _query: string,
      options: { num?: number; start?: number } = {},
    ) => {
      const start = options.start ?? 0;
      if (start >= 200) {
        attempts++;
        throw new Error("page lost");
      }
      return {
        total_count: 300,
        features: Array.from({ length: 100 }, (_, i) => ({
          id: start + i,
          name: `F${start + i}`,
        })),
      };
    },
  });
  const result = await fetchQueryFeatures("javascript", client);
  equal(result.features.length, 200);
  equal(result.complete, false);
  equal(attempts, 2);
});

test("/wiki/:topic marks the inventory incomplete when a continuation page fails (review chrome-status-lite-lmj)", async () => {
  const handler = createHandler({
    client: fixtureClient({
      getFeaturesByQuery: async (
        query: string,
        options: { num?: number; start?: number } = {},
      ) => {
        if (query !== "javascript") return { total_count: 0, features: [] };
        const start = options.start ?? 0;
        if (start === 100) throw new Error("503 page 2");
        return {
          total_count: 250,
          features: Array.from(
            { length: start === 200 ? 50 : 100 },
            (_, i) => ({
              id: start + i,
              name: `${query} feature ${start + i}`,
            }),
          ),
        };
      },
    }),
  });
  const res = await handler(
    new Request("https://chromestatuslite.com/wiki/javascript"),
  );
  equal(res.status, 200);
  equal(res.headers.get("cache-control"), "no-store");
  const html = await res.text();
  includes(html, "the list below is incomplete");
  includes(html, "150 features tagged with this topic");
  includes(html, "javascript feature 200");
  if (html.includes("javascript feature 100")) {
    throw new Error("failed page rendered as present");
  }
});

test("/wiki/:topic omits the consensus section when no feature has view data (review chrome-status-lite-098)", async () => {
  const handler = createHandler({
    client: fixtureClient({
      getFeaturesByQuery: async () => ({
        total_count: 1,
        features: [
          { id: 9, name: "Bare feature", summary: "No upstream view data." },
        ],
      }),
    }),
  });
  const res = await handler(
    new Request("https://chromestatuslite.com/wiki/webgpu"),
  );
  equal(res.status, 200);
  const html = await res.text();
  if (html.includes("Cross-browser consensus")) {
    throw new Error("consensus section rendered with zero view data");
  }
});

test("/wiki directory counts the deduped union across ALL topic queries (review chrome-status-lite-4p4)", async () => {
  const client = fixtureClient({
    getFeaturesByQuery: async (query: string) => {
      if (query === "webusb") {
        return {
          total_count: 2,
          features: [{ id: 1, name: "WebUSB" }, { id: 2, name: "WebSerial" }],
        };
      }
      if (query === "web bluetooth") {
        return {
          total_count: 2,
          features: [
            { id: 2, name: "WebSerial" },
            { id: 3, name: "WebBluetooth" },
          ],
        };
      }
      return { total_count: 0, features: [] };
    },
  });
  const handler = createHandler({ client });
  const res = await handler(new Request("https://chromestatuslite.com/wiki"));
  equal(res.status, 200);
  const html = await res.text();
  includes(html, '<a href="/wiki/device">3 features</a>');
});

test("/wiki directory count matches the /wiki/:topic page count (review chrome-status-lite-4p4)", async () => {
  const client = fixtureClient({
    getFeaturesByQuery: async (query: string) => {
      if (query === "webusb") {
        return {
          total_count: 2,
          features: [{ id: 1, name: "WebUSB" }, { id: 2, name: "WebSerial" }],
        };
      }
      if (query === "web bluetooth") {
        return {
          total_count: 2,
          features: [
            { id: 2, name: "WebSerial" },
            { id: 3, name: "WebBluetooth" },
          ],
        };
      }
      return { total_count: 0, features: [] };
    },
  });
  const handler = createHandler({ client });
  const directory = await (await handler(
    new Request("https://chromestatuslite.com/wiki"),
  )).text();
  const topic = await (await handler(
    new Request("https://chromestatuslite.com/wiki/device"),
  )).text();
  includes(directory, '<a href="/wiki/device">3 features</a>');
  includes(topic, "3 features tagged with this topic");
});

test("wiki topic data is cached and shared between directory and topic pages (review chrome-status-lite-4p4)", async () => {
  let calls = 0;
  const handler = createHandler({
    client: fixtureClient({
      getFeaturesByQuery: async () => {
        calls++;
        return {
          total_count: 1,
          features: [{ id: 7, name: "Cached feature" }],
        };
      },
    }),
  });
  await (await handler(new Request("https://chromestatuslite.com/wiki"))).text();
  const afterDirectory = calls;
  if (afterDirectory === 0) {
    throw new Error("cold directory made no upstream calls");
  }
  await (await handler(new Request("https://chromestatuslite.com/wiki"))).text();
  equal(calls, afterDirectory);
  const topic = await (await handler(
    new Request("https://chromestatuslite.com/wiki/webgpu"),
  )).text();
  equal(calls, afterDirectory);
  includes(topic, "1 feature tagged with this topic");
});

test("wiki topic data cache does not pin a total failure (review chrome-status-lite-4p4)", async () => {
  let down = true;
  const handler = createHandler({
    client: fixtureClient({
      getFeaturesByQuery: async () => {
        if (down) throw new Error("upstream down");
        return {
          total_count: 1,
          features: [{ id: 8, name: "Recovered feature" }],
        };
      },
    }),
  });
  const first = await (await handler(
    new Request("https://chromestatuslite.com/wiki"),
  )).text();
  if (first.includes("feature</a>") || first.includes("features</a>")) {
    throw new Error("count rendered while every query failed");
  }
  down = false;
  const second = await (await handler(
    new Request("https://chromestatuslite.com/wiki"),
  )).text();
  includes(second, '<a href="/wiki/webgpu">1 feature</a>');
});

test("/wiki/:topic shows the incomplete notice even when nothing rendered (review chrome-status-lite-lmj)", async () => {
  const handler = createHandler({
    client: fixtureClient({
      getFeaturesByQuery: async (query: string) => {
        if (query === "javascript") throw new Error("503 primary");
        return { total_count: 0, features: [] };
      },
    }),
  });
  const res = await handler(
    new Request("https://chromestatuslite.com/wiki/javascript"),
  );
  equal(res.status, 200);
  const html = await res.text();
  includes(html, "is incomplete");
  if (html.includes("No features are currently tagged")) {
    throw new Error("false empty-topic claim rendered alongside a failed query");
  }
});

test("/wiki/:topic says no features only when every query succeeded empty", async () => {
  const handler = createHandler({
    client: fixtureClient({
      getFeaturesByQuery: async () => ({ total_count: 0, features: [] }),
    }),
  });
  const res = await handler(
    new Request("https://chromestatuslite.com/wiki/webgpu"),
  );
  equal(res.status, 200);
  const html = await res.text();
  includes(html, "No features are currently tagged with this topic.");
  if (html.includes("is incomplete")) {
    throw new Error("false incomplete notice on clean empty result");
  }
});

test("fetchQueryFeatures reports incomplete on a short successful continuation (review chrome-status-lite-lmj round 4)", async () => {
  const client = fixtureClient({
    getFeaturesByQuery: async (
      _query: string,
      options: { num?: number; start?: number } = {},
    ) => {
      const start = options.start ?? 0;
      return {
        total_count: 250,
        features: Array.from(
          { length: start === 100 ? 0 : start === 200 ? 50 : 100 },
          (_, i) => ({
            id: start + i,
            name: `F${start + i}`,
          }),
        ),
      };
    },
  });
  const result = await fetchQueryFeatures("javascript", client);
  equal(result.features.length, 150);
  equal(result.complete, false);
});

test("/wiki/:topic marks the inventory incomplete on a short successful continuation (review chrome-status-lite-lmj round 4)", async () => {
  const handler = createHandler({
    client: fixtureClient({
      getFeaturesByQuery: async (
        query: string,
        options: { num?: number; start?: number } = {},
      ) => {
        const start = options.start ?? 0;
        return {
          total_count: 250,
          features: Array.from(
            { length: start === 100 ? 0 : start === 200 ? 50 : 100 },
            (_, i) => ({
              id: `${query}-${start + i}`,
              name: `${query} feature ${start + i}`,
            }),
          ),
        };
      },
    }),
  });
  const res = await handler(
    new Request("https://chromestatuslite.com/wiki/javascript"),
  );
  equal(res.status, 200);
  const html = await res.text();
  includes(html, "is incomplete");
  includes(html, "javascript feature 200");
  if (html.includes("javascript feature 100")) {
    throw new Error("short page rendered as present");
  }
});

test("fetchQueryFeatures reports incomplete when pages repeat records (review chrome-status-lite-lmj round 5)", async () => {
  const client = fixtureClient({
    getFeaturesByQuery: async (
      _query: string,
      options: { num?: number; start?: number } = {},
    ) => {
      const start = options.start ?? 0;
      const base = start === 100 ? 0 : start;
      return {
        total_count: 250,
        features: Array.from({ length: start === 200 ? 50 : 100 }, (_, i) => ({
          id: `f-${base + i}`,
          name: `Feature ${base + i}`,
        })),
      };
    },
  });
  const result = await fetchQueryFeatures("javascript", client);
  equal(result.features.length, 150);
  equal(result.complete, false);
});

test("/wiki/:topic marks the inventory incomplete when pages repeat records (review chrome-status-lite-lmj round 5)", async () => {
  const handler = createHandler({
    client: fixtureClient({
      getFeaturesByQuery: async (
        query: string,
        options: { num?: number; start?: number } = {},
      ) => {
        const start = options.start ?? 0;
        const base = start === 100 ? 0 : start;
        return {
          total_count: 250,
          features: Array.from(
            { length: start === 200 ? 50 : 100 },
            (_, i) => ({
              id: `${query}-${base + i}`,
              name: `${query} feature ${base + i}`,
            }),
          ),
        };
      },
    }),
  });
  const res = await handler(
    new Request("https://chromestatuslite.com/wiki/javascript"),
  );
  equal(res.status, 200);
  const html = await res.text();
  includes(html, "is incomplete");
  includes(html, "javascript feature 200");
  if (html.includes("javascript feature 100")) {
    throw new Error("duplicate page rendered as distinct records");
  }
});

test("getTopicData unions every query, deduped, with failure flags (review chrome-status-lite-4p4)", async () => {
  const topic = getTopic("device")!;
  const client = fixtureClient({
    getFeaturesByQuery: async (query: string) => {
      if (query === "webusb") {
        return {
          total_count: 2,
          features: [{ id: 1, name: "WebUSB" }, { id: 2, name: "WebSerial" }],
        };
      }
      if (query === "web bluetooth") {
        return {
          total_count: 2,
          features: [
            { id: 2, name: "WebSerial" },
            { id: 3, name: "WebBluetooth" },
          ],
        };
      }
      if (query === "webserial") throw new Error("upstream down");
      return { total_count: 0, features: [] };
    },
  });
  const data = await getTopicData(topic, client);
  equal(data.features.length, 3);
  equal(data.complete, false);
  equal(data.failed, false);
  equal(
    data.features.map((feature) => feature.name).join(","),
    "WebBluetooth,WebSerial,WebUSB",
  );

  const allDown = await getTopicData(
    topic,
    fixtureClient({
      getFeaturesByQuery: () => Promise.reject(new Error("upstream down")),
    }),
  );
  equal(allDown.failed, true);
  equal(allDown.features.length, 0);
});

test("getTopicData re-dates a partial assembly to a short retry TTL (review chrome-status-lite-3mh, revised chrome-status-lite-9nh)", async () => {
  const topic = getTopic("device")!;
  let bluetoothDown = true;
  let calls = 0;
  let t = 0;
  const client = fixtureClient({
    getFeaturesByQuery: async (query: string) => {
      calls++;
      if (query === "webusb") {
        return {
          total_count: 2,
          features: [{ id: 1, name: "WebUSB" }, { id: 2, name: "WebSerial" }],
        };
      }
      if (query === "web bluetooth") {
        if (bluetoothDown) {
          bluetoothDown = false;
          throw new Error("503 transient");
        }
        return {
          total_count: 2,
          features: [
            { id: 2, name: "WebSerial" },
            { id: 3, name: "WebBluetooth" },
          ],
        };
      }
      return { total_count: 0, features: [] };
    },
  });
  const first = await getTopicData(topic, client, () => t);
  equal(first.features.length, 2);
  equal(first.complete, false);
  const callsAfterFirst = calls;
  const withinWindow = await getTopicData(topic, client, () => t);
  equal(withinWindow.features.length, 2);
  equal(withinWindow.complete, false);
  equal(calls, callsAfterFirst);
  t += TOPIC_RETRY_TTL + 1;
  const second = await getTopicData(topic, client, () => t);
  if (calls === callsAfterFirst) {
    throw new Error("retry window outlived the TTL");
  }
  equal(second.features.length, 3);
  equal(second.complete, true);
  t += TOPIC_RETRY_TTL + 1;
  const third = await getTopicData(topic, client, () => t);
  equal(third.complete, true);
  equal(calls, callsAfterFirst + 4);
});

test("fetchQueryFeatures treats a 200 with no total_count as incomplete (review chrome-status-lite-i11)", async () => {
  const client = fixtureClient({
    getFeaturesByQuery: async () => ({}),
  });
  const result = await fetchQueryFeatures("webgpu", client);
  equal(result.complete, false);
  equal(result.features.length, 0);

  let empty = true;
  let t = 0;
  const recovering = fixtureClient({
    getFeaturesByQuery: async () => {
      if (empty) {
        empty = false;
        return {};
      }
      return { total_count: 1, features: [{ id: 5, name: "Back" }] };
    },
  });
  const topic = getTopic("webgpu")!;
  const first = await getTopicData(topic, recovering, () => t);
  equal(first.complete, false);
  const withinWindow = await getTopicData(topic, recovering, () => t);
  equal(withinWindow.complete, false);
  t += TOPIC_RETRY_TTL + 1;
  const second = await getTopicData(topic, recovering, () => t);
  equal(second.complete, true);
  equal(second.features.length, 1);
});

test("/wiki marks a partial directory count as a lower bound (review chrome-status-lite-un2)", async () => {
  const handler = createHandler({
    client: fixtureClient({
      getFeaturesByQuery: async (query: string) => {
        if (query === "webusb") {
          return {
            total_count: 2,
            features: [{ id: 1, name: "WebUSB" }, { id: 2, name: "WebSerial" }],
          };
        }
        if (query === "web bluetooth") throw new Error("503 persistent");
        return { total_count: 0, features: [] };
      },
    }),
  });
  const res = await handler(new Request("https://chromestatuslite.com/wiki"));
  equal(res.status, 200);
  const html = await res.text();
  includes(html, '<a href="/wiki/device">2+ features</a>');
  if (html.includes('<a href="/wiki/device">2 features</a>')) {
    throw new Error("partial count rendered as exact");
  }
  const clean = await (await createHandler({ client: fixtureClient() })(
    new Request("https://chromestatuslite.com/wiki"),
  )).text();
  includes(clean, "1 feature</a>");
});

test("fetchQueryFeatures treats a null total_count as incomplete (review chrome-status-lite-bzs)", async () => {
  const client = fixtureClient({
    getFeaturesByQuery: async () => ({ total_count: null, features: [] }),
  });
  const result = await fetchQueryFeatures("webgpu", client);
  equal(result.complete, false);

  let calls = 0;
  let t = 0;
  const recovering = fixtureClient({
    getFeaturesByQuery: async () =>
      ++calls === 1
        ? { total_count: null, features: [] }
        : { total_count: 1, features: [{ id: 9, name: "Recovered" }] },
  });
  const topic = getTopic("webgpu")!;
  const first = await getTopicData(topic, recovering, () => t);
  equal(first.complete, false);
  const withinWindow = await getTopicData(topic, recovering, () => t);
  equal(withinWindow.complete, false);
  equal(calls, 1);
  t += TOPIC_RETRY_TTL + 1;
  const second = await getTopicData(topic, recovering, () => t);
  equal(second.complete, true);
  equal(second.features.length, 1);
  const numeric = fixtureClient({
    getFeaturesByQuery: async () => ({
      total_count: "1",
      features: [{ id: 9, name: "Stringy" }],
    }),
  });
  equal((await fetchQueryFeatures("webgpu", numeric)).complete, true);
});

test("getTopic resolves slugs", () => {
  equal(getTopic("webgpu")?.title, "WebGPU");
  equal(getTopic("nope"), undefined);
});

test("fetchQueryFeatures bounds continuation concurrency with a pool shared across queries (chrome-status-lite-9nh)", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let continuationCalls = 0;
  const client = fixtureClient({
    getFeaturesByQuery: async (
      query: string,
      options: { num?: number; start?: number } = {},
    ) => {
      const start = options.start ?? 0;
      if (options.start !== undefined) {
        continuationCalls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (options.start !== undefined) inFlight--;
      return {
        total_count: 300,
        features: Array.from({ length: 100 }, (_, i) => ({
          id: `${query}-${start + i}`,
          name: `F${start + i}`,
        })),
      };
    },
  });
  const results = await Promise.all([
    fetchQueryFeatures("a", client),
    fetchQueryFeatures("b", client),
    fetchQueryFeatures("c", client),
  ]);
  for (const result of results) {
    equal(result.features.length, 300);
    equal(result.complete, true);
  }
  equal(continuationCalls, 6);
  if (maxInFlight > CONTINUATION_POOL_SIZE) {
    throw new Error(
      `unbounded fan-out: ${maxInFlight} continuation pages in flight`,
    );
  }
  if (maxInFlight < 2) {
    throw new Error("pool serialized the continuation pages");
  }
});

test("cold /wiki with a capped topic pins the upstream call count (chrome-status-lite-9nh)", async () => {
  let calls = 0;
  const handler = createHandler({
    client: fixtureClient({
      getFeaturesByQuery: async (
        query: string,
        options: { num?: number; start?: number } = {},
      ) => {
        calls++;
        if (query === "webgpu") {
          const start = options.start ?? 0;
          return {
            total_count: 1200,
            features: Array.from({ length: 100 }, (_, i) => ({
              id: `gpu-${start + i}`,
              name: `GPU feature ${start + i}`,
            })),
          };
        }
        return { total_count: 0, features: [] };
      },
    }),
  });
  const html = await (await handler(
    new Request("https://chromestatuslite.com/wiki"),
  )).text();
  const totalQueries = WIKI_TOPICS.reduce(
    (n, topic) => n + topic.queries.length,
    0,
  );
  equal(calls, totalQueries - 1 + 10);
  includes(html, '<a href="/wiki/webgpu">1000+ features</a>');
});

test("two consecutive /wiki renders after a failed continuation share one retry window (chrome-status-lite-9nh)", async () => {
  let calls = 0;
  const handler = createHandler({
    client: fixtureClient({
      getFeaturesByQuery: async (
        query: string,
        options: { num?: number; start?: number } = {},
      ) => {
        calls++;
        if (query !== "javascript") return { total_count: 0, features: [] };
        const start = options.start ?? 0;
        if (start === 100) throw new Error("503 page 2");
        return {
          total_count: 250,
          features: Array.from(
            { length: start === 200 ? 50 : 100 },
            (_, i) => ({
              id: `js-${start + i}`,
              name: `JS feature ${start + i}`,
            }),
          ),
        };
      },
    }),
  });
  const first = await (await handler(
    new Request("https://chromestatuslite.com/wiki"),
  )).text();
  const afterFirst = calls;
  includes(first, '<a href="/wiki/javascript">150+ features</a>');
  const second = await (await handler(
    new Request("https://chromestatuslite.com/wiki"),
  )).text();
  equal(calls, afterFirst);
  includes(second, '<a href="/wiki/javascript">150+ features</a>');
});

test("D1WikiTopicStore + refreshStaleWikiTopics pre-warm topics in bounded batches and serve /wiki with zero upstream calls", async () => {
  const wikiStore = new D1WikiTopicStore(env.DB);
  let t = Date.now() - 10_000;
  const seedClient = fixtureClient({
    getFeaturesByQuery: async (query: string) => ({
      total_count: 1,
      features: [{ ...gpuFeature, id: query, name: `Feature for ${query}` }],
    }),
  });

  // Refresh in batches of 3 (stays well within Free plan 50 subrequest limit).
  const firstBatch = await refreshStaleWikiTopics(seedClient, wikiStore, {
    batchSize: 3,
    now: () => (t += 100),
  });
  equal(firstBatch.refreshed.length, 3);
  equal(firstBatch.failed.length, 0);

  // Refresh the remaining topics across subsequent ticks.
  for (let tick = 0; tick < 4; tick++) {
    await refreshStaleWikiTopics(seedClient, wikiStore, {
      batchSize: 3,
      now: () => (t += 100),
    });
  }
  const allStored = await wikiStore.getAll();
  equal(allStored.size, WIKI_TOPICS.length);

  // Now /wiki and /wiki/webgpu must serve entirely from D1 with ZERO upstream calls!
  let upstreamCalls = 0;
  const handler = createHandler({
    client: fixtureClient({
      getFeaturesByQuery: async () => {
        upstreamCalls++;
        throw new Error("must not call upstream when D1 cache is warm");
      },
    }),
    wikiStore,
  });

  const dirHtml = await (await handler(
    new Request("https://chromestatuslite.com/wiki"),
  )).text();
  includes(dirHtml, '<a href="/wiki/webgpu">1 feature</a>');
  const topicHtml = await (await handler(
    new Request("https://chromestatuslite.com/wiki/webgpu"),
  )).text();
  includes(topicHtml, "Feature for webgpu");
  equal(upstreamCalls, 0);
});

test("cold /wiki with an empty D1 store bounds fallback upstream fetches instead of fanning out across all 15 topics", async () => {
  const wikiStore = new D1WikiTopicStore(env.DB);
  let upstreamCalls = 0;
  const handler = createHandler({
    client: fixtureClient({
      getFeaturesByQuery: async () => {
        upstreamCalls++;
        return { total_count: 1, features: [gpuFeature] };
      },
    }),
    wikiStore,
  });

  const res = await handler(new Request("https://chromestatuslite.com/wiki"));
  equal(res.status, 200);
  const html = await res.text();
  includes(html, '<a href="/wiki/webgpu">1 feature</a>');
  // Only the first 2 cold topics fall back on demand (webgpu=1 query, css-anchor-positioning=1 query -> 2 calls),
  // staying strictly below Cloudflare Free tier's 50 subrequests limit.
  equal(upstreamCalls <= 4, true);
});
