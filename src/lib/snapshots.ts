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
  /**
   * Refresh a feature's recency without appending a snapshot, so retention
   * eviction follows "last read", not "last data change"
   * (chrome-status-lite-4x3). Called on deduped (unchanged) captures.
   * Implementations should throttle internally.
   */
  touch?(featureId: string, now?: Date): Promise<void>;
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

// Single counter key for the index size. Every first-capture commit checks
// it, so concurrent new-feature captures serialize on one key and the cap
// holds under bursts instead of racing on a read-then-write count (6kk).
const FEATURE_COUNT_KEY = "feature_count";

/**
 * Keys of the oldest snapshots beyond the cap, chosen by the ISO timestamp
 * key part - never by backend iteration order (chrome-status-lite-03h).
 * `keys` excludes the snapshot about to be added, so one excess key is
 * trimmed when the feature already holds the cap. Exported for tests: the
 * embedded backend only ever lists ascending, so order-independence can
 * only be pinned by feeding this function a non-ascending sequence directly
 * (chrome-status-lite-ign).
 */
export function snapshotKeysToTrim(
  keys: Deno.KvKey[],
  maxSnapshots: number,
): Deno.KvKey[] {
  const sorted = [...keys].sort((a, b) =>
    String(a[a.length - 1]).localeCompare(String(b[b.length - 1]))
  );
  const excess = sorted.length + 1 - maxSnapshots;
  return excess > 0 ? sorted.slice(0, excess) : [];
}

/** Minimum interval between recency-refresh writes for one feature. A page
 * view of an unchanged feature touches the index marker so eviction follows
 * last-read (4x3), but an unthrottled write per anonymous read would
 * re-create the unbounded-write path 4g8 bounded; one write per day per
 * feature is enough resolution for LRU eviction. */
export const RECENCY_TOUCH_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Concurrent full-index captures race on the same eviction victim; the
 * atomic .check() on the victim's marker fails all but one commit, and the
 * losers rescan and retry against a fresh victim. Bounded so pathological
 * contention degrades to an observable drop rather than a spin. */
const MAX_EVICTION_ATTEMPTS = 10;

export type KvSnapshotStoreOptions = {
  maxSnapshotsPerFeature?: number;
  maxTrackedFeatures?: number;
  /** Testing seam: override the KV opener (e.g. to fake a backend whose
   * prefix lists are not ascending). Defaults to Deno.openKv. */
  openKv?: (path?: string) => Promise<Deno.Kv>;
};

/** Deno KV-backed store; KV is GA on Deno Deploy and Deno 2.x locally. */
export class KvSnapshotStore implements SnapshotStore {
  #kv: Promise<Deno.Kv>;
  #maxSnapshotsPerFeature: number;
  #maxTrackedFeatures: number;

  constructor(path?: string, options: KvSnapshotStoreOptions = {}) {
    this.#kv = (options.openKv ?? Deno.openKv)(path);
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
      .filter((key) => key[key.length - 1] !== LATEST_KEY);
    const staleKeys = snapshotKeysToTrim(
      existingKeys,
      this.#maxSnapshotsPerFeature,
    );

    // The cap is a hard bound, not a one-way switch (chrome-status-lite-579,
    // -6kk). First captures serialize on the FEATURE_COUNT_KEY versionstamp:
    // below the cap the commit increments it; at the cap the commit evicts
    // the least-recently-used feature (all its snapshot keys, latest pointer
    // and marker) and leaves the count unchanged - every successful commit
    // either adds one marker or swaps one, so bursts cannot ratchet the
    // index. A commit that loses the race fails its check (ok: false) and
    // retries against a fresh scan; contention beyond MAX_EVICTION_ATTEMPTS
    // degrades to an observable drop. Victim snapshot keys are listed before
    // the commit, so a victim recaptured mid-eviction can leave up to the
    // per-feature cap of orphaned keys with no marker; the next eviction of
    // a recaptured marker cleans them.
    for (let attempt = 1; ; attempt++) {
      const ownMarker = await kv.get([FEATURE_INDEX_KEY, featureId]);
      let victim: { featureId: string; key: Deno.KvKey; at: string } | null = null;
      let counter: Deno.KvEntryMaybe<number> | null = null;
      let count = 0;
      if (ownMarker.value === null) {
        counter = await kv.get<number>([FEATURE_COUNT_KEY]);
        let entries: Deno.KvEntryMaybe<unknown>[] | null = null;
        count = typeof counter.value === "number"
          ? counter.value
          // Bootstrap for pre-counter indexes: derive the count once from
          // the markers themselves.
          : (entries = await Array.fromAsync(
            kv.list({ prefix: [FEATURE_INDEX_KEY] }, { batchSize: 500 }),
          )).length;
        if (count >= this.#maxTrackedFeatures) {
          entries ??= await Array.fromAsync(
            kv.list({ prefix: [FEATURE_INDEX_KEY] }, { batchSize: 500 }),
          );
          for (const entry of entries) {
            const at = typeof (entry.value as any)?.lastCaptureAt === "string"
              ? (entry.value as any).lastCaptureAt
              : ""; // legacy `true` markers evict first
            if (!victim || at < victim.at) {
              victim = {
                featureId: String(entry.key[entry.key.length - 1]),
                key: entry.key,
                at,
              };
            }
          }
        }
      }

      const op = kv.atomic()
        .set(["feature", featureId, snapshot.at], snapshot)
        .set(["feature", featureId, LATEST_KEY], snapshot)
        .set([FEATURE_INDEX_KEY, featureId], { lastCaptureAt: snapshot.at });
      for (const key of staleKeys) op.delete(key);
      if (ownMarker.value !== null) {
        // Guard against a concurrent eviction of THIS feature
        // (chrome-status-lite-r83): if our marker was changed or deleted
        // since we read it, the commit fails and the retry re-enters
        // through the first-capture path, which accounts for the marker
        // against feature_count. Without this check a re-captured victim
        // resurrects its marker after eviction and the index stays
        // permanently over the cap.
        op.check({
          key: [FEATURE_INDEX_KEY, featureId],
          versionstamp: ownMarker.versionstamp,
        });
      }
      if (ownMarker.value === null && counter) {
        op.check({ key: [FEATURE_COUNT_KEY], versionstamp: counter.versionstamp });
        if (victim) {
          for (const e of await Array.fromAsync(
            kv.list({ prefix: ["feature", victim.featureId] }),
          )) {
            op.delete(e.key);
          }
          op.delete(victim.key);
          op.set([FEATURE_COUNT_KEY], count); // swap: net zero
        } else {
          op.set([FEATURE_COUNT_KEY], count + 1);
        }
      }
      const res = await op.commit();
      if (res.ok) {
        if (victim) {
          console.warn(JSON.stringify({
            event: "snapshot_feature_evicted",
            reason: "tracked_feature_cap",
            evictedFeatureId: victim.featureId,
            lastCaptureAt: victim.at,
            maxTrackedFeatures: this.#maxTrackedFeatures,
          }));
        }
        return true;
      }
      if (attempt >= MAX_EVICTION_ATTEMPTS) {
        console.warn(JSON.stringify({
          event: "snapshot_capture_dropped",
          reason: "index_contention",
          featureId,
          maxTrackedFeatures: this.#maxTrackedFeatures,
        }));
        return false;
      }
    }
  }

  async touch(featureId: string, now = new Date()): Promise<void> {
    const kv = await this.#kv;
    const key = [FEATURE_INDEX_KEY, featureId];
    const res = await kv.get<{ lastCaptureAt?: unknown }>(key);
    if (res.value === null) return; // never captured: nothing to refresh
    const last = typeof res.value?.lastCaptureAt === "string"
      ? res.value.lastCaptureAt
      : "";
    const nowMs = now.getTime();
    if (nowMs - Date.parse(last) < RECENCY_TOUCH_MIN_INTERVAL_MS) return;
    // .check(res) so a concurrent touch/add doesn't get clobbered: a failed
    // check just means someone else refreshed the marker, which is the same
    // outcome, so the result is deliberately ignored.
    await kv.atomic().check(res).set(key, {
      lastCaptureAt: now.toISOString(),
    }).commit();
  }
}

/** In-memory store for tests and store-less environments. */
export class MemorySnapshotStore implements SnapshotStore {
  #byFeature = new Map<string, FeatureSnapshot[]>();
  #lastRead = new Map<string, number>();
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
      // Same reclaim story as the KV store: evict the least-recently-used
      // feature. Recency is the later of the newest capture (arrays are
      // kept sorted ascending) and the last touch(), so a frequently read
      // but stable feature is not evicted ahead of a stale one (4x3).
      let oldest: string | null = null;
      let oldestAt = "";
      for (const [id, snaps] of this.#byFeature) {
        const captured = snaps[snaps.length - 1]?.at ?? "";
        const read = this.#lastRead.get(id);
        const at = read !== undefined && read > Date.parse(captured || "0")
          ? new Date(read).toISOString()
          : captured;
        if (!oldest || at < oldestAt) {
          oldest = id;
          oldestAt = at;
        }
      }
      if (oldest !== null) {
        this.#byFeature.delete(oldest);
        this.#lastRead.delete(oldest);
      }
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

  async touch(featureId: string, now = new Date()): Promise<void> {
    if (!this.#byFeature.has(featureId)) return;
    const nowMs = now.getTime();
    const last = this.#lastRead.get(featureId) ?? 0;
    if (nowMs - last < RECENCY_TOUCH_MIN_INTERVAL_MS) return;
    this.#lastRead.set(featureId, nowMs);
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
    // Unchanged: no snapshot, but refresh recency so retention eviction
    // follows last-read, not last-change (chrome-status-lite-4x3).
    await store.touch?.(featureId, now);
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
