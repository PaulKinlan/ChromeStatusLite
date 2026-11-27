-- ChromeStatusLite D1 schema: feature snapshot history + topic wiki cache.

-- Tracked feature index: stores each tracked feature's recency timestamp for
-- bounded O(log N) LRU eviction at MAX_TRACKED_FEATURES, plus its latest
-- snapshot for O(1) dedupe checks on GET /feature/:id.
CREATE TABLE IF NOT EXISTS feature_index (
  feature_id TEXT PRIMARY KEY,
  last_read_at TEXT NOT NULL,
  latest_at TEXT NOT NULL,
  latest_data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feature_index_last_read
  ON feature_index(last_read_at ASC, feature_id ASC);

-- Per-feature snapshot history, bounded at MAX_SNAPSHOTS_PER_FEATURE newest
-- captures ordered by ISO captured_at timestamp.
CREATE TABLE IF NOT EXISTS feature_snapshots (
  feature_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (feature_id, captured_at),
  FOREIGN KEY (feature_id) REFERENCES feature_index(feature_id) ON DELETE CASCADE
);

-- Pre-warmed /wiki topic inventory refreshed incrementally by the Cron Trigger
-- (and on-demand on single-topic misses) so /wiki stays within Cloudflare
-- Workers Free plan external subrequest limits.
CREATE TABLE IF NOT EXISTS wiki_topic_cache (
  slug TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  complete INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
