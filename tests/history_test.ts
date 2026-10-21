import { createHandler } from "../src/handler.ts";
import { equal, fixtureClient, includes } from "./fixture.ts";
import {
  captureSnapshot,
  diffSnapshots,
  KvSnapshotStore,
  MemorySnapshotStore,
  snapshotKeysToTrim,
} from "../src/lib/snapshots.ts";

Deno.test("viewing a feature captures a snapshot and dedupes unchanged views", async () => {
  const store = new MemorySnapshotStore();
  let feature: any = {
    id: 123, name: "Snapshotted", summary: "v1",
    resources: { docs: [], samples: [] },
  };
  const handler = createHandler(
    fixtureClient({ getFeature: async () => feature }),
    undefined,
    store,
  );

  await handler(new Request("https://chromestatuslite.com/feature/123"));
  equal((await store.list("123")).length, 1);

  await handler(new Request("https://chromestatuslite.com/feature/123"));
  equal((await store.list("123")).length, 1);

  feature = { ...feature, summary: "v2" };
  await handler(new Request("https://chromestatuslite.com/feature/123"));
  equal((await store.list("123")).length, 2);
});

Deno.test("history lists snapshots newest-first with changed fields", async () => {
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
  const handler = createHandler(fixtureClient(), undefined, store);

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

Deno.test("diff renders a visual field-level code diff between snapshots", async () => {
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
    { name: "Diffed", summary: "new summary", intent_stage: "Draft", spec_link: "https://example.com/spec" },
    new Date("2026-03-01T00:00:00Z"),
  );
  const handler = createHandler(fixtureClient(), undefined, store);

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

  const resAdded = await handler(new Request(
    "https://chromestatuslite.com/feature/77/diff?from=2026-02-01T00:00:00.000Z&to=2026-03-01T00:00:00.000Z",
  ));
  const addedText = await resAdded.text();
  includes(addedText, "Specification");
  includes(addedText, "https://example.com/spec");
});

Deno.test("the feature page links to its history only when a store is configured", async () => {
  const withStore = createHandler(fixtureClient(), undefined, new MemorySnapshotStore());
  const linked = await (await withStore(
    new Request("https://chromestatuslite.com/feature/123"),
  )).text();
  includes(linked, 'href="/feature/123/history"');

  // No store: the history routes render "not configured", so the page must
  // not advertise them.
  const storeless = await (await createHandler(fixtureClient())(
    new Request("https://chromestatuslite.com/feature/123"),
  )).text();
  equal(storeless.includes("/history"), false);
});

Deno.test("without a store the history and diff routes say so instead of failing", async () => {
  const handler = createHandler(fixtureClient());
  for (const path of ["/feature/123/history", "/feature/123/diff"]) {
    const res = await handler(new Request(`https://chromestatuslite.com${path}`));
    equal(res.status, 200);
    includes(await res.text(), "not configured");
  }
});

Deno.test("diffSnapshots classifies added, removed and changed fields", () => {
  const diffs = diffSnapshots(
    { at: "a", data: { Name: "x", Gone: "old", Field: "before" } },
    { at: "b", data: { Name: "x", Field: "after", New: "fresh" } },
  );
  equal(diffs.length, 3);
  includes(JSON.stringify(diffs), '"kind":"added"');
  includes(JSON.stringify(diffs), '"kind":"removed"');
  includes(JSON.stringify(diffs), '"kind":"changed"');
});

Deno.test("a broken store renders unavailable, not an empty history", async () => {
  const broken = {
    list: async () => { throw new Error("KV unavailable"); },
    add: async () => { throw new Error("KV unavailable"); },
  };
  const handler = createHandler(fixtureClient(), undefined, broken as any);

  const res = await handler(new Request("https://chromestatuslite.com/feature/9/history"));
  equal(res.status, 200);
  const text = await res.text();
  includes(text, "temporarily unavailable");
  equal(text.includes("No snapshots captured yet"), false);
});

Deno.test("a reversed from/to pair is normalised to older-then-newer", async () => {
  const store = new MemorySnapshotStore();
  await captureSnapshot(store, "77", { name: "D", summary: "OLD" }, new Date("2026-01-01T00:00:00Z"));
  await captureSnapshot(store, "77", { name: "D", summary: "NEW" }, new Date("2026-02-01T00:00:00Z"));
  const handler = createHandler(fixtureClient(), undefined, store);

  const res = await handler(new Request(
    "https://chromestatuslite.com/feature/77/diff?from=2026-02-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z",
  ));
  const text = await res.text();
  const delIndex = text.indexOf("diff-del");
  const addIndex = text.indexOf("diff-add");
  includes(text, "2026-01-01");
  equal(delIndex < addIndex && delIndex !== -1, true);
  const afterDel = text.slice(delIndex, addIndex);
  includes(afterDel, "OLD");
});

Deno.test("an unresolvable from/to param says so and falls back to the full range", async () => {
  const store = new MemorySnapshotStore();
  await captureSnapshot(store, "77", { name: "D", summary: "A" }, new Date("2026-01-01T00:00:00Z"));
  await captureSnapshot(store, "77", { name: "D", summary: "B" }, new Date("2026-02-01T00:00:00Z"));
  const handler = createHandler(fixtureClient(), undefined, store);

  const res = await handler(new Request(
    "https://chromestatuslite.com/feature/77/diff?from=1999-01-01T00:00:00.000Z",
  ));
  includes(await res.text(), "was not found");
});

Deno.test("captureSnapshot prefers latest() and falls back to list()", async () => {
  let latestCalls = 0;
  let listCalls = 0;
  const inner = new MemorySnapshotStore();
  const withLatest = {
    list: async (id: string) => { listCalls++; return inner.list(id); },
    add: (id: string, snap: any) => inner.add(id, snap),
    latest: async (id: string) => { latestCalls++; return inner.list(id)[0]; },
  };
  await captureSnapshot(withLatest as any, "5", { name: "N", summary: "x" });
  equal(latestCalls, 1);
  equal(listCalls, 0);

  const bare = {
    list: async (id: string) => { listCalls++; return inner.list(id); },
    add: (id: string, snap: any) => inner.add(id, snap),
  };
  await captureSnapshot(bare as any, "6", { name: "N", summary: "x" });
  equal(listCalls, 1);
});

Deno.test("KvSnapshotStore on the real embedded backend: latest() is the newest, unchanged views store nothing", async () => {
  const store = new KvSnapshotStore(":memory:");
  await store.add("kv1", { at: "2026-01-01T00:00:00.000Z", data: { Name: "X", Summary: "v1" } });
  await store.add("kv1", { at: "2026-02-01T00:00:00.000Z", data: { Name: "X", Summary: "v2" } });

  equal((await store.latest("kv1"))!.at, "2026-02-01T00:00:00.000Z");
  const listed = await store.list("kv1");
  equal(listed.length, 2);
  equal(listed[0].at, "2026-02-01T00:00:00.000Z");

  equal(await captureSnapshot(store, "kv1", { name: "X", summary: "v2" }), false);
  equal((await store.list("kv1")).length, 2);
  equal(await captureSnapshot(store, "kv1", { name: "X", summary: "v3" }), true);
  equal((await store.latest("kv1"))!.data["Summary"], "v3");
});

Deno.test("KvSnapshotStore keeps only the newest snapshots per feature", async () => {
  const store = new KvSnapshotStore(":memory:", { maxSnapshotsPerFeature: 5 });
  for (let i = 1; i <= 8; i++) {
    const at = `2026-01-0${i}T00:00:00.000Z`;
    equal(await store.add("kvtrim", { at, data: { Summary: `v${i}` } }), true);
  }
  const listed = await store.list("kvtrim");
  equal(listed.length, 5);
  // Newest first, and the three oldest were deleted.
  equal(listed[0].at, "2026-01-08T00:00:00.000Z");
  equal(listed[4].at, "2026-01-04T00:00:00.000Z");
  equal((await store.latest("kvtrim"))!.at, "2026-01-08T00:00:00.000Z");
});

Deno.test("KvSnapshotStore evicts the least-recently-captured feature when the tracked-feature cap is full", async () => {
  const store = new KvSnapshotStore(":memory:", { maxTrackedFeatures: 2 });
  equal(await store.add("f1", { at: "2026-01-01T00:00:00.000Z", data: { Summary: "a" } }), true);
  equal(await store.add("f2", { at: "2026-01-02T00:00:00.000Z", data: { Summary: "b" } }), true);

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: unknown) => warnings.push(String(msg));
  try {
    // The cap reclaims instead of denying history to new features forever.
    equal(await store.add("f3", { at: "2026-01-03T00:00:00.000Z", data: { Summary: "c" } }), true);
  } finally {
    console.warn = originalWarn;
  }
  // f1 was least-recently-captured: its snapshots and marker are gone.
  equal((await store.list("f1")).length, 0);
  equal((await store.list("f2")).length, 1);
  equal((await store.list("f3")).length, 1);
  equal(warnings.length, 1);
  const event = JSON.parse(warnings[0]);
  equal(event.event, "snapshot_feature_evicted");
  equal(event.reason, "tracked_feature_cap");
  equal(event.evictedFeatureId, "f1");
  equal(event.maxTrackedFeatures, 2);
});

Deno.test("KvSnapshotStore eviction follows recency: a fresh capture protects its feature", async () => {
  const store = new KvSnapshotStore(":memory:", { maxTrackedFeatures: 2 });
  await store.add("f1", { at: "2026-01-01T00:00:00.000Z", data: { Summary: "a" } });
  await store.add("f2", { at: "2026-01-02T00:00:00.000Z", data: { Summary: "b" } });
  // f1 captured again most recently; f2 is now the eviction candidate.
  await store.add("f1", { at: "2026-01-03T00:00:00.000Z", data: { Summary: "a2" } });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    equal(await store.add("f3", { at: "2026-01-04T00:00:00.000Z", data: { Summary: "c" } }), true);
  } finally {
    console.warn = originalWarn;
  }
  equal((await store.list("f1")).length, 2);
  equal((await store.list("f2")).length, 0);
  equal((await store.list("f3")).length, 1);
});

Deno.test("KvSnapshotStore holds the tracked-feature cap under concurrent first-captures", async () => {
  // The threat model is anonymous concurrent GETs of distinct features:
  // every full-index commit must remove one marker for every one it
  // inserts, so bursts cannot ratchet the index past the cap (6kk).
  const store = new KvSnapshotStore(":memory:", { maxTrackedFeatures: 3 });
  const originalWarn = console.warn;
  console.warn = () => {};
  const ids: string[] = [];
  try {
    for (let burst = 0; burst < 4; burst++) {
      const batch = [];
      for (let i = 0; i < 5; i++) {
        const id = `c${burst}x${i}`;
        ids.push(id);
        batch.push(store.add(id, {
          at: `2026-04-0${burst + 1}T0${i}:00:00.000Z`,
          data: { Summary: `s${burst}-${i}` },
        }));
      }
      await Promise.all(batch);
      let tracked = 0;
      for (const id of ids) {
        if ((await store.list(id)).length > 0) tracked++;
      }
      equal(tracked <= 3, true);
    }
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("KvSnapshotStore touch() refreshes eviction recency past the throttle window", async () => {
  const store = new KvSnapshotStore(":memory:", { maxTrackedFeatures: 2 });
  await store.add("t1", { at: "2026-01-01T00:00:00.000Z", data: { Summary: "a" } });
  await store.add("t2", { at: "2026-01-02T00:00:00.000Z", data: { Summary: "b" } });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    // A touch inside the 24h window is throttled: t1 stays oldest.
    await store.touch("t1", new Date("2026-01-01T06:00:00.000Z"));
    await store.add("t3", { at: "2026-01-03T00:00:00.000Z", data: { Summary: "c" } });
    equal((await store.list("t1")).length, 0);
    equal((await store.list("t2")).length, 1);
    // A touch past the window makes t2 the oldest: the next capture evicts it.
    await store.touch("t2", new Date("2026-01-04T00:00:00.000Z"));
    await store.add("t4", { at: "2026-01-05T00:00:00.000Z", data: { Summary: "d" } });
    equal((await store.list("t2")).length, 1);
    equal((await store.list("t3")).length, 0);
    equal((await store.list("t4")).length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("captureSnapshot refreshes recency on deduped views, protecting hot stable features", async () => {
  const store = new MemorySnapshotStore({ maxTrackedFeatures: 2 });
  await captureSnapshot(store, "h1", { name: "A", summary: "v1" }, new Date("2026-01-01T00:00:00Z"));
  await captureSnapshot(store, "h2", { name: "B", summary: "v1" }, new Date("2026-01-02T00:00:00Z"));
  // h1 is read again days later with unchanged data: deduped, but touched.
  equal(await captureSnapshot(store, "h1", { name: "A", summary: "v1" }, new Date("2026-01-10T00:00:00Z")), false);
  equal((await store.list("h1")).length, 1);
  await captureSnapshot(store, "h3", { name: "C", summary: "v1" }, new Date("2026-01-11T00:00:00Z"));
  equal((await store.list("h1")).length, 1); // hot stable feature survives
  equal((await store.list("h2")).length, 0); // stale one is evicted
  equal((await store.list("h3")).length, 1);
});

Deno.test("snapshotKeysToTrim picks the oldest by timestamp regardless of input order", () => {
  // The embedded KV backend only lists ascending, so the integration test
  // cannot distinguish sorted from unsorted trimming (ign): this feeds the
  // trim function descending and shuffled sequences directly. An unsorted
  // implementation trims the FIRST listed key here - the newest.
  const k = (t: string) => ["feature", "x", t];
  const descending = [k("2026-03-01"), k("2026-02-01"), k("2026-01-01")];
  // keys exclude the pending add: 3 existing keys with a cap of 3 means
  // one excess once the new snapshot lands.
  for (const input of [descending, [...descending].reverse(), [descending[1], descending[2], descending[0]]]) {
    const trim = snapshotKeysToTrim(input, 3);
    equal(trim.length, 1);
    equal(String(trim[0][2]), "2026-01-01");
  }
  // At or under the cap nothing is trimmed.
  equal(snapshotKeysToTrim([k("2026-01-01")], 2).length, 0);
  equal(snapshotKeysToTrim([k("2026-01-01"), k("2026-01-02")], 3).length, 0);
});

Deno.test("KvSnapshotStore trims by snapshot timestamp, not insertion or iteration order", async () => {
  const store = new KvSnapshotStore(":memory:", { maxSnapshotsPerFeature: 2 });
  await store.add("ord", { at: "2026-03-01T00:00:00.000Z", data: { Summary: "new" } });
  await store.add("ord", { at: "2026-01-01T00:00:00.000Z", data: { Summary: "old" } });
  // A late-arriving backdated snapshot must not evict newer history.
  await store.add("ord", { at: "2026-02-01T00:00:00.000Z", data: { Summary: "mid" } });
  const listed = await store.list("ord");
  equal(listed.length, 2);
  equal(listed[0].at, "2026-03-01T00:00:00.000Z");
  equal(listed[1].at, "2026-02-01T00:00:00.000Z");
});

Deno.test("MemorySnapshotStore enforces the tracked-feature cap with the same recency eviction", async () => {
  const store = new MemorySnapshotStore({ maxTrackedFeatures: 2 });
  await store.add("m1", { at: "2026-01-01T00:00:00.000Z", data: { Summary: "a" } });
  await store.add("m2", { at: "2026-01-02T00:00:00.000Z", data: { Summary: "b" } });
  await store.add("m1", { at: "2026-01-03T00:00:00.000Z", data: { Summary: "a2" } });
  equal(await store.add("m3", { at: "2026-01-04T00:00:00.000Z", data: { Summary: "c" } }), true);
  equal((await store.list("m1")).length, 2);
  equal((await store.list("m2")).length, 0);
  equal((await store.list("m3")).length, 1);
});

Deno.test("MemorySnapshotStore enforces the same per-feature cap", async () => {
  const store = new MemorySnapshotStore({ maxSnapshotsPerFeature: 3 });
  for (let i = 1; i <= 5; i++) {
    equal(await store.add("m1", { at: `2026-02-0${i}T00:00:00.000Z`, data: { Summary: `v${i}` } }), true);
  }
  const listed = await store.list("m1");
  equal(listed.length, 3);
  equal(listed[0].at, "2026-02-05T00:00:00.000Z");
  equal(listed[2].at, "2026-02-03T00:00:00.000Z");
});
