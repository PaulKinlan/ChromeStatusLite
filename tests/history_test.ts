import { env } from "cloudflare:test";
import { beforeEach, test } from "vitest";
import { createHandler } from "../src/handler.ts";
import { equal, fixtureClient, includes } from "./fixture.ts";
import {
  captureSnapshot,
  D1SnapshotStore,
  diffSnapshots,
  MemorySnapshotStore,
  type SnapshotStore,
} from "../src/lib/snapshots.ts";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM feature_snapshots"),
    env.DB.prepare("DELETE FROM feature_index"),
  ]);
});

test("viewing a feature captures a snapshot and dedupes unchanged views", async () => {
  const store = new MemorySnapshotStore();
  let feature: any = {
    id: 123,
    name: "Snapshotted",
    summary: "v1",
    resources: { docs: [], samples: [] },
  };
  const handler = createHandler({
    client: fixtureClient({ getFeature: async () => feature }),
    store,
  });

  await handler(new Request("https://chromestatuslite.com/feature/123"));
  equal((await store.list("123")).length, 1);

  await handler(new Request("https://chromestatuslite.com/feature/123"));
  equal((await store.list("123")).length, 1);

  feature = { ...feature, summary: "v2" };
  await handler(new Request("https://chromestatuslite.com/feature/123"));
  equal((await store.list("123")).length, 2);
});

test("history and diff bound overlong feature ids at the seam (chrome-status-lite-s9w)", async () => {
  const store = new MemorySnapshotStore();
  const handler = createHandler({ client: fixtureClient(), store });
  const overlong = "5".repeat(17);
  equal(
    (await handler(
      new Request(`https://chromestatuslite.com/feature/${overlong}/history`),
    )).status,
    404,
  );
  equal(
    (await handler(
      new Request(`https://chromestatuslite.com/feature/${overlong}/diff`),
    )).status,
    404,
  );
  equal((await store.list(overlong)).length, 0);
});

test("HEAD on history and diff never touches the recency marker (chrome-status-lite-2cf)", async () => {
  const touched: string[] = [];
  const store: SnapshotStore = {
    list: async () => [],
    add: async () => true,
    touch: async (id: string) => {
      touched.push(id);
    },
  };
  const handler = createHandler({ client: fixtureClient(), store });

  await handler(
    new Request("https://chromestatuslite.com/feature/123/history", {
      method: "HEAD",
    }),
  );
  await handler(
    new Request("https://chromestatuslite.com/feature/123/diff", {
      method: "HEAD",
    }),
  );
  equal(touched.length, 0);

  await handler(
    new Request("https://chromestatuslite.com/feature/123/history"),
  );
  equal(touched.length, 1);
  await handler(new Request("https://chromestatuslite.com/feature/123/diff"));
  equal(touched.length, 2);
});

test("history lists snapshots newest-first with changed fields", async () => {
  const store = new MemorySnapshotStore();
  await captureSnapshot(
    store,
    "77",
    { name: "Diffed", summary: "old summary", intent_stage: "Draft" },
    new Date("2026-01-01T00:00:00Z"),
  );
  await captureSnapshot(
    store,
    "77",
    { name: "Diffed", summary: "new summary", intent_stage: "Draft" },
    new Date("2026-02-01T00:00:00Z"),
  );
  const handler = createHandler({ client: fixtureClient(), store });

  const res = await handler(
    new Request("https://chromestatuslite.com/feature/77/history"),
  );
  equal(res.status, 200);
  const text = await res.text();
  includes(text, "Diffed: history");
  includes(text, "changed: Summary");
  equal(text.includes("changed: Intent stage Summary"), false);
  equal(text.includes("diff-del"), false);
});

test("diff renders a visual field-level code diff between snapshots", async () => {
  const store = new MemorySnapshotStore();
  await captureSnapshot(
    store,
    "77",
    { name: "Diffed", summary: "old summary", intent_stage: "Draft" },
    new Date("2026-01-01T00:00:00Z"),
  );
  await captureSnapshot(
    store,
    "77",
    { name: "Diffed", summary: "new summary", intent_stage: "Draft" },
    new Date("2026-02-01T00:00:00Z"),
  );
  await captureSnapshot(
    store,
    "77",
    {
      name: "Diffed",
      summary: "new summary",
      intent_stage: "Draft",
      spec_link: "https://example.com/spec",
    },
    new Date("2026-03-01T00:00:00Z"),
  );
  const handler = createHandler({ client: fixtureClient(), store });

  const res = await handler(
    new Request("https://chromestatuslite.com/feature/77/diff"),
  );
  equal(res.status, 200);
  const text = await res.text();
  includes(text, "Diffed: diff");
  includes(text, "diff-del");
  includes(text, "diff-add");
  includes(text, "old summary");
  includes(text, "new summary");
  equal((text.match(/diff-add/g) || []).length >= 2, true);

  const resAdded = await handler(
    new Request(
      "https://chromestatuslite.com/feature/77/diff?from=2026-02-01T00:00:00.000Z&to=2026-03-01T00:00:00.000Z",
    ),
  );
  const addedText = await resAdded.text();
  includes(addedText, "Specification");
  includes(addedText, "https://example.com/spec");
});

test("the feature page links to its history only when a store is configured", async () => {
  const withStore = createHandler({
    client: fixtureClient(),
    store: new MemorySnapshotStore(),
  });
  const linked = await (await withStore(
    new Request("https://chromestatuslite.com/feature/123"),
  )).text();
  includes(linked, 'href="/feature/123/history"');

  const storeless = await (await createHandler({ client: fixtureClient() })(
    new Request("https://chromestatuslite.com/feature/123"),
  )).text();
  equal(storeless.includes("/history"), false);
});

test("history and diff pages render a self-referential canonical link", async () => {
  const store = new MemorySnapshotStore();
  await captureSnapshot(
    store,
    "88",
    { name: "Canonical", summary: "v1" },
    new Date("2026-01-01T00:00:00Z"),
  );
  await captureSnapshot(
    store,
    "88",
    { name: "Canonical", summary: "v2" },
    new Date("2026-02-01T00:00:00Z"),
  );
  const handler = createHandler({ client: fixtureClient(), store });

  const history = await (await handler(
    new Request("https://chromestatuslite.com/feature/88/history"),
  )).text();
  includes(
    history,
    '<link rel="canonical" href="https://chromestatuslite.com/feature/88/history">',
  );

  const diff = await (await handler(
    new Request(
      "https://chromestatuslite.com/feature/88/diff?from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z",
    ),
  )).text();
  includes(
    diff,
    '<link rel="canonical" href="https://chromestatuslite.com/feature/88/diff?from=2026-01-01T00:00:00.000Z&amp;to=2026-02-01T00:00:00.000Z">',
  );
});

test("without a store the history and diff routes say so instead of failing", async () => {
  const handler = createHandler({ client: fixtureClient() });
  for (const path of ["/feature/123/history", "/feature/123/diff"]) {
    const res = await handler(
      new Request(`https://chromestatuslite.com${path}`),
    );
    equal(res.status, 200);
    equal(res.headers.get("cache-control"), "no-store");
    includes(await res.text(), "not configured");
  }
});

test("diffSnapshots classifies added, removed and changed fields", () => {
  const diffs = diffSnapshots(
    { at: "a", data: { Name: "x", Gone: "old", Field: "before" } },
    { at: "b", data: { Name: "x", Field: "after", New: "fresh" } },
  );
  equal(diffs.length, 3);
  includes(JSON.stringify(diffs), '"kind":"added"');
  includes(JSON.stringify(diffs), '"kind":"removed"');
  includes(JSON.stringify(diffs), '"kind":"changed"');
});

test("a broken store renders unavailable, not an empty history", async () => {
  const broken: SnapshotStore = {
    list: async () => {
      throw new Error("D1 unavailable");
    },
    add: async () => {
      throw new Error("D1 unavailable");
    },
  };
  const handler = createHandler({ client: fixtureClient(), store: broken });

  const res = await handler(
    new Request("https://chromestatuslite.com/feature/9/history"),
  );
  equal(res.status, 200);
  equal(res.headers.get("cache-control"), "no-store");
  const text = await res.text();
  includes(text, "temporarily unavailable");
  equal(text.includes("No snapshots captured yet"), false);
});

test("a reversed from/to pair is normalised to older-then-newer", async () => {
  const store = new MemorySnapshotStore();
  await captureSnapshot(
    store,
    "77",
    { name: "D", summary: "OLD" },
    new Date("2026-01-01T00:00:00Z"),
  );
  await captureSnapshot(
    store,
    "77",
    { name: "D", summary: "NEW" },
    new Date("2026-02-01T00:00:00Z"),
  );
  const handler = createHandler({ client: fixtureClient(), store });

  const res = await handler(
    new Request(
      "https://chromestatuslite.com/feature/77/diff?from=2026-02-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z",
    ),
  );
  const text = await res.text();
  const delIndex = text.indexOf("diff-del");
  const addIndex = text.indexOf("diff-add");
  includes(text, "2026-01-01");
  equal(delIndex < addIndex && delIndex !== -1, true);
  const afterDel = text.slice(delIndex, addIndex);
  includes(afterDel, "OLD");
});

test("an unresolvable from/to param says so and falls back to the full range", async () => {
  const store = new MemorySnapshotStore();
  await captureSnapshot(
    store,
    "77",
    { name: "D", summary: "A" },
    new Date("2026-01-01T00:00:00Z"),
  );
  await captureSnapshot(
    store,
    "77",
    { name: "D", summary: "B" },
    new Date("2026-02-01T00:00:00Z"),
  );
  const handler = createHandler({ client: fixtureClient(), store });

  const res = await handler(
    new Request(
      "https://chromestatuslite.com/feature/77/diff?from=1999-01-01T00:00:00.000Z",
    ),
  );
  includes(await res.text(), "was not found");
});

test("captureSnapshot prefers latest() and falls back to list()", async () => {
  let latestCalls = 0;
  let listCalls = 0;
  const inner = new MemorySnapshotStore();
  const withLatest: SnapshotStore = {
    list: async (id: string) => {
      listCalls++;
      return inner.list(id);
    },
    add: (id: string, snap) => inner.add(id, snap),
    latest: async (id: string) => {
      latestCalls++;
      return (await inner.list(id))[0];
    },
  };
  await captureSnapshot(withLatest, "5", { name: "N", summary: "x" });
  equal(latestCalls, 1);
  equal(listCalls, 0);

  const bare: SnapshotStore = {
    list: async (id: string) => {
      listCalls++;
      return inner.list(id);
    },
    add: (id: string, snap) => inner.add(id, snap),
  };
  await captureSnapshot(bare, "6", { name: "N", summary: "x" });
  equal(listCalls, 1);
});

test("D1SnapshotStore on real Miniflare D1: latest() is newest, unchanged views store nothing", async () => {
  const store = new D1SnapshotStore(env.DB);
  await store.add("d1a", {
    at: "2026-01-01T00:00:00.000Z",
    data: { Name: "X", Summary: "v1" },
  });
  await store.add("d1a", {
    at: "2026-02-01T00:00:00.000Z",
    data: { Name: "X", Summary: "v2" },
  });

  equal((await store.latest("d1a"))!.at, "2026-02-01T00:00:00.000Z");
  const listed = await store.list("d1a");
  equal(listed.length, 2);
  equal(listed[0].at, "2026-02-01T00:00:00.000Z");

  equal(
    await captureSnapshot(store, "d1a", { name: "X", summary: "v2" }),
    false,
  );
  equal((await store.list("d1a")).length, 2);
  equal(
    await captureSnapshot(store, "d1a", { name: "X", summary: "v3" }),
    true,
  );
  equal((await store.latest("d1a"))!.data["Summary"], "v3");
});

test("D1SnapshotStore keeps only the newest snapshots per feature, even on backdated adds", async () => {
  const store = new D1SnapshotStore(env.DB, { maxSnapshotsPerFeature: 3 });
  await store.add("ord", {
    at: "2026-03-01T00:00:00.000Z",
    data: { Summary: "new" },
  });
  await store.add("ord", {
    at: "2026-01-01T00:00:00.000Z",
    data: { Summary: "oldest" },
  });
  await store.add("ord", {
    at: "2026-02-01T00:00:00.000Z",
    data: { Summary: "mid" },
  });
  await store.add("ord", {
    at: "2026-02-15T00:00:00.000Z",
    data: { Summary: "mid2" },
  });

  const listed = await store.list("ord");
  equal(listed.length, 3);
  equal(listed[0].at, "2026-03-01T00:00:00.000Z");
  equal(listed[1].at, "2026-02-15T00:00:00.000Z");
  equal(listed[2].at, "2026-02-01T00:00:00.000Z");
  // Backdated add must not overwrite latest_at.
  equal((await store.latest("ord"))!.at, "2026-03-01T00:00:00.000Z");
});

test("D1SnapshotStore evicts least-recently-used feature with structured warning and zero orphan rows", async () => {
  const warnings: string[] = [];
  const store = new D1SnapshotStore(env.DB, {
    maxTrackedFeatures: 2,
    warn: (msg) => warnings.push(msg),
  });

  await store.add("f1", {
    at: "2026-01-01T00:00:00.000Z",
    data: { Summary: "a" },
  });
  await store.add("f2", {
    at: "2026-01-02T00:00:00.000Z",
    data: { Summary: "b" },
  });
  await store.add("f3", {
    at: "2026-01-03T00:00:00.000Z",
    data: { Summary: "c" },
  });

  equal((await store.list("f1")).length, 0);
  equal((await store.list("f2")).length, 1);
  equal((await store.list("f3")).length, 1);
  equal(warnings.length, 1);
  const event = JSON.parse(warnings[0]);
  equal(event.event, "snapshot_feature_evicted");
  equal(event.reason, "tracked_feature_cap");
  equal(event.evictedFeatureId, "f1");
  equal(event.maxTrackedFeatures, 2);

  // Verify no orphaned snapshot rows exist outside feature_index.
  const orphans = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM feature_snapshots
     WHERE feature_id NOT IN (SELECT feature_id FROM feature_index)`,
  ).first<{ count: number }>();
  equal(Number(orphans?.count ?? -1), 0);
});

test("D1SnapshotStore touch() refreshes eviction recency past the 24h throttle window", async () => {
  const store = new D1SnapshotStore(env.DB, {
    maxTrackedFeatures: 2,
    warn: () => {},
  });
  await store.add("t1", {
    at: "2026-01-01T00:00:00.000Z",
    data: { Summary: "a" },
  });
  await store.add("t2", {
    at: "2026-01-02T00:00:00.000Z",
    data: { Summary: "b" },
  });
  // Inside 24h throttle: t1 stays oldest and is evicted by t3.
  await store.touch("t1", new Date("2026-01-01T06:00:00.000Z"));
  await store.add("t3", {
    at: "2026-01-03T00:00:00.000Z",
    data: { Summary: "c" },
  });
  equal((await store.list("t1")).length, 0);
  equal((await store.list("t2")).length, 1);

  // Past 24h window: touch refreshes t2, so t3 is evicted next.
  await store.touch("t2", new Date("2026-01-04T00:00:00.000Z"));
  await store.add("t4", {
    at: "2026-01-05T00:00:00.000Z",
    data: { Summary: "d" },
  });
  equal((await store.list("t2")).length, 1);
  equal((await store.list("t3")).length, 0);
  equal((await store.list("t4")).length, 1);
});

test("D1SnapshotStore holds the tracked-feature cap under concurrent first-captures with zero orphans", async () => {
  const store = new D1SnapshotStore(env.DB, {
    maxTrackedFeatures: 3,
    warn: () => {},
  });
  for (let burst = 0; burst < 4; burst++) {
    const batch = [];
    for (let i = 0; i < 5; i++) {
      const id = `c${burst}x${i}`;
      batch.push(
        store.add(id, {
          at: `2026-04-0${burst + 1}T0${i}:00:00.000Z`,
          data: { Summary: `s${burst}-${i}` },
        }),
      );
    }
    await Promise.all(batch);
    const indexCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM feature_index",
    ).first<{ count: number }>();
    equal(Number(indexCount?.count) <= 3, true);

    const orphans = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM feature_snapshots
       WHERE feature_id NOT IN (SELECT feature_id FROM feature_index)`,
    ).first<{ count: number }>();
    equal(Number(orphans?.count), 0);
  }
});

test("captureSnapshot refreshes recency on deduped views, protecting hot stable features", async () => {
  const store = new MemorySnapshotStore({ maxTrackedFeatures: 2 });
  await captureSnapshot(
    store,
    "h1",
    { name: "A", summary: "v1" },
    new Date("2026-01-01T00:00:00Z"),
  );
  await captureSnapshot(
    store,
    "h2",
    { name: "B", summary: "v1" },
    new Date("2026-01-02T00:00:00Z"),
  );
  equal(
    await captureSnapshot(
      store,
      "h1",
      { name: "A", summary: "v1" },
      new Date("2026-01-10T00:00:00Z"),
    ),
    false,
  );
  equal((await store.list("h1")).length, 1);
  await captureSnapshot(
    store,
    "h3",
    { name: "C", summary: "v1" },
    new Date("2026-01-11T00:00:00Z"),
  );
  equal((await store.list("h1")).length, 1);
  equal((await store.list("h2")).length, 0);
  equal((await store.list("h3")).length, 1);
});

test("MemorySnapshotStore enforces both tracked-feature and per-feature caps", async () => {
  const store = new MemorySnapshotStore({
    maxTrackedFeatures: 2,
    maxSnapshotsPerFeature: 3,
  });
  for (let i = 1; i <= 5; i++) {
    equal(
      await store.add("m1", {
        at: `2026-02-0${i}T00:00:00.000Z`,
        data: { Summary: `v${i}` },
      }),
      true,
    );
  }
  const listed = await store.list("m1");
  equal(listed.length, 3);
  equal(listed[0].at, "2026-02-05T00:00:00.000Z");
  equal(listed[2].at, "2026-02-03T00:00:00.000Z");

  await store.add("m2", {
    at: "2026-02-01T00:00:00.000Z",
    data: { Summary: "b" },
  });
  await store.add("m3", {
    at: "2026-02-06T00:00:00.000Z",
    data: { Summary: "c" },
  });
  equal((await store.list("m1")).length, 3);
  equal((await store.list("m2")).length, 0);
  equal((await store.list("m3")).length, 1);
});

test("history and diff views refresh eviction recency", async () => {
  for (const route of ["history", "diff"]) {
    const store = new MemorySnapshotStore({ maxTrackedFeatures: 2 });
    await captureSnapshot(
      store,
      "41",
      { name: "A", summary: "v1" },
      new Date("2026-01-01T00:00:00Z"),
    );
    await captureSnapshot(
      store,
      "42",
      { name: "B", summary: "v1" },
      new Date("2026-01-02T00:00:00Z"),
    );
    const handler = createHandler({ client: fixtureClient(), store });
    const res = await handler(
      new Request(`https://chromestatuslite.com/feature/41/${route}`),
    );
    equal(res.status, 200);
    await captureSnapshot(
      store,
      "43",
      { name: "C", summary: "v1" },
      new Date("2026-01-03T00:00:00Z"),
    );
    equal((await store.list("41")).length, 1);
    equal((await store.list("42")).length, 0);
    equal((await store.list("43")).length, 1);
  }
});

test("history caps the rendered list at 25 and counts the withheld captures (chrome-status-lite-2yt3)", async () => {
  const store = new MemorySnapshotStore({ maxSnapshotsPerFeature: 30 });
  for (let day = 1; day <= 30; day++) {
    await store.add("123", {
      at: `2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`,
      data: { Name: "Capped", Summary: `v${day}` },
    });
  }
  const handler = createHandler({ client: fixtureClient(), store });
  const response = await handler(
    new Request("https://chromestatuslite.com/feature/123/history"),
  );
  equal(response.status, 200);
  const html = await response.text();

  includes(html, "30 snapshot(s), newest first.");
  const startIdx = html.indexOf('<ul class="snapshot-history">');
  const listed = html.slice(startIdx, html.indexOf("</ul>", startIdx));
  equal(listed.split("<li>").length - 1, 25);
  includes(listed, "2026-01-30 00:00");
  includes(listed, "2026-01-06 00:00");
  equal(listed.includes("2026-01-05 00:00"), false);
  includes(html, "5 older capture(s) not shown.");
});
