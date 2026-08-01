import { describe, expect, it } from "vitest";
import {
  computeLayout,
  layoutExtent,
  nearestItemIndex,
  rangeIncludes,
  scrollOffsetForItem,
  visibleRange,
} from "./virtualization";

describe("computeLayout", () => {
  it("returns nothing for no items", () => {
    expect(computeLayout([])).toEqual([]);
  });

  it("stacks items end to end without a gap", () => {
    expect(computeLayout([100, 200, 50])).toEqual([
      { offset: 0, size: 100 },
      { offset: 100, size: 200 },
      { offset: 300, size: 50 },
    ]);
  });

  it("inserts the gap between items but not before the first", () => {
    expect(computeLayout([100, 200], 20)).toEqual([
      { offset: 0, size: 100 },
      { offset: 120, size: 200 },
    ]);
  });
});

describe("layoutExtent", () => {
  it("is zero for an empty layout", () => {
    expect(layoutExtent([])).toBe(0);
  });

  it("excludes the trailing gap", () => {
    expect(layoutExtent(computeLayout([100, 200], 20))).toBe(320);
  });
});

describe("visibleRange", () => {
  const layout = computeLayout([100, 100, 100, 100, 100]); // offsets 0,100,...,400

  it("returns an empty range for an empty layout", () => {
    expect(visibleRange([], 0, 500)).toEqual({ start: 0, end: 0 });
  });

  it("returns only the visible item when overscan is 0", () => {
    expect(visibleRange(layout, 100, 100, 0)).toEqual({ start: 1, end: 2 });
  });

  it("includes every item the viewport straddles", () => {
    expect(visibleRange(layout, 50, 200, 0)).toEqual({ start: 0, end: 3 });
  });

  it("widens the range by the overscan on both sides", () => {
    expect(visibleRange(layout, 200, 100, 1)).toEqual({ start: 1, end: 4 });
  });

  it("clamps the overscan at the start and end of the layout", () => {
    expect(visibleRange(layout, 0, 100, 2)).toEqual({ start: 0, end: 3 });
    expect(visibleRange(layout, 400, 100, 2)).toEqual({ start: 2, end: 5 });
  });

  it("treats a negative scroll offset as the start", () => {
    expect(visibleRange(layout, -500, 100, 0)).toEqual({ start: 0, end: 1 });
  });

  it("never returns an empty range for a zero-size viewport", () => {
    expect(visibleRange(layout, 250, 0, 0)).toEqual({ start: 2, end: 3 });
  });

  it("falls back to the last item when scrolled past the end", () => {
    expect(visibleRange(layout, 9999, 100, 0)).toEqual({ start: 4, end: 5 });
  });

  it("renders only a handful of spreads in a 100+ page document", () => {
    const long = computeLayout(Array.from({ length: 200 }, () => 800));
    const range = visibleRange(long, 800 * 120, 800, 2);

    expect(range).toEqual({ start: 118, end: 123 });
    expect(range.end - range.start).toBeLessThanOrEqual(5);
  });
});

describe("rangeIncludes", () => {
  it("includes the start and excludes the end", () => {
    const range = { start: 2, end: 5 };
    expect(rangeIncludes(range, 1)).toBe(false);
    expect(rangeIncludes(range, 2)).toBe(true);
    expect(rangeIncludes(range, 4)).toBe(true);
    expect(rangeIncludes(range, 5)).toBe(false);
  });
});

describe("scrollOffsetForItem", () => {
  const layout = computeLayout([100, 100, 100, 100, 100]);

  it("returns 0 for an index outside the layout", () => {
    expect(scrollOffsetForItem(layout, 99, 300)).toBe(0);
    expect(scrollOffsetForItem([], 0, 300)).toBe(0);
  });

  it("centres an item smaller than the viewport", () => {
    expect(scrollOffsetForItem(layout, 2, 300)).toBe(100);
  });

  it("aligns an item at least as wide as the viewport to its leading edge", () => {
    expect(scrollOffsetForItem(layout, 2, 100)).toBe(200);
  });

  it("never scrolls before the start or past the scrollable end", () => {
    expect(scrollOffsetForItem(layout, 0, 300)).toBe(0);
    expect(scrollOffsetForItem(layout, 4, 300)).toBe(200);
  });
});

describe("nearestItemIndex", () => {
  const layout = computeLayout([100, 100, 100]);

  it("returns 0 for an empty layout", () => {
    expect(nearestItemIndex([], 500, 100)).toBe(0);
  });

  it("picks the item under the viewport centre", () => {
    expect(nearestItemIndex(layout, 0, 100)).toBe(0);
    expect(nearestItemIndex(layout, 110, 100)).toBe(1);
    expect(nearestItemIndex(layout, 250, 100)).toBe(2);
  });

  it("prefers the earlier item on an exact tie", () => {
    expect(nearestItemIndex(layout, 50, 100)).toBe(0);
  });

  it("clamps to the first item for a negative offset", () => {
    expect(nearestItemIndex(layout, -400, 100)).toBe(0);
  });
});
