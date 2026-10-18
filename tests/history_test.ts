import { createHandler } from "../src/handler.ts";
import { equal, fixtureClient, includes } from "./fixture.ts";
import {
  captureSnapshot,
  diffSnapshots,
  MemorySnapshotStore,
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
