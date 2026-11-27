// Minimal, zero-dependency TTL + LRU cache backed by ES Map insertion order.
// Stores plain JS values only (never Request/Response streams or pending
// Promises), so a module-level instance is safe to share across requests in
// Cloudflare Workers isolates as an L1 cache.

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export interface CacheLike<K = string, V = unknown> {
  get(key: K): V | undefined;
  set(key: K, value: V, maxAge?: number): unknown;
  del?(key: K): void;
}

export class TTLCache<K, V> implements CacheLike<K, V> {
  readonly #entries = new Map<K, Entry<V>>();
  readonly #max: number;
  readonly #maxAge: number;
  readonly #now: () => number;

  constructor(options: { max: number; maxAge: number; now?: () => number }) {
    this.#max = Math.max(1, options.max);
    this.#maxAge = options.maxAge;
    this.#now = options.now ?? Date.now;
  }

  get(key: K): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (this.#now() >= entry.expiresAt) {
      this.#entries.delete(key);
      return undefined;
    }
    // Refresh recency (LRU): delete and re-insert at the tail of the Map.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, maxAge = this.#maxAge): this {
    if (this.#entries.has(key)) {
      this.#entries.delete(key);
    } else if (this.#entries.size >= this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    this.#entries.set(key, {
      value,
      expiresAt: this.#now() + maxAge,
    });
    return this;
  }

  del(key: K): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }
}
