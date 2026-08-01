import { describe, expect, it } from "vitest";
import { PageRenderCache } from "./page-cache";

function canvas(): HTMLCanvasElement {
  const element = document.createElement("canvas");
  element.width = 10;
  element.height = 10;
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
});
