import { describe, expect, it, vi } from "vitest";
import { LruCache } from "./lru-cache";

describe("LruCache", () => {
  it("rejects a non-positive capacity", () => {
    expect(() => new LruCache<string, number>(0)).toThrow(RangeError);
    expect(() => new LruCache<string, number>(-1)).toThrow(RangeError);
    expect(() => new LruCache<string, number>(1.5)).toThrow(RangeError);
  });

  it("returns undefined for a missing key", () => {
    const cache = new LruCache<string, number>(2);
    expect(cache.get("missing")).toBeUndefined();
    expect(cache.has("missing")).toBe(false);
  });

  it("stores and returns values up to its capacity", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);

    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(2);
    expect(cache.size).toBe(2);
  });

  it("evicts the least recently used entry when full", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);

    expect(cache.has("a")).toBe(false);
    expect(cache.keys()).toEqual(["b", "c"]);
  });

  it("counts a read as a use, protecting the entry from eviction", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);

    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
  });

  it("overwrites an existing key without growing and evicts the old value", () => {
    const onEvict = vi.fn();
    const cache = new LruCache<string, number>(2, onEvict);
    cache.set("a", 1);
    cache.set("a", 9);

    expect(cache.size).toBe(1);
    expect(cache.get("a")).toBe(9);
    expect(onEvict).toHaveBeenCalledWith("a", 1);
  });

  it("does not report eviction when the same value is re-set", () => {
    const onEvict = vi.fn();
    const cache = new LruCache<string, number>(2, onEvict);
    cache.set("a", 1);
    cache.set("a", 1);

    expect(onEvict).not.toHaveBeenCalled();
  });

  it("notifies onEvict for every entry dropped by capacity, delete and clear", () => {
    const evicted: Array<[string, number]> = [];
    const cache = new LruCache<string, number>(1, (k, v) =>
      evicted.push([k, v]),
    );

    cache.set("a", 1);
    cache.set("b", 2); // evicts a
    cache.delete("b");
    cache.set("c", 3);
    cache.clear();

    expect(evicted).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    expect(cache.size).toBe(0);
  });

  it("reports whether delete removed anything", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);

    expect(cache.delete("a")).toBe(true);
    expect(cache.delete("a")).toBe(false);
  });
});
