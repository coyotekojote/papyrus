import { describe, expect, it } from "vitest";
import { PageRenderCache } from "./page-cache";

function canvas(width = 10, height = 10): HTMLCanvasElement {
  const element = document.createElement("canvas");
  element.width = width;
  element.height = height;
  return element;
}

describe("PageRenderCache", () => {
  it("returns undefined for a page that was never rendered", () => {
    expect(new PageRenderCache().get(1, 1)).toBeUndefined();
  });

  it("returns the canvas rendered at the same scale", () => {
    const cache = new PageRenderCache();
    const page = canvas();
    cache.set(3, 1.5, page);

    expect(cache.get(3, 1.5)).toBe(page);
  });

  it("misses and drops the entry when the scale has changed", () => {
    const cache = new PageRenderCache();
    cache.set(3, 1, canvas());

    expect(cache.get(3, 2)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the least recently used page beyond its capacity", () => {
    const cache = new PageRenderCache(2);
    const first = canvas();
    cache.set(1, 1, first);
    cache.set(2, 1, canvas());
    cache.set(3, 1, canvas());

    expect(cache.get(1, 1)).toBeUndefined();
    expect(cache.get(2, 1)).toBeDefined();
    expect(cache.get(3, 1)).toBeDefined();
  });

  it("frees the backing store of evicted canvases", () => {
    const cache = new PageRenderCache(1);
    const evicted = canvas();
    cache.set(1, 1, evicted);
    cache.set(2, 1, canvas());

    expect(evicted.width).toBe(0);
    expect(evicted.height).toBe(0);
  });

  it("empties itself on clear", () => {
    const cache = new PageRenderCache();
    cache.set(1, 1, canvas());
    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get(1, 1)).toBeUndefined();
  });

  describe("has", () => {
    it("returns false for a page that was never rendered", () => {
      expect(new PageRenderCache().has(1, 1)).toBe(false);
    });

    it("returns true for a page cached at the same scale", () => {
      const cache = new PageRenderCache();
      cache.set(3, 1.5, canvas());

      expect(cache.has(3, 1.5)).toBe(true);
    });

    it("returns false for a stale scale, without evicting the entry", () => {
      const cache = new PageRenderCache();
      cache.set(3, 1, canvas());

      expect(cache.has(3, 2)).toBe(false);
      // Unlike `get`, a stale-scale `has` is read-only: the entry (at its
      // original scale) is still there afterwards.
      expect(cache.size).toBe(1);
      expect(cache.has(3, 1)).toBe(true);
    });

    it("does not change eviction order the way get() does", () => {
      const cache = new PageRenderCache(2);
      cache.set(1, 1, canvas());
      cache.set(2, 1, canvas());

      // `get` would have promoted page 1 to most-recently-used; `has` must
      // not, so page 1 is still the one capacity eviction drops next.
      expect(cache.has(1, 1)).toBe(true);
      cache.set(3, 1, canvas());

      expect(cache.has(1, 1)).toBe(false);
      expect(cache.has(2, 1)).toBe(true);
      expect(cache.has(3, 1)).toBe(true);
    });
  });

  describe("pixel budget", () => {
    it("rejects a non-positive pixel budget", () => {
      expect(() => new PageRenderCache(12, 0)).toThrow(RangeError);
      expect(() => new PageRenderCache(12, -1)).toThrow(RangeError);
    });

    it("keeps every entry when the running total sits exactly at the budget", () => {
      // Capacity set high enough that only the pixel budget is in play.
      const cache = new PageRenderCache(10, 200);
      cache.set(1, 1, canvas(10, 10)); // 100px
      cache.set(2, 1, canvas(10, 10)); // 100px, total 200 = budget exactly

      expect(cache.pixels).toBe(200);
      expect(cache.get(1, 1)).toBeDefined();
      expect(cache.get(2, 1)).toBeDefined();
      expect(cache.size).toBe(2);
    });

    it("evicts the least recently used entry the moment the total exceeds the budget by even one pixel", () => {
      const cache = new PageRenderCache(10, 250);
      const first = canvas(10, 10); // 100px
      cache.set(1, 1, first);
      cache.set(2, 1, canvas(10, 10)); // 100px, total 200
      cache.set(3, 1, canvas(10, 10)); // 100px, total would be 300, over the 250 budget

      expect(cache.get(1, 1)).toBeUndefined();
      expect(first.width).toBe(0);
      expect(first.height).toBe(0);
      expect(cache.get(2, 1)).toBeDefined();
      expect(cache.get(3, 1)).toBeDefined();
      expect(cache.pixels).toBe(200);
    });

    it("keeps the most recent entry even alone it is well over budget", () => {
      const cache = new PageRenderCache(10, 100);
      const huge = canvas(1000, 1000); // 1,000,000px, vastly over budget
      cache.set(1, 1, huge);

      expect(cache.size).toBe(1);
      expect(cache.get(1, 1)).toBe(huge);
      expect(cache.pixels).toBe(1_000_000);
    });

    it("evicts older entries to make room once a huge page is inserted on top of them", () => {
      const cache = new PageRenderCache(10, 500);
      cache.set(1, 1, canvas(10, 10)); // 100px
      cache.set(2, 1, canvas(10, 10)); // 100px, total 200
      cache.set(3, 1, canvas(100, 100)); // 10,000px, way over budget alone

      expect(cache.get(1, 1)).toBeUndefined();
      expect(cache.get(2, 1)).toBeUndefined();
      expect(cache.get(3, 1)).toBeDefined();
      expect(cache.size).toBe(1);
      expect(cache.pixels).toBe(10_000);
    });

    it("does not double-count an overwritten key's pixels", () => {
      const cache = new PageRenderCache(10, 1_000_000);
      cache.set(1, 1, canvas(10, 10)); // 100px
      expect(cache.pixels).toBe(100);

      // Re-render page 1 at a new scale with a bigger canvas: the old 100px
      // must be subtracted, not left to accumulate alongside the new size.
      cache.set(1, 2, canvas(20, 20)); // 400px
      expect(cache.pixels).toBe(400);
      expect(cache.size).toBe(1);
    });

    it("keeps the total accurate across a page-count-driven eviction", () => {
      // Capacity is the binding constraint here, not the pixel budget.
      const cache = new PageRenderCache(2, 1_000_000);
      cache.set(1, 1, canvas(10, 10)); // 100px
      cache.set(2, 1, canvas(10, 10)); // 100px, total 200
      cache.set(3, 1, canvas(10, 10)); // evicts page 1, total stays 200

      expect(cache.size).toBe(2);
      expect(cache.pixels).toBe(200);
    });

    it("zeroes the running total on clear", () => {
      const cache = new PageRenderCache();
      cache.set(1, 1, canvas(10, 10));
      cache.clear();

      expect(cache.pixels).toBe(0);
    });
  });
});
