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
  /** Append a snapshot for a feature. */
  add(featureId: string, snapshot: FeatureSnapshot): Promise<void>;
  /**
   * Only the newest snapshot, if any. Stores may implement this in O(1)
   * (a KV prefix read with limit 1); captureSnapshot falls back to
   * list() when a store does not provide it.
   */
  latest?(featureId: string): Promise<FeatureSnapshot | undefined>;
}

/** Deno KV-backed store; KV is GA on Deno Deploy and Deno 2.x locally. */
export class KvSnapshotStore implements SnapshotStore {
  #kv: Promise<Deno.Kv>;

  constructor(path?: string) {
    this.#kv = Deno.openKv(path);
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
      .map((e) => e.value)
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  async latest(featureId: string): Promise<FeatureSnapshot | undefined> {
    const kv = await this.#kv;
    for await (const entry of kv.list<FeatureSnapshot>({
      prefix: ["feature", featureId],
      reverse: true,
      limit: 1,
    })) {
      return entry.value;
    }
    return undefined;
  }

  async add(featureId: string, snapshot: FeatureSnapshot): Promise<void> {
    const kv = await this.#kv;
    await kv.set(["feature", featureId, snapshot.at], snapshot);
  }
}

/** In-memory store for tests and store-less environments. */
export class MemorySnapshotStore implements SnapshotStore {
  #byFeature = new Map<string, FeatureSnapshot[]>();

  async list(featureId: string): Promise<FeatureSnapshot[]> {
    return [...(this.#byFeature.get(featureId) ?? [])]
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  async add(featureId: string, snapshot: FeatureSnapshot): Promise<void> {
    const all = this.#byFeature.get(featureId) ?? [];
    all.push(snapshot);
    this.#byFeature.set(featureId, all);
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
  await store.add(featureId, { at: now.toISOString(), data });
  return true;
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
