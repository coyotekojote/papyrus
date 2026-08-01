import { describe, expect, it, vi } from "vitest";

import { getOrInsert, getOrInsertComputed } from "./get-or-insert";

describe("getOrInsert", () => {
  it("inserts and returns the value when the key is absent", () => {
    const map = new Map<string, number>();
    expect(getOrInsert(map, "a", 1)).toBe(1);
    expect(map.get("a")).toBe(1);
  });

  it("keeps the existing value when the key is present", () => {
    const map = new Map([["a", 1]]);
    expect(getOrInsert(map, "a", 2)).toBe(1);
    expect(map.get("a")).toBe(1);
  });

  it("treats a stored undefined as present", () => {
    const map = new Map<string, number | undefined>([["a", undefined]]);
    expect(getOrInsert(map, "a", 2)).toBeUndefined();
    expect(map.size).toBe(1);
  });

  it("works on a WeakMap", () => {
    const key = {};
    const map = new WeakMap<object, number>();
    expect(getOrInsert(map, key, 1)).toBe(1);
    expect(getOrInsert(map, key, 2)).toBe(1);
  });
});

describe("getOrInsertComputed", () => {
  it("computes, inserts and returns the value when the key is absent", () => {
    const map = new Map<string, string>();
    expect(getOrInsertComputed(map, "a", (key) => `${key}!`)).toBe("a!");
    expect(map.get("a")).toBe("a!");
  });

  it("does not call the callback when the key is present", () => {
    const map = new Map([["a", 1]]);
    const callback = vi.fn(() => 2);
    expect(getOrInsertComputed(map, "a", callback)).toBe(1);
    expect(callback).not.toHaveBeenCalled();
  });

  it("treats a stored undefined as present", () => {
    const map = new Map<string, number | undefined>([["a", undefined]]);
    const callback = vi.fn(() => 2);
    expect(getOrInsertComputed(map, "a", callback)).toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
  });

  it("lets the computed value win over one the callback inserted", () => {
    const map = new Map<string, number>();
    const value = getOrInsertComputed(map, "a", () => {
      map.set("a", 99);
      return 1;
    });
    expect(value).toBe(1);
    expect(map.get("a")).toBe(1);
  });

  it("does not insert when the callback throws", () => {
    const map = new Map<string, number>();
    expect(() =>
      getOrInsertComputed(map, "a", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(map.has("a")).toBe(false);
  });

  it("works on a WeakMap", () => {
    const key = {};
    const map = new WeakMap<object, number>();
    expect(getOrInsertComputed(map, key, () => 1)).toBe(1);
    expect(getOrInsertComputed(map, key, () => 2)).toBe(1);
  });
});
