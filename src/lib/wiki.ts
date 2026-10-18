// Topic Wiki tagging pipeline. Pure and deterministic: the same feature data
// always produces the same tags, and nothing in this module touches the
// network, the clock, or the file system, so tests can run fully offline.
//
// A topic declares `queries` (upstream chromestatus text searches that seed
// the topic's feature list) and `keywords` (lowercase fragments matched
// against a feature's name, summary, search tags, blink components and spec
// link). Re-running the pipeline is just re-fetching the queries and
// re-applying tagFeature; there is no mutable state to drift.

export interface WikiTopic {
  slug: string;
  title: string;
  description: string;
  queries: string[];
  keywords: string[];
}

export const WIKI_TOPICS: WikiTopic[] = [
  {
    slug: "webgpu",
    title: "WebGPU",
    description:
      "GPU compute and rendering on the web: the WebGPU API, WGSL shading language, and related graphics capabilities.",
    queries: ["webgpu"],
    keywords: ["webgpu", "wgsl"],
  },
  {
    slug: "css-anchor-positioning",
    title: "CSS Anchor Positioning",
    description:
      "Tethering elements to an anchor: position-area, anchor(), anchor-name, and position-try for tooltips, popovers, and menus.",
    queries: ["anchor positioning"],
    keywords: ["anchor position", "anchor-position", "anchor-name", "anchor(", "position-try", "position-area"],
  },
  {
    slug: "web-ai",
    title: "Built-in Web AI",
    description:
      "On-device and built-in AI APIs: the Prompt API, Summarizer, Writer/Rewriter, Translator, and Language Detector.",
    queries: ["built-in AI", "prompt API"],
    keywords: [
      "prompt api", "summarizer", "writer api", "rewriter", "translator api", "language detector",
      "language model", "built-in ai", "on-device ai", "gemini nano", "proofreader",
    ],
  },
  {
    slug: "storage",
    title: "Storage & Files",
    description:
      "Persistent data on the web: IndexedDB, Cache Storage, the File System Access API, storage buckets, and quota management.",
    queries: ["storage", "file system access"],
    keywords: ["indexeddb", "cache storage", "web storage", "local storage", "session storage",
      "storage api", "storage quota", "storage bucket", "file system", "origin private file system"],
  },
  {
    slug: "privacy",
    title: "Privacy & Identity",
    description:
      "Privacy-preserving platform changes: third-party cookie phase-out, FedCM, Topics, Attribution Reporting, and fenced frames.",
    queries: ["privacy", "FedCM"],
    keywords: [
      "privacy", "cookie", "fedcm", "topics api", "attribution", "fenced frame", "third-party",
      "tracking", "identity",
    ],
  },
  {
    slug: "media",
    title: "Media & Real-time Communication",
    description:
      "Audio, video, and real-time communication: WebCodecs, WebRTC, MediaRecorder, codecs, and capture APIs.",
    queries: ["media", "webrtc"],
    keywords: ["webrtc", "media", "codec", "webcodecs", "audio", "video", "capture", "mediarecorder"],
  },
  {
    slug: "pwa",
    title: "Progressive Web Apps",
    description:
      "Installable apps: web app manifests, installation prompts, service workers, shortcuts, and window controls.",
    queries: ["pwa", "web app manifest"],
    keywords: ["pwa", "web app", "manifest", "service worker", "app install", "install prompt", "beforeinstallprompt", "app badge", "window controls overlay", "shortcuts"],
  },
  {
    slug: "security",
    title: "Security & Authentication",
    description:
      "Web security surface: permissions, WebAuthn and passkeys, the Credential Management API, and the Sanitizer API.",
    queries: ["security", "webauthn"],
    keywords: ["security", "permission", "credential", "webauthn", "passkey", "sanitizer", "csp", "authentication"],
  },
  {
    slug: "webassembly",
    title: "WebAssembly",
    description:
      "WebAssembly language features: Wasm GC, threads, SIMD, tail calls, and JS/Wasm interoperability.",
    queries: ["webassembly", "wasm"],
    keywords: ["webassembly", "wasm"],
  },
  {
    slug: "fonts",
    title: "Fonts & Text",
    description:
      "Typography on the web: font loading, variable fonts, text shaping, line breaking, and font metric controls.",
    queries: ["font", "text shaping"],
    keywords: ["font", "typograph", "text shaping", "line break", "hyphen"],
  },
  {
    slug: "payments",
    title: "Payments",
    description:
      "Checkout on the web: the Payment Request and Payment Handler APIs and secure payment confirmation.",
    queries: ["payment"],
    keywords: ["payment"],
  },
  {
    slug: "device",
    title: "Device & Hardware",
    description:
      "Hardware access from the browser: WebUSB, Web Bluetooth, WebSerial, WebHID, WebNFC, and sensor APIs.",
    queries: ["webusb", "web bluetooth", "webserial", "webhid"],
    keywords: ["usb", "bluetooth", "serial", "webhid", "hid device", "nfc", "sensor", "gamepad", "human interface"],
  },
  {
    slug: "css-layout",
    title: "CSS Layout",
    description:
      "Modern layout primitives: container queries, grid and subgrid, flexbox, masonry, and style queries.",
    queries: ["css layout", "container queries"],
    keywords: ["container quer", "subgrid", "masonry", "flexbox", "css grid", "grid layout", "style queries", "css layout"],
  },
  {
    slug: "javascript",
    title: "JavaScript Language",
    description:
      "ECMAScript language features landing in V8: new syntax, standard library additions, and RegExp improvements.",
    queries: ["javascript", "ecmascript"],
    keywords: ["javascript", "ecmascript", "v8", "regexp", "iterator"],
  },
  {
    slug: "performance",
    title: "Performance & Scheduling",
    description:
      "Keeping the main thread responsive: scheduling APIs, workers, resource loading, and performance measurement.",
    queries: ["performance", "scheduling"],
    keywords: [
      "performance", "schedul", "worker", "offload", "lazy", "preloading", "speculation", "timing",
    ],
  },
];

export function getTopic(slug: string): WikiTopic | undefined {
  return WIKI_TOPICS.find((topic) => topic.slug === slug);
}

// The haystack a keyword is matched against: everything that describes what
// a feature is. Deterministic and case-insensitive.
function featureText(feature: any): string {
  const parts = [
    feature?.name,
    feature?.summary,
    feature?.motivation,
    feature?.spec_link,
    feature?.standards?.spec,
  ];
  const tags = Array.isArray(feature?.search_tags) ? feature.search_tags : [];
  const components = Array.isArray(feature?.blink_components)
    ? feature.blink_components
    : feature?.browsers?.chrome?.blink_components ?? [];
  return [...parts, ...tags, ...components]
    .filter((part) => typeof part === "string")
    .join("\n")
    .toLowerCase();
}

// Returns the slugs of every topic whose keywords match the feature, sorted
// for stable output. A feature can legitimately belong to several topics.
export function tagFeature(feature: any, topics: WikiTopic[] = WIKI_TOPICS): string[] {
  if (!feature || typeof feature !== "object") return [];
  const text = featureText(feature);
  if (!text) return [];
  return topics
    .filter((topic) => topic.keywords.some((keyword) => text.includes(keyword)))
    .map((topic) => topic.slug)
    .sort();
}

// Merges the per-query search results for a topic into one list, deduped by
// feature id and ordered by name for a stable render.
export function collectTopicFeatures(results: any[]): any[] {
  const byId = new Map<string, any>();
  for (const result of results) {
    const features = Array.isArray(result?.features) ? result.features : [];
    for (const feature of features) {
      if (!feature || typeof feature !== "object" || feature.id === undefined) continue;
      const key = String(feature.id);
      if (!byId.has(key)) byId.set(key, feature);
    }
  }
  return [...byId.values()].sort((a, b) =>
    String(a?.name || "").localeCompare(String(b?.name || ""))
  );
}

// Canonical stage order for the wiki. Unknown statuses sort after the known
// ones, alphabetically, so a new upstream label never breaks grouping.
const STAGE_ORDER = [
  "Enabled by default",
  "Origin trial",
  "In developer trial (Behind a flag)",
  "In development",
  "Proposed",
  "On hold",
  "Deprecated",
  "Removed",
  "No longer pursuing",
];

export function stageGroups(features: any[]): { stage: string; features: any[] }[] {
  const groups = new Map<string, any[]>();
  for (const feature of features) {
    const stage = String(feature?.browsers?.chrome?.status?.text || "Unknown");
    const list = groups.get(stage) || [];
    list.push(feature);
    groups.set(stage, list);
  }
  const order = (stage: string) => {
    const index = STAGE_ORDER.indexOf(stage);
    return index === -1 ? STAGE_ORDER.length : index;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([stage, groupFeatures]) => ({ stage, features: groupFeatures }));
}

// Cross-browser consensus: counts of each browser's standards position,
// derived from browsers.ff/safari/webdev view text.
export function consensus(features: any[]): Record<string, Record<string, number>> {
  const tally: Record<string, Record<string, number>> = {
    Firefox: {},
    Safari: {},
    "Web developers": {},
  };
  const keys: Record<string, string> = {
    Firefox: "ff",
    Safari: "safari",
    "Web developers": "webdev",
  };
  for (const feature of features) {
    for (const [label, key] of Object.entries(keys)) {
      const text = feature?.browsers?.[key]?.view?.text;
      if (typeof text !== "string" || text.length === 0) continue;
      tally[label][text] = (tally[label][text] || 0) + 1;
    }
  }
  return tally;
}

// Timeline entries: features whose chrome status carries a numeric milestone,
// newest first. milestone_str is sometimes a label like "Proposed", which is
// not a timeline entry.
export function timeline(features: any[]): { milestone: number; feature: any }[] {
  const entries: { milestone: number; feature: any }[] = [];
  for (const feature of features) {
    const raw = feature?.browsers?.chrome?.status?.milestone_str;
    const milestone = Number.parseInt(String(raw ?? ""), 10);
    if (Number.isFinite(milestone)) entries.push({ milestone, feature });
  }
  return entries.sort((a, b) => b.milestone - a.milestone);
}
