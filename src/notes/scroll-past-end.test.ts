import { describe, expect, it } from "vitest";
import { scrollPastEndPadding } from "./scroll-past-end";

describe("scrollPastEndPadding", () => {
  it("computes clientHeight - paddingTop - 2 * lineHeight when that exceeds the base padding", () => {
    // Roughly the notes editor's real numbers: a tall panel, a normal line
    // height and the panel's own 0.6rem (9.6px) padding.
    expect(scrollPastEndPadding(689, 22, 9.6)).toBeCloseTo(689 - 9.6 - 44, 5);
  });

  it("scales linearly with clientHeight", () => {
    const base = scrollPastEndPadding(700, 20, 10);
    const doubled = scrollPastEndPadding(1400, 20, 10);
    // Only the clientHeight term scales; the other two stay fixed, so the
    // difference between the two results is exactly the extra clientHeight.
    expect(doubled - base).toBeCloseTo(700, 5);
  });

  it("falls back to paddingTop when the formula would go negative", () => {
    // A short panel: 2 lines' worth of height barely exceeds the padding, so
    // there is no real risk of a last line landing off the clamped ceiling.
    expect(scrollPastEndPadding(40, 22, 9.6)).toBe(9.6);
  });

  it("never returns less than paddingTop, right at the crossover point", () => {
    // clientHeight chosen so the formula evaluates to exactly paddingTop.
    const paddingTop = 10;
    const lineHeight = 20;
    const clientHeight = 2 * paddingTop + 2 * lineHeight; // needed === paddingTop
    expect(scrollPastEndPadding(clientHeight, lineHeight, paddingTop)).toBe(
      paddingTop,
    );
    expect(scrollPastEndPadding(clientHeight - 1, lineHeight, paddingTop)).toBe(
      paddingTop,
    );
    expect(
      scrollPastEndPadding(clientHeight + 1, lineHeight, paddingTop),
    ).toBeGreaterThan(paddingTop);
  });

  it("treats a non-finite or non-positive lineHeight as unmeasurable", () => {
    expect(scrollPastEndPadding(689, 0, 9.6)).toBe(9.6);
    expect(scrollPastEndPadding(689, -5, 9.6)).toBe(9.6);
    expect(scrollPastEndPadding(689, Number.NaN, 9.6)).toBe(9.6);
  });

  it("treats a non-finite clientHeight as unmeasurable", () => {
    expect(scrollPastEndPadding(Number.NaN, 22, 9.6)).toBe(9.6);
    expect(scrollPastEndPadding(Number.POSITIVE_INFINITY, 22, 9.6)).toBe(9.6);
  });

  it("clamps a negative or non-finite paddingTop to zero rather than going negative", () => {
    expect(scrollPastEndPadding(689, 22, -10)).toBe(
      scrollPastEndPadding(689, 22, 0),
    );
    expect(scrollPastEndPadding(689, 22, Number.NaN)).toBe(
      scrollPastEndPadding(689, 22, 0),
    );
  });
});
