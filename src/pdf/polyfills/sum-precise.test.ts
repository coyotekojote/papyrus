import { describe, expect, it } from "vitest";

import { sumPrecise } from "./sum-precise";

describe("sumPrecise", () => {
  it("sums exact integers", () => {
    expect(sumPrecise([1, 2, 3])).toBe(6);
    expect(sumPrecise([42])).toBe(42);
  });

  it("rounds once, not per addend", () => {
    // 0.1 + 0.2 has a single correctly rounded double, and it is not 0.3.
    expect(sumPrecise([0.1, 0.2])).toBe(0.30000000000000004);
    // Naively this drifts to 99.9999999999986; the exact sum rounds to 100.
    expect(sumPrecise(Array<number>(1000).fill(0.1))).toBe(100);
  });

  it("keeps bits a naive sum cancels away", () => {
    // 1e16 + 1 rounds back to 1e16, so a left-to-right sum returns 0.
    expect(sumPrecise([1e16, 1, -1e16])).toBe(1);
    expect(sumPrecise([1e100, 1, -1e100, -1])).toBe(0);
    expect(sumPrecise([1, 1e100, 1, -1e100])).toBe(2);
  });

  it("sums an empty iterable to -0", () => {
    expect(Object.is(sumPrecise([]), -0)).toBe(true);
  });

  it("preserves -0 only when every value is -0", () => {
    expect(Object.is(sumPrecise([-0]), -0)).toBe(true);
    expect(Object.is(sumPrecise([-0, -0]), -0)).toBe(true);
    expect(Object.is(sumPrecise([-0, 0]), 0)).toBe(true);
    expect(Object.is(sumPrecise([1, -1]), 0)).toBe(true);
  });

  it("propagates NaN", () => {
    expect(sumPrecise([1, NaN, 2])).toBeNaN();
    expect(sumPrecise([NaN, Infinity])).toBeNaN();
  });

  it("handles infinities", () => {
    expect(sumPrecise([1, Infinity])).toBe(Infinity);
    expect(sumPrecise([1, -Infinity])).toBe(-Infinity);
    // Opposite infinities are indeterminate, whatever the finite terms say.
    expect(sumPrecise([Infinity, -Infinity])).toBeNaN();
    expect(sumPrecise([Infinity, 1, -Infinity])).toBeNaN();
  });

  it("accepts any iterable, not just arrays", () => {
    expect(sumPrecise(new Set([1, 2, 3]))).toBe(6);
    expect(
      sumPrecise(
        (function* () {
          yield 0.1;
          yield 0.2;
        })(),
      ),
    ).toBe(0.30000000000000004);
  });

  it("rejects non-numeric values", () => {
    // @ts-expect-error -- the guard exists for untyped callers such as pdf.js.
    expect(() => sumPrecise([1, "2"])).toThrow(TypeError);
    // @ts-expect-error -- same.
    expect(() => sumPrecise([null])).toThrow(TypeError);
  });
});
