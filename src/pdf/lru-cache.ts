/**
 * Minimal LRU cache. Used to keep recently rendered page canvases around so
 * scrolling back a few pages does not pay for a re-render.
 */
export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(
    readonly capacity: number,
    /** Called for every entry dropped by eviction, `set` overwrite, or `clear`. */
    private readonly onEvict?: (key: K, value: V) => void,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(
        `capacity must be a positive integer, got ${capacity}`,
      );
    }
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  /** Returns the value and marks it as most recently used. */
  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /** Like {@link get}, but does not mark the entry as recently used — for a
   * caller that only wants to look, not touch (a mere existence/staleness
   * check must not push some other, genuinely-in-use entry towards eviction
   * on its behalf). */
  peek(key: K): V | undefined {
    return this.entries.get(key);
  }

  set(key: K, value: V): void {
    const previous = this.entries.get(key);
    if (this.entries.delete(key) && previous !== value) {
      this.onEvict?.(key, previous as V);
    }
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const evicted = this.entries.get(oldest.value) as V;
      this.entries.delete(oldest.value);
      this.onEvict?.(oldest.value, evicted);
    }
  }

  delete(key: K): boolean {
    const value = this.entries.get(key);
    const existed = this.entries.delete(key);
    if (existed) this.onEvict?.(key, value as V);
    return existed;
  }

  clear(): void {
    for (const [key, value] of this.entries) this.onEvict?.(key, value);
    this.entries.clear();
  }

  /** Keys ordered least-recently-used first. */
  keys(): K[] {
    return [...this.entries.keys()];
  }
}
