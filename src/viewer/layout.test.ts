import { describe, expect, it } from "vitest";
import { FALLBACK_PAGE_SIZE, type PageSize } from "../pdf";
import {
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
