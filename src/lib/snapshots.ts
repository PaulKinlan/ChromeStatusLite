// Feature snapshot history: a slim per-feature snapshot is captured whenever a
// reader views /feature/:id and its tracked fields differ from the newest
// stored snapshot. Capture is lazy (no cron): history grows with real reader
// traffic, keeping upstream API load and storage cost proportional to
// attention.

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
   * Only the newest snapshot, if any. Stores may implement this in O(1);
   * captureSnapshot falls back to list() when a store does not provide it.
   */
  latest?(featureId: string): Promise<FeatureSnapshot | undefined>;
  /**
   * Refresh a feature's recency without appending a snapshot, so retention
   * eviction follows "last read", not "last data change"
   * (chrome-status-lite-4x3). Implementations throttle internally.
   */
  touch?(featureId: string, now?: Date): Promise<void>;
}

/** Write-side retention bounds (chrome-status-lite-4g8). Capture is an
 * unauthenticated write path driven by anonymous reads, so nothing upstream
 * bounds growth: keep only the newest snapshots per feature and cap the
 * number of distinct captured features. */
export const MAX_SNAPSHOTS_PER_FEATURE = 25;
export const MAX_TRACKED_FEATURES = 5000;

/** Minimum interval between recency-refresh writes for one feature (24h). */
export const RECENCY_TOUCH_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type SnapshotStoreOptions = {
  maxSnapshotsPerFeature?: number;
  maxTrackedFeatures?: number;
  /** Diagnostics sink for eviction events (JSON-encoded). Defaults to console.warn. */
  warn?: (message: string) => void;
};

/**
 * Cloudflare D1 (serverless SQLite)-backed snapshot store.
 *
 * Uses indexed SQLite queries and atomic `db.batch()` transactions:
 * - `latest()` is a single primary-key lookup on `feature_index`.
 * - `list()` reads at most `maxSnapshotsPerFeature` rows ordered by `captured_at DESC`.
 * - `touch()` enforces the 24h throttle atomically inside a single `UPDATE ... WHERE`.
 * - `add()` atomically upserts the index + snapshot, trims oldest per-feature
 *   captures by timestamp, and enforces the `maxTrackedFeatures` LRU cap with
 *   no orphan rows even under concurrent bursts.
 */
export class D1SnapshotStore implements SnapshotStore {
  readonly #db: D1Database;
  readonly #maxSnapshotsPerFeature: number;
  readonly #maxTrackedFeatures: number;
  readonly #warn: (message: string) => void;

  constructor(db: D1Database, options: SnapshotStoreOptions = {}) {
    this.#db = db;
    this.#maxSnapshotsPerFeature =
      options.maxSnapshotsPerFeature ?? MAX_SNAPSHOTS_PER_FEATURE;
    this.#maxTrackedFeatures =
      options.maxTrackedFeatures ?? MAX_TRACKED_FEATURES;
    this.#warn = options.warn ?? ((message) => console.warn(message));
  }

  async list(featureId: string): Promise<FeatureSnapshot[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT captured_at, data
         FROM feature_snapshots
         WHERE feature_id = ?
         ORDER BY captured_at DESC`,
      )
      .bind(featureId)
      .all<{ captured_at: string; data: string }>();

    return results.map((row) => ({
      at: row.captured_at,
      data: JSON.parse(row.data) as Record<string, string>,
    }));
  }

  async latest(featureId: string): Promise<FeatureSnapshot | undefined> {
    const row = await this.#db
      .prepare(
        `SELECT latest_at, latest_data
         FROM feature_index
         WHERE feature_id = ?`,
      )
      .bind(featureId)
      .first<{ latest_at: string; latest_data: string }>();

    if (!row) return undefined;
    return {
      at: row.latest_at,
      data: JSON.parse(row.latest_data) as Record<string, string>,
    };
  }

  async add(featureId: string, snapshot: FeatureSnapshot): Promise<boolean> {
    const serialized = JSON.stringify(snapshot.data);

    // Check whether this feature is already tracked; if not and the index is
    // at capacity, identify the least-recently-used victim via the index on
    // (last_read_at ASC, feature_id ASC) so eviction is O(log N) and emits a
    // structured diagnostic event.
    const existing = await this.#db
      .prepare(`SELECT feature_id FROM feature_index WHERE feature_id = ?`)
      .bind(featureId)
      .first<{ feature_id: string }>();

    let victim: { feature_id: string; last_read_at: string } | null = null;
    if (!existing) {
      const countRow = await this.#db
        .prepare(`SELECT COUNT(*) AS count FROM feature_index`)
        .first<{ count: number }>();
      const count = Number(countRow?.count ?? 0);
      if (count >= this.#maxTrackedFeatures) {
        victim = await this.#db
          .prepare(
            `SELECT feature_id, last_read_at
             FROM feature_index
             WHERE feature_id != ?
             ORDER BY last_read_at ASC, feature_id ASC
             LIMIT 1`,
          )
          .bind(featureId)
          .first<{ feature_id: string; last_read_at: string }>();
      }
    }

    const statements: D1PreparedStatement[] = [];

    if (victim) {
      statements.push(
        this.#db
          .prepare(`DELETE FROM feature_snapshots WHERE feature_id = ?`)
          .bind(victim.feature_id),
        this.#db
          .prepare(`DELETE FROM feature_index WHERE feature_id = ?`)
          .bind(victim.feature_id),
      );
    }

    // Upsert feature_index first so the foreign key on feature_snapshots is
    // always satisfied. Keep the newest timestamp for latest_at/latest_data so
    // backdated snapshots never overwrite newer state.
    statements.push(
      this.#db
        .prepare(
          `INSERT INTO feature_index (feature_id, last_read_at, latest_at, latest_data)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(feature_id) DO UPDATE SET
             last_read_at = CASE
               WHEN excluded.last_read_at > feature_index.last_read_at
               THEN excluded.last_read_at
               ELSE feature_index.last_read_at
             END,
             latest_at = CASE
               WHEN excluded.latest_at >= feature_index.latest_at
               THEN excluded.latest_at
               ELSE feature_index.latest_at
             END,
             latest_data = CASE
               WHEN excluded.latest_at >= feature_index.latest_at
               THEN excluded.latest_data
               ELSE feature_index.latest_data
             END`,
        )
        .bind(featureId, snapshot.at, snapshot.at, serialized),
      this.#db
        .prepare(
          `INSERT OR REPLACE INTO feature_snapshots (feature_id, captured_at, data)
           VALUES (?, ?, ?)`,
        )
        .bind(featureId, snapshot.at, serialized),
      // Trim per-feature snapshots to the newest `maxSnapshotsPerFeature` by
      // ISO timestamp (never insertion order).
      this.#db
        .prepare(
          `DELETE FROM feature_snapshots
           WHERE feature_id = ?
             AND captured_at NOT IN (
               SELECT captured_at
               FROM feature_snapshots
               WHERE feature_id = ?
               ORDER BY captured_at DESC
               LIMIT ?
             )`,
        )
        .bind(featureId, featureId, this.#maxSnapshotsPerFeature),
      // Atomic cap safety net: if concurrent first-captures raced past the
      // count check above, evict any excess oldest features (and their
      // snapshots) inside the same SQLite transaction so the cap never
      // ratchets and no orphan snapshot rows survive.
      this.#db
        .prepare(
          `DELETE FROM feature_snapshots
           WHERE feature_id IN (
             SELECT feature_id
             FROM feature_index
             WHERE feature_id != ?
             ORDER BY last_read_at ASC, feature_id ASC
             LIMIT MAX(0, (SELECT COUNT(*) FROM feature_index) - ?)
           )`,
        )
        .bind(featureId, this.#maxTrackedFeatures),
      this.#db
        .prepare(
          `DELETE FROM feature_index
           WHERE feature_id IN (
             SELECT feature_id
             FROM feature_index
             WHERE feature_id != ?
             ORDER BY last_read_at ASC, feature_id ASC
             LIMIT MAX(0, (SELECT COUNT(*) FROM feature_index) - ?)
           )`,
        )
        .bind(featureId, this.#maxTrackedFeatures),
    );

    await this.#db.batch(statements);

    if (victim) {
      this.#warn(
        JSON.stringify({
          event: "snapshot_feature_evicted",
          reason: "tracked_feature_cap",
          evictedFeatureId: victim.feature_id,
          lastCaptureAt: victim.last_read_at,
          maxTrackedFeatures: this.#maxTrackedFeatures,
        }),
      );
    }

    return true;
  }

  async touch(featureId: string, now = new Date()): Promise<void> {
    const cutoff = new Date(
      now.getTime() - RECENCY_TOUCH_MIN_INTERVAL_MS,
    ).toISOString();
    await this.#db
      .prepare(
        `UPDATE feature_index
         SET last_read_at = ?
         WHERE feature_id = ? AND last_read_at <= ?`,
      )
      .bind(now.toISOString(), featureId, cutoff)
      .run();
  }
}

/** In-memory store for tests and store-less environments. */
export class MemorySnapshotStore implements SnapshotStore {
  #byFeature = new Map<string, FeatureSnapshot[]>();
  #lastRead = new Map<string, number>();
  #maxSnapshotsPerFeature: number;
  #maxTrackedFeatures: number;

  constructor(options: SnapshotStoreOptions = {}) {
    this.#maxSnapshotsPerFeature =
      options.maxSnapshotsPerFeature ?? MAX_SNAPSHOTS_PER_FEATURE;
    this.#maxTrackedFeatures =
      options.maxTrackedFeatures ?? MAX_TRACKED_FEATURES;
  }

  async list(featureId: string): Promise<FeatureSnapshot[]> {
    return [...(this.#byFeature.get(featureId) ?? [])].sort((a, b) =>
      b.at.localeCompare(a.at)
    );
  }

  async add(featureId: string, snapshot: FeatureSnapshot): Promise<boolean> {
    if (
      !this.#byFeature.has(featureId) &&
      this.#byFeature.size >= this.#maxTrackedFeatures
    ) {
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
    if (view?.url) {
      data[label] = `${data[label] ? data[label] + " " : ""}${view.url}`;
    }
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
  const newest = store.latest
    ? await store.latest(featureId)
    : (await store.list(featureId))[0];
  if (newest && JSON.stringify(newest.data) === JSON.stringify(data)) {
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
