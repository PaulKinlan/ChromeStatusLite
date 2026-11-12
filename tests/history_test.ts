import { createHandler } from "../src/handler.ts";
import { equal, fixtureClient, includes } from "./fixture.ts";
import {
  captureSnapshot,
  diffSnapshots,
  KvSnapshotStore,
  type KvSnapshotStoreOptions,
  MemorySnapshotStore,
  snapshotKeysToTrim,
} from "../src/lib/snapshots.ts";

// Deno's test resource sanitizer does NOT observe embedded-KV handles
// (chrome-status-lite-orgp): a test that leaks an unclosed Deno.openKv handle
// stays green. So the suite enforces "each test owns and closes its KV
// handles" itself: every handle a test opens is recorded through store() or
// own(), and assertAllClosed() proves each one rejects operations with
// BadResource - a dropped close() fails the test that dropped it.
// assertAllClosed() also fails when fewer handles were recorded than expected
// (chrome-status-lite-8fi7): an empty handles array would pass vacuously, so
// a test that opens a KV handle without recording it through the owner must
// not stay green.
function kvOwner() {
  const handles: Deno.Kv[] = [];
  return {
    store(path?: string, options: KvSnapshotStoreOptions = {}): KvSnapshotStore {
      return new KvSnapshotStore(path, {
        ...options,
        openKv: async (p?: string) => {
          const kv = await (options.openKv ?? Deno.openKv)(p);
          handles.push(kv);
          return kv;
        },
      });
    },
    own<T extends Deno.Kv>(kv: T): T {
      handles.push(kv);
      return kv;
    },
    async assertAllClosed(expect = 1): Promise<void> {
      if (handles.length < expect) {
        throw new Error(
          `KV handle guard is vacuous: expected at least ${expect} recorded ` +
            `handle(s), recorded ${handles.length} - open KV handles through ` +
            `owner.store()/owner.own() so their close is verified`,
        );
      }
      for (const kv of handles) {
        let error: unknown = null;
        try {
          await kv.get(["__kv_owner_closed_probe__"]);
        } catch (caught) {
          error = caught;
        }
        if (!(error instanceof Deno.errors.BadResource)) {
          throw new Error(
            `KV handle was never closed (probe ${
              error === null ? "read a live handle" : `threw ${error}`
            })`,
          );
        }
      }
    },
  };
}

Deno.test("KV owner refuses a vacuous close check when no handle was recorded", async () => {
  const owner = kvOwner();
  // Model a handle opened without owner.store()/owner.own(). Deno's resource
  // sanitizer misses embedded KV handles, so a zero-handle owner must fail
  // rather than treating its empty loop as proof the raw handle was closed.
  const rawKv = await Deno.openKv(":memory:");
  try {
    let failure: unknown;
    try {
      await owner.assertAllClosed();
    } catch (error) {
      failure = error;
    }
    if (!(failure instanceof Error)) {
      throw new Error("Expected the zero-handle KV owner guard to reject");
    }
    includes(failure.message, "KV handle guard is vacuous");
  } finally {
    rawKv.close();
  }
});

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

Deno.test("history and diff bound overlong feature ids at the seam (chrome-status-lite-s9w)", async () => {
  // The id keys snapshot-store lookups; a digit string longer than a real
  // chromestatus id must 404 without touching the store.
  const store = new MemorySnapshotStore();
  const handler = createHandler(fixtureClient(), undefined, store);
  const overlong = "5".repeat(17);
  equal((await handler(new Request(`https://chromestatuslite.com/feature/${overlong}/history`))).status, 404);
  equal((await handler(new Request(`https://chromestatuslite.com/feature/${overlong}/diff`))).status, 404);
  equal((await store.list(overlong)).length, 0);
});

Deno.test("HEAD on history and diff never touches the recency marker (chrome-status-lite-2cf)", async () => {
  // touch() is a durable KV write (the retention eviction marker), so a HEAD
  // probe must not trigger it. A recording store pins the seam.
  const touched: string[] = [];
  const store: SnapshotStore = {
    list: async () => [],
    add: async () => true,
    touch: async (id: string) => {
      touched.push(id);
    },
  };
  const handler = createHandler(fixtureClient(), undefined, store);

  await handler(new Request("https://chromestatuslite.com/feature/123/history", { method: "HEAD" }));
  await handler(new Request("https://chromestatuslite.com/feature/123/diff", { method: "HEAD" }));
  equal(touched.length, 0);

  // A real GET read still refreshes recency.
  await handler(new Request("https://chromestatuslite.com/feature/123/history"));
  equal(touched.length, 1);
  await handler(new Request("https://chromestatuslite.com/feature/123/diff"));
  equal(touched.length, 2);
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

Deno.test("history and diff pages render a self-referential canonical link", async () => {
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
  const handler = createHandler(fixtureClient(), undefined, store);

  const history = await (await handler(
    new Request("https://chromestatuslite.com/feature/88/history"),
  )).text();
  includes(
    history,
    '<link rel="canonical" href="https://chromestatuslite.com/feature/88/history">',
  );

  const diff = await (await handler(
    new Request("https://chromestatuslite.com/feature/88/diff?from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z"),
  )).text();
  includes(
    diff,
    '<link rel="canonical" href="https://chromestatuslite.com/feature/88/diff?from=2026-01-01T00:00:00.000Z&amp;to=2026-02-01T00:00:00.000Z">',
  );
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
  const owner = kvOwner();
  const store = owner.store(":memory:");
  try {
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
  } finally {
    await store.close();
    await owner.assertAllClosed();
  }
});

Deno.test("KvSnapshotStore keeps only the newest snapshots per feature", async () => {
  const owner = kvOwner();
  const store = owner.store(":memory:", { maxSnapshotsPerFeature: 5 });
  try {
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
  } finally {
    await store.close();
    await owner.assertAllClosed();
  }
});

Deno.test("KvSnapshotStore evicts the least-recently-captured feature when the tracked-feature cap is full", async () => {
  const warnings: string[] = [];
  const owner = kvOwner();
  const store = owner.store(":memory:", {
    maxTrackedFeatures: 2,
    // The diagnostics sink is injected (chrome-status-lite-5e9): tests never
    // monkeypatch the global console.warn.
    warn: (message) => warnings.push(message),
  });
  try {
    equal(await store.add("f1", { at: "2026-01-01T00:00:00.000Z", data: { Summary: "a" } }), true);
    equal(await store.add("f2", { at: "2026-01-02T00:00:00.000Z", data: { Summary: "b" } }), true);

    // The cap reclaims instead of denying history to new features forever.
    equal(await store.add("f3", { at: "2026-01-03T00:00:00.000Z", data: { Summary: "c" } }), true);
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
  } finally {
    await store.close();
    await owner.assertAllClosed();
  }
});

Deno.test("KvSnapshotStore eviction follows recency: a fresh capture protects its feature", async () => {
  const owner = kvOwner();
  const store = owner.store(":memory:", { maxTrackedFeatures: 2, warn: () => {} });
  try {
    await store.add("f1", { at: "2026-01-01T00:00:00.000Z", data: { Summary: "a" } });
    await store.add("f2", { at: "2026-01-02T00:00:00.000Z", data: { Summary: "b" } });
    // f1 captured again most recently; f2 is now the eviction candidate.
    await store.add("f1", { at: "2026-01-03T00:00:00.000Z", data: { Summary: "a2" } });
    equal(await store.add("f3", { at: "2026-01-04T00:00:00.000Z", data: { Summary: "c" } }), true);
    equal((await store.list("f1")).length, 2);
    equal((await store.list("f2")).length, 0);
    equal((await store.list("f3")).length, 1);
  } finally {
    await store.close();
    await owner.assertAllClosed();
  }
});

Deno.test("KvSnapshotStore holds the tracked-feature cap under concurrent first-captures", async () => {
  // The threat model is anonymous concurrent GETs of distinct features:
  // every full-index commit must remove one marker for every one it
  // inserts, so bursts cannot ratchet the index past the cap (6kk).
  const owner = kvOwner();
  const store = owner.store(":memory:", { maxTrackedFeatures: 3, warn: () => {} });
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
    await store.close();
    await owner.assertAllClosed();
  }
});

Deno.test("KvSnapshotStore touch() refreshes eviction recency past the throttle window", async () => {
  const owner = kvOwner();
  const store = owner.store(":memory:", { maxTrackedFeatures: 2, warn: () => {} });
  try {
    await store.add("t1", { at: "2026-01-01T00:00:00.000Z", data: { Summary: "a" } });
    await store.add("t2", { at: "2026-01-02T00:00:00.000Z", data: { Summary: "b" } });
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
    await store.close();
    await owner.assertAllClosed();
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
  const owner = kvOwner();
  const store = owner.store(":memory:", { maxSnapshotsPerFeature: 2 });
  try {
    await store.add("ord", { at: "2026-03-01T00:00:00.000Z", data: { Summary: "new" } });
    await store.add("ord", { at: "2026-01-01T00:00:00.000Z", data: { Summary: "old" } });
    // A late-arriving backdated snapshot must not evict newer history.
    await store.add("ord", { at: "2026-02-01T00:00:00.000Z", data: { Summary: "mid" } });
    const listed = await store.list("ord");
    equal(listed.length, 2);
    equal(listed[0].at, "2026-03-01T00:00:00.000Z");
    equal(listed[1].at, "2026-02-01T00:00:00.000Z");
  } finally {
    await store.close();
    await owner.assertAllClosed();
  }
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

Deno.test("history and diff views refresh eviction recency", async () => {
  // Readers who only ever open /history or /diff must still count as reads
  // for LRU eviction (chrome-status-lite-3fn).
  for (const route of ["history", "diff"]) {
    const store = new MemorySnapshotStore({ maxTrackedFeatures: 2 });
    await captureSnapshot(store, "41", { name: "A", summary: "v1" }, new Date("2026-01-01T00:00:00Z"));
    await captureSnapshot(store, "42", { name: "B", summary: "v1" }, new Date("2026-01-02T00:00:00Z"));
    const handler = createHandler(fixtureClient(), undefined, store);
    // Reading feature 41's history/diff touches its marker (wall-clock now
    // is past the 24h throttle window relative to the capture timestamps).
    const res = await handler(new Request(`https://chromestatuslite.com/feature/41/${route}`));
    equal(res.status, 200);
    // A new capture must now evict 42, not the freshly-read 41.
    await captureSnapshot(store, "43", { name: "C", summary: "v1" }, new Date("2026-01-03T00:00:00Z"));
    equal((await store.list("41")).length, 1);
    equal((await store.list("42")).length, 0);
    equal((await store.list("43")).length, 1);
  }
});

Deno.test("a re-capture holding a stale marker cannot resurrect it past the cap", async () => {
  // Deterministic chrome-status-lite-r83: the feature's marker is evicted
  // between the add() reading it and its commit. The openKv seam returns a
  // stale marker entry for exactly one get(); with the own-marker check the
  // commit fails (the real marker is gone) and the retry re-enters through
  // the counter path - without it the commit resurrects the marker and the
  // index stays over the cap.
  const owner = kvOwner();
  const baseKv = owner.own(await Deno.openKv(":memory:"));
  let staleReads = 0;
  let staleEntry: Deno.KvEntryMaybe<unknown> | null = null;
  const kv = new Proxy(baseKv, {
    get(t, p) {
      if (p === "get") {
        return (key: Deno.KvKey) => {
          if (
            staleReads > 0 && Array.isArray(key) &&
            key[0] === "feature_index" && key[1] === "raceA"
          ) {
            staleReads--;
            return Promise.resolve(staleEntry);
          }
          return t.get(key as never);
        };
      }
      const v = Reflect.get(t, p);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const store = new KvSnapshotStore(undefined, {
    maxTrackedFeatures: 1,
    openKv: async () => kv,
    warn: () => {},
  });
  try {
    await store.add("raceA", { at: "2026-01-01T00:00:00.000Z", data: { Summary: "a" } });
    // Capture raceA's real marker entry (real versionstamp) before eviction.
    staleEntry = await baseKv.get(["feature_index", "raceA"]);
    // raceB's first-capture evicts raceA (cap 1): marker and snapshots gone.
    await store.add("raceB", { at: "2026-01-02T00:00:00.000Z", data: { Summary: "b" } });
    equal((await store.list("raceA")).length, 0);
    // Now raceA is re-captured with a stale marker read, as if its add had
    // read the marker before raceB's eviction committed.
    staleReads = 1;
    await store.add("raceA", { at: "2026-01-03T00:00:00.000Z", data: { Summary: "a2" } });
    let tracked = 0;
    for (const id of ["raceA", "raceB"]) {
      if ((await store.list(id)).length > 0) tracked++;
    }
    equal(tracked <= 1, true);
  } finally {
    // The store's openKv seam wraps this same handle: close it once, here.
    baseKv.close();
    await owner.assertAllClosed();
  }
});

Deno.test("evicting a victim re-captured mid-flight deletes its newest keys too", async () => {
  // Deterministic chrome-status-lite-2pm (r83 remedy (b)): a re-capture of
  // the eviction victim commits between the victim-key list and the eviction
  // commit. The eviction must notice the victim marker's versionstamp change
  // and retry - without that check it deletes only the keys it listed and
  // the re-capture's newest snapshot key is left orphaned under no marker.
  const owner = kvOwner();
  const baseKv = owner.own(await Deno.openKv(":memory:"));
  let armed = false;
  let inject: () => Promise<void> = () => Promise.resolve();
  const kv = new Proxy(baseKv, {
    get(t, p) {
      if (p === "list") {
        return (selector: { prefix?: unknown[] }, options?: unknown) => {
          const iter = t.list(selector as never, options as never);
          if (
            !armed || !Array.isArray(selector?.prefix) ||
            selector.prefix[0] !== "feature" || selector.prefix[1] !== "V"
          ) {
            return iter;
          }
          armed = false; // fire once: a retry must list the fresh keys
          const action = inject;
          return (async function* () {
            // Drain the real iterator (the pre-re-capture key list), commit
            // the racing re-capture, then hand back the stale entries.
            const drained: Deno.KvEntry<unknown>[] = [];
            for await (const entry of iter) drained.push(entry);
            await action();
            yield* drained;
          })();
        };
      }
      const v = Reflect.get(t, p);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const store = new KvSnapshotStore(undefined, {
    maxTrackedFeatures: 1,
    openKv: async () => kv,
    warn: () => {},
  });
  // The racing re-capture runs against the raw KV, like a concurrent
  // request's store would.
  const racingStore = new KvSnapshotStore(undefined, {
    maxTrackedFeatures: 1,
    openKv: async () => baseKv,
    warn: () => {},
  });
  try {
    await store.add("V", { at: "2026-01-01T00:00:00.000Z", data: { Summary: "v1" } });
    armed = true;
    inject = () =>
      racingStore.add("V", { at: "2026-01-05T00:00:00.000Z", data: { Summary: "v2" } })
        .then(() => {});
    await store.add("F", { at: "2026-01-03T00:00:00.000Z", data: { Summary: "f" } });
    // V must be fully gone: marker AND every snapshot key, including the one
    // the re-capture wrote after the eviction listed its keys.
    equal((await baseKv.get(["feature_index", "V"])).value, null);
    let vKeys = 0;
    for await (const _entry of baseKv.list({ prefix: ["feature", "V"] })) vKeys++;
    equal(vKeys, 0);
    // F took V's slot and the counter still accounts for exactly one feature.
    equal((await baseKv.get(["feature_index", "F"])).value !== null, true);
    equal((await store.list("F")).length, 1);
    equal((await baseKv.get(["feature_count"])).value, 1);
  } finally {
    // Both stores wrap this same raw handle via the openKv seam: close once.
    baseKv.close();
    await owner.assertAllClosed();
  }
});

Deno.test("KvSnapshotStore trim keeps the newest snapshots even when the backend lists keys in reverse", async () => {
  // The embedded backend only lists ascending, so the call-site use of the
  // sorted trim can only be pinned by a non-ascending backend (yrn). Inject
  // an opener whose prefix lists yield entries in reverse key order, then
  // run the trim scenario through the real store: an inline unsorted slice
  // at the call site would delete the NEWEST snapshot here.
  const reversedOpenKv = async (path?: string) => {
    const kv = await Deno.openKv(path);
    return new Proxy(kv, {
      get(kvTarget, kvProp, receiver) {
        if (kvProp !== "list") {
          // KV methods use private fields: bind them to the real instance,
          // a proxy receiver breaks them.
          const value = Reflect.get(kvTarget, kvProp);
          return typeof value === "function" ? value.bind(kvTarget) : value;
        }
        return (selector: unknown, options?: unknown) => {
          const iter = kvTarget.list(selector as never, options as never);
          return {
            [Symbol.asyncIterator]() {
              let buf: unknown[] | null = null;
              let i = 0;
              const it = iter[Symbol.asyncIterator]();
              return {
                async next() {
                  if (buf === null) {
                    buf = [];
                    for (let r = await it.next(); !r.done; r = await it.next()) {
                      buf.push(r.value);
                    }
                    buf.reverse();
                  }
                  return i < buf.length
                    ? { value: buf[i++], done: false as const }
                    : { value: undefined, done: true as const };
                },
              };
            },
          };
        };
      },
    });
  };
  const owner = kvOwner();
  const store = owner.store(":memory:", {
    maxSnapshotsPerFeature: 2,
    openKv: reversedOpenKv,
  });
  try {
    await store.add("rev", { at: "2026-03-01T00:00:00.000Z", data: { Summary: "new" } });
    await store.add("rev", { at: "2026-01-01T00:00:00.000Z", data: { Summary: "old" } });
    await store.add("rev", { at: "2026-02-01T00:00:00.000Z", data: { Summary: "mid" } });
    const listed = await store.list("rev");
    equal(listed.length, 2);
    equal(listed[0].at, "2026-03-01T00:00:00.000Z");
    equal(listed[1].at, "2026-02-01T00:00:00.000Z");
  } finally {
    await store.close(); // the proxy delegates close() to the raw handle
    await owner.assertAllClosed();
  }
});

Deno.test("history caps the rendered list at 25 and counts the withheld captures (chrome-status-lite-2yt3)", async () => {
  // A heavily-viewed feature must not render an ever-growing list: the page
  // shows the newest MAX_ENTRIES=25 captures and says how many it withheld.
  const store = new MemorySnapshotStore({ maxSnapshotsPerFeature: 30 });
  for (let day = 1; day <= 30; day++) {
    await store.add("123", {
      at: `2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`,
      data: { Name: "Capped", Summary: `v${day}` },
    });
  }
  const handler = createHandler(fixtureClient(), undefined, store);
  const response = await handler(new Request("https://chromestatuslite.com/feature/123/history"));
  equal(response.status, 200);
  const html = await response.text();

  includes(html, "30 snapshot(s), newest first.");
  const listed = html.slice(html.indexOf('<ul class="snapshot-history">'), html.indexOf("</ul>", html.indexOf('<ul class="snapshot-history">')));
  equal(listed.split("<li>").length - 1, 25); // only the newest 25 are rendered
  includes(listed, "2026-01-30 00:00"); // newest first...
  includes(listed, "2026-01-06 00:00"); // ...down to the 25th
  equal(listed.includes("2026-01-05 00:00"), false); // the rest are withheld
  includes(html, "5 older capture(s) not shown.");
});

Deno.test("diff with only one snapshot asks for a pair instead of rendering an empty diff (chrome-status-lite-2yt3)", async () => {
  const store = new MemorySnapshotStore();
  await store.add("123", { at: "2026-01-01T00:00:00.000Z", data: { Name: "Only" } });
  const handler = createHandler(fixtureClient(), undefined, store);
  const response = await handler(new Request("https://chromestatuslite.com/feature/123/diff"));
  equal(response.status, 200);
  const html = await response.text();
  includes(html, "Two different snapshots are needed for a diff.");
  includes(html, '<a href="/feature/123/history">View the history</a>');
  equal(html.includes('<div class="diff">'), false); // no empty diff shell
});

Deno.test("diff between two captures with identical tracked fields says nothing changed (chrome-status-lite-2yt3)", async () => {
  // Re-viewing a feature does not capture an unchanged snapshot
  // (captureSnapshot dedupes), so this pair can only exist when the tracked
  // fields changed and then changed back: the diff is empty, which must read
  // as "no tracked field changed" rather than as a broken page.
  const store = new MemorySnapshotStore();
  await store.add("123", { at: "2026-01-01T00:00:00.000Z", data: { Name: "Same", Summary: "same" } });
  await store.add("123", { at: "2026-01-02T00:00:00.000Z", data: { Name: "Same", Summary: "same" } });
  const handler = createHandler(fixtureClient(), undefined, store);
  const response = await handler(new Request("https://chromestatuslite.com/feature/123/diff"));
  equal(response.status, 200);
  const html = await response.text();
  includes(html, "No tracked field changed between these snapshots.");
  includes(html, "2026-01-01 00:00Z &rarr; 2026-01-02 00:00Z".replace("&rarr;", "→"));
});
