import { describe, expect, it } from "vitest";

import "./index";

describe("pdf.js polyfills", () => {
  it("leaves Math.sumPrecise callable and correct", () => {
    expect(typeof Math.sumPrecise).toBe("function");
    // Whether this is ours or the engine's, pdf.js needs the same answer.
    expect(Math.sumPrecise?.([0.1, 0.2])).toBe(0.30000000000000004);
    expect(Math.sumPrecise?.([1e16, 1, -1e16])).toBe(1);
  });

  it("leaves getOrInsertComputed callable on Map and WeakMap", () => {
    const map = new Map<string, number>();
    expect(map.getOrInsertComputed?.("a", () => 1)).toBe(1);
    expect(map.getOrInsertComputed?.("a", () => 2)).toBe(1);

    const key = {};
    const weak = new WeakMap<object, number>();
    expect(weak.getOrInsertComputed?.(key, () => 1)).toBe(1);
    expect(weak.getOrInsertComputed?.(key, () => 2)).toBe(1);
  });

  it("leaves getOrInsert callable on Map and WeakMap", () => {
    const map = new Map<string, number>();
    expect(map.getOrInsert?.("a", 1)).toBe(1);
    expect(map.getOrInsert?.("a", 2)).toBe(1);

    const key = {};
    const weak = new WeakMap<object, number>();
    expect(weak.getOrInsert?.(key, 1)).toBe(1);
    expect(weak.getOrInsert?.(key, 2)).toBe(1);
  });

  it("does not make the patched builtins enumerable", () => {
    expect(Object.keys(Math)).not.toContain("sumPrecise");
    expect(Object.keys(Map.prototype)).toHaveLength(0);
    expect(Object.keys(WeakMap.prototype)).toHaveLength(0);
    // A `for...in` over an instance must not surface them either.
    const enumerated: string[] = [];
    for (const key in new Map()) enumerated.push(key);
    expect(enumerated).toHaveLength(0);
  });
});
