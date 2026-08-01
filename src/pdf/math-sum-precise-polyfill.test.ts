import { describe, expect, it } from "vitest";

import "./math-sum-precise-polyfill";

describe("math-sum-precise-polyfill", () => {
  it("leaves Math.sumPrecise callable and correct", () => {
    expect(typeof Math.sumPrecise).toBe("function");
    // Whether this is ours or the engine's, pdf.js needs the same answer.
    expect(Math.sumPrecise?.([0.1, 0.2])).toBe(0.30000000000000004);
    expect(Math.sumPrecise?.([1e16, 1, -1e16])).toBe(1);
  });

  it("does not show up when enumerating Math", () => {
    expect(Object.keys(Math)).not.toContain("sumPrecise");
  });
});
