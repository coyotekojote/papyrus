import { describe, expect, it } from "vitest";
import { FALLBACK_PAGE_SIZE, type PageSize } from "../pdf";
import {
  fitZoomForSpreads,
  pageDisplaySize,
  pageSizeAt,
  spreadBoxWidth,
  spreadContentHeight,
  spreadContentWidth,
} from "./layout";

const sizes: PageSize[] = [
  { width: 100, height: 200 },
  { width: 100, height: 200 },
  { width: 150, height: 300 },
];

describe("pageSizeAt", () => {
  it("reads the size by 1-based page number", () => {
    expect(pageSizeAt(sizes, 1)).toEqual({ width: 100, height: 200 });
    expect(pageSizeAt(sizes, 3)).toEqual({ width: 150, height: 300 });
  });

  it("falls back for pages whose size has not loaded yet", () => {
    expect(pageSizeAt(sizes, 4)).toEqual(FALLBACK_PAGE_SIZE);
    expect(pageSizeAt([], 1)).toEqual(FALLBACK_PAGE_SIZE);
  });
});

describe("pageDisplaySize", () => {
  it("scales by the zoom factor", () => {
    expect(pageDisplaySize({ width: 100, height: 200 }, 1.5)).toEqual({
      width: 150,
      height: 300,
    });
  });

  it("rounds to whole pixels", () => {
    expect(pageDisplaySize({ width: 101, height: 201 }, 1.005)).toEqual({
      width: 102,
      height: 202,
    });
  });

  it("never collapses a page to zero at tiny zoom levels", () => {
    expect(pageDisplaySize({ width: 100, height: 200 }, 0.001)).toEqual({
      width: 1,
      height: 1,
    });
  });
});

describe("spreadContentWidth", () => {
  it("is zero for an empty spread", () => {
    expect(spreadContentWidth([], sizes, 1)).toBe(0);
  });

  it("is the page width for a single-page spread, with no gap", () => {
    expect(spreadContentWidth([1], sizes, 1, 8)).toBe(100);
  });

  it("sums both pages and adds one gap for a two-page spread", () => {
    expect(spreadContentWidth([2, 3], sizes, 1, 8)).toBe(100 + 150 + 8);
  });

  it("scales the pages but not the gap", () => {
    expect(spreadContentWidth([2, 3], sizes, 2, 8)).toBe(200 + 300 + 8);
  });
});

describe("fitZoomForSpreads", () => {
  it("is null when there are no spreads to size against", () => {
    expect(fitZoomForSpreads([], sizes, 1000)).toBeNull();
  });

  it("is null when every spread's pages measure zero width", () => {
    const zeroWidth: PageSize[] = [{ width: 0, height: 200 }];
    expect(fitZoomForSpreads([[1], []], zeroWidth, 1000)).toBeNull();
  });

  it("is availableWidth / pagesWidth for a single-page spread (no gap)", () => {
    expect(fitZoomForSpreads([[1]], sizes, 250, 8)).toBeCloseTo(2.5, 10);
  });

  it("subtracts the fixed gap before dividing, for a multi-page spread", () => {
    // Spread [2, 3]: pages 100 + 150 = 250 wide, one 8px gap between them.
    // At the zoom this returns, the *actual* displayed width
    // (pagesWidth * zoom + gap) lands exactly on availableWidth — the gap
    // itself is never scaled by zoom (see `spreadContentWidth`), so it must
    // come out of `availableWidth` before dividing, not after (issue #68
    // review: dividing availableWidth by `pagesWidth + gap` instead lets the
    // real content overflow by up to `gap * (1 - zoom)`).
    const zoom = fitZoomForSpreads([[2, 3]], sizes, 258, 8);
    expect(zoom).toBeCloseTo(1, 10); // (258 - 8) / 250 = 1
    expect(250 * (zoom ?? Number.NaN) + 8).toBeCloseTo(258, 10);
  });

  it("picks the tightest spread across the document, not just the widest one", () => {
    // Spread A: 1 page, 100 wide, no gap — allowance is availableWidth / 100.
    // Spread B: 2 pages summing to 95, one 8px gap — allowance is
    // (availableWidth - 8) / 95. At availableWidth 100, A allows 1.0 exactly
    // while B allows (100 - 8) / 95 ≈ 0.968: B is tighter despite having a
    // *smaller* natural pages width than A, because its gap does not scale.
    // The widest-natural-spread heuristic this replaced would never even
    // have looked at B's own numbers here.
    const mixed: PageSize[] = [
      { width: 100, height: 1 }, // page 1, spread A
      { width: 50, height: 1 }, // page 2, spread B
      { width: 45, height: 1 }, // page 3, spread B
    ];
    const zoom = fitZoomForSpreads([[1], [2, 3]], mixed, 100, 8);
    expect(zoom).toBeCloseTo((100 - 8) / 95, 10);
  });

  it("ignores an individual empty spread rather than treating it as unconstrained", () => {
    expect(fitZoomForSpreads([[], [1]], sizes, 250, 8)).toBeCloseTo(2.5, 10);
  });
});

describe("spreadBoxWidth", () => {
  it("fills the viewport when the content is narrower", () => {
    expect(spreadBoxWidth(200, 1000, 24)).toBe(1000);
  });

  it("grows past the viewport when the content is wider", () => {
    expect(spreadBoxWidth(1200, 1000, 24)).toBe(1248);
  });

  it("handles a viewport that has not been measured yet", () => {
    expect(spreadBoxWidth(200, 0, 24)).toBe(248);
  });
});

describe("spreadContentHeight", () => {
  it("is zero for an empty spread", () => {
    expect(spreadContentHeight([], sizes, 1)).toBe(0);
  });

  it("uses the tallest page in the spread", () => {
    expect(spreadContentHeight([2, 3], sizes, 1)).toBe(300);
  });

  it("scales with the zoom", () => {
    expect(spreadContentHeight([1], sizes, 0.5)).toBe(100);
  });
});
