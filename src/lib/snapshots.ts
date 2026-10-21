// Feature snapshot history: a slim per-feature snapshot is captured
// whenever a reader views /feature/:id and its tracked fields differ from
// the newest stored snapshot. Capture is lazy (no cron): history grows
// with real reader traffic, which keeps the upstream API load and the
// storage cost proportional to attention.

export type FeatureSnapshot = {
  /** ISO timestamp of the capture. */
  at: string;
  /** Tracked display fields, labels as keys; empty values omitted. */
  data: Record<string, string>;
};

export interface SnapshotStore {
  /** Snapshots for a feature, newest first. */
  list(featureId: string): Promise<FeatureSnapshot[]>;
  /**
   * Append a snapshot for a feature. Returns true when the snapshot was
   * stored, false when a retention limit dropped it.
   */
  add(featureId: string, snapshot: FeatureSnapshot): Promise<boolean>;
  /**
   * Only the newest snapshot, if any. Stores may implement this in O(1)
   * (a KV prefix read with limit 1); captureSnapshot falls back to
   * list() when a store does not provide it.
   */
  latest?(featureId: string): Promise<FeatureSnapshot | undefined>;
}

// Second KV key holding a pointer to the newest snapshot. latest() must
// not rely on kv.list ordering: the embedded KV backend shipped in some
// Deno 2.x runtimes ignores reverse/limit on prefix lists (measured on
// 2.9.7), which made an earlier list-based latest() return the OLDEST
// snapshot. A plain get() has no ordering semantics to disagree about.
const LATEST_KEY = "latest";

/** Write-side retention bounds (chrome-status-lite-4g8). Capture is an
 * unauthenticated write path driven by anonymous reads, so nothing upstream
 * bounds growth: keep only the newest snapshots per feature and cap the
 * number of distinct captured features. 25 mirrors the read-side page cap
 * in feature-history.ts; 5000 features x 25 slim snapshots stays well
 * inside Deno KV storage limits. */
export const MAX_SNAPSHOTS_PER_FEATURE = 25;
export const MAX_TRACKED_FEATURES = 5000;

const FEATURE_INDEX_KEY = "feature_index";

export type KvSnapshotStoreOptions = {
  maxSnapshotsPerFeature?: number;
  maxTrackedFeatures?: number;
};

/** Deno KV-backed store; KV is GA on Deno Deploy and Deno 2.x locally. */
export class KvSnapshotStore implements SnapshotStore {
  #kv: Promise<Deno.Kv>;
  #maxSnapshotsPerFeature: number;
  #maxTrackedFeatures: number;

  constructor(path?: string, options: KvSnapshotStoreOptions = {}) {
    this.#kv = Deno.openKv(path);
    this.#maxSnapshotsPerFeature =
      options.maxSnapshotsPerFeature ?? MAX_SNAPSHOTS_PER_FEATURE;
    this.#maxTrackedFeatures =
      options.maxTrackedFeatures ?? MAX_TRACKED_FEATURES;
    // openKv rejects asynchronously (a corrupt/unavailable KV file passes
    // the constructor); without a handler attached now, that rejection is
    // unhandled and kills the process before any route can catch it.
    // Callers still see the error: they await this.#kv inside list/add.
    this.#kv.catch(() => {});
  }

  async list(featureId: string): Promise<FeatureSnapshot[]> {
    const kv = await this.#kv;
    const entries = await Array.fromAsync(
      kv.list<FeatureSnapshot>({ prefix: ["feature", featureId] }),
    );
    return entries
      .filter((e) => e.key[e.key.length - 1] !== LATEST_KEY)
      .map((e) => e.value)
      // Sort in JS: never trust backend iteration order.
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  async latest(featureId: string): Promise<FeatureSnapshot | undefined> {
    const kv = await this.#kv;
    const res = await kv.get<FeatureSnapshot>(["feature", featureId, LATEST_KEY]);
    return res.value ?? undefined;
  }

  async add(featureId: string, snapshot: FeatureSnapshot): Promise<boolean> {
    const kv = await this.#kv;
    const isNewFeature =
      (await kv.get([FEATURE_INDEX_KEY, featureId])).value === null;
    if (isNewFeature) {
      const existing = await Array.fromAsync(
        kv.list({ prefix: [FEATURE_INDEX_KEY] }, { batchSize: 500 }),
      );
      if (existing.length >= this.#maxTrackedFeatures) {
        // The cap is a bound, not a one-way switch (chrome-status-lite-579):
        // evict the least-recently-captured feature - all its snapshot keys,
        // its latest pointer and its index marker - so a full index reclaims
        // slots instead of denying history to every new feature forever.
        let oldest: { featureId: string; key: Deno.KvKey; at: string } | null = null;
        for (const entry of existing) {
          const at = typeof (entry.value as any)?.lastCaptureAt === "string"
            ? (entry.value as any).lastCaptureAt
            : ""; // legacy `true` markers evict first
          if (!oldest || at < oldest.at) {
            oldest = { featureId: String(entry.key[entry.key.length - 1]), key: entry.key, at };
          }
        }
        if (oldest) {
          const evict = kv.atomic();
          for (const e of await Array.fromAsync(
            kv.list({ prefix: ["feature", oldest.featureId] }),
          )) {
            evict.delete(e.key);
          }
          evict.delete(oldest.key);
          await evict.commit();
          console.warn(JSON.stringify({
            event: "snapshot_feature_evicted",
            reason: "tracked_feature_cap",
            evictedFeatureId: oldest.featureId,
            lastCaptureAt: oldest.at,
            trackedFeatures: existing.length,
            maxTrackedFeatures: this.#maxTrackedFeatures,
          }));
        }
      }
    }
    // Snapshot keys are ["feature", id, <ISO at>]. Never trust backend
    // iteration order (the embedded backend already broke prefix-list
    // ordering once, per the LATEST_KEY comment above): sort by the ISO
    // timestamp key part so the trim always deletes the OLDEST snapshots
    // (chrome-status-lite-03h). Keys past the cap are deleted in the same
    // atomic op as the add. Concurrent adds may each compute the same trim
    // set: the cap can be transiently exceeded by the number of concurrent
    // captures and is re-trimmed on the next add; deleting an
    // already-deleted key is a no-op.
    const existingKeys = (await Array.fromAsync(
      kv.list({ prefix: ["feature", featureId] }),
    ))
      .map((e) => e.key)
      .filter((key) => key[key.length - 1] !== LATEST_KEY)
      .sort((a, b) =>
        String(a[a.length - 1]).localeCompare(String(b[b.length - 1]))
      );
    const excess = existingKeys.length + 1 - this.#maxSnapshotsPerFeature;
    const staleKeys = excess > 0 ? existingKeys.slice(0, excess) : [];
    const op = kv.atomic()
      .set(["feature", featureId, snapshot.at], snapshot)
      .set(["feature", featureId, LATEST_KEY], snapshot)
      .set([FEATURE_INDEX_KEY, featureId], { lastCaptureAt: snapshot.at });
    for (const key of staleKeys) op.delete(key);
    await op.commit();
    return true;
  }
}

/** In-memory store for tests and store-less environments. */
export class MemorySnapshotStore implements SnapshotStore {
  #byFeature = new Map<string, FeatureSnapshot[]>();
  #maxSnapshotsPerFeature: number;
  #maxTrackedFeatures: number;

  constructor(options: KvSnapshotStoreOptions = {}) {
    this.#maxSnapshotsPerFeature =
      options.maxSnapshotsPerFeature ?? MAX_SNAPSHOTS_PER_FEATURE;
    this.#maxTrackedFeatures =
      options.maxTrackedFeatures ?? MAX_TRACKED_FEATURES;
  }

  async list(featureId: string): Promise<FeatureSnapshot[]> {
    return [...(this.#byFeature.get(featureId) ?? [])]
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  async add(featureId: string, snapshot: FeatureSnapshot): Promise<boolean> {
    if (
      !this.#byFeature.has(featureId) &&
      this.#byFeature.size >= this.#maxTrackedFeatures
    ) {
      // Same reclaim story as the KV store: evict the least-recently-captured
      // feature (arrays are kept sorted ascending, so the last entry is the
      // newest capture) instead of denying history to new features forever.
      let oldest: string | null = null;
      let oldestAt = "";
      for (const [id, snaps] of this.#byFeature) {
        const at = snaps[snaps.length - 1]?.at ?? "";
        if (!oldest || at < oldestAt) {
          oldest = id;
          oldestAt = at;
        }
      }
      if (oldest !== null) this.#byFeature.delete(oldest);
    }
    const all = this.#byFeature.get(featureId) ?? [];
    all.push(snapshot);
    all.sort((a, b) => a.at.localeCompare(b.at));
    // Same per-feature retention as the KV store: unbounded growth is the
    // defect being fixed, whatever the backend.
    this.#byFeature.set(
      featureId,
      all.slice(Math.max(0, all.length - this.#maxSnapshotsPerFeature)),
    );
    return true;
  }
}

const VIEW_LABELS: Array<[string, string]> = [
  ["Firefox position", "ff"],
  ["Safari position", "safari"],
  ["Web developers position", "webdev"],
];

/** The tracked fields of a feature, flattened for diffing. */
export function extractSnapshotData(feature: any): Record<string, string> {
  const data: Record<string, string> = {};
  const put = (label: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) data[label] = value.trim();
  };
  const chrome = feature?.browsers?.chrome ?? {};
  put("Name", feature?.name);
  put("Summary", feature?.summary);
  put("Intent stage", feature?.intent_stage);
  put("Status", chrome?.status?.text);
  put("Milestone", chrome?.status?.milestone_str);
  put("Specification", feature?.spec_link ?? feature?.standards?.spec);
  put("WPT details", feature?.wpt_descr);
  for (const [label, key] of VIEW_LABELS) {
    const view = feature?.browsers?.[key]?.view;
    put(label, view?.text);
    if (view?.url) data[label] = `${data[label] ? data[label] + " " : ""}${view.url}`;
  }
  return data;
}

/**
 * Capture a snapshot iff the tracked fields changed since the newest one.
 * Returns true when a new snapshot was stored.
 */
export async function captureSnapshot(
  store: SnapshotStore,
  featureId: string,
  feature: any,
  now = new Date(),
): Promise<boolean> {
  const data = extractSnapshotData(feature);
  if (Object.keys(data).length === 0) return false;
  // O(1) dedupe check: only the newest snapshot is needed. Stores without
  // latest() fall back to a full list.
  const newest = store.latest
    ? await store.latest(featureId)
    : (await store.list(featureId))[0];
  if (newest && JSON.stringify(newest.data) === JSON.stringify(data)) {
    return false;
  }
  return await store.add(featureId, { at: now.toISOString(), data });
}

export type FieldDiff =
  | { kind: "added"; field: string; to: string }
  | { kind: "removed"; field: string; from: string }
  | { kind: "changed"; field: string; from: string; to: string };

/** Field-level diff between two snapshots (old, new). */
export function diffSnapshots(
  from: FeatureSnapshot,
  to: FeatureSnapshot,
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const fields = new Set([...Object.keys(from.data), ...Object.keys(to.data)]);
  for (const field of fields) {
    const a = from.data[field];
    const b = to.data[field];
    if (a === undefined) diffs.push({ kind: "added", field, to: b });
    else if (b === undefined) diffs.push({ kind: "removed", field, from: a });
    else if (a !== b) diffs.push({ kind: "changed", field, from: a, to: b });
  }
  return diffs.sort((x, y) => x.field.localeCompare(y.field));
}
