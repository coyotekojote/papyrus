import { describe, expect, it } from "vitest";
import {
  buildSpreads,
  clampSpreadIndex,
  leadPage,
  spreadIndexOfPage,
  stepForArrowKey,
  toDomIndex,
  visualPageOrder,
} from "./spreads";

describe("buildSpreads", () => {
  it("returns no spreads for an empty document", () => {
    expect(buildSpreads(0, "single")).toEqual([]);
    expect(buildSpreads(0, "spread")).toEqual([]);
  });

  it("returns no spreads for a negative or non-finite page count", () => {
    expect(buildSpreads(-3, "spread")).toEqual([]);
    expect(buildSpreads(Number.NaN, "spread")).toEqual([]);
  });

  it("puts one page per spread in single mode", () => {
    expect(buildSpreads(4, "single")).toEqual([[1], [2], [3], [4]]);
  });

  it("shows page 1 alone as the cover in spread mode", () => {
    expect(buildSpreads(1, "spread")).toEqual([[1]]);
    expect(buildSpreads(2, "spread")).toEqual([[1], [2]]);
    expect(buildSpreads(3, "spread")).toEqual([[1], [2, 3]]);
  });

  it("pairs the remaining pages after the cover", () => {
    expect(buildSpreads(6, "spread")).toEqual([[1], [2, 3], [4, 5], [6]]);
    expect(buildSpreads(7, "spread")).toEqual([[1], [2, 3], [4, 5], [6, 7]]);
  });

  it("covers every page exactly once in spread mode", () => {
    const pages = buildSpreads(101, "spread").flat();
    expect(pages).toEqual(Array.from({ length: 101 }, (_, i) => i + 1));
  });
});

describe("visualPageOrder", () => {
  it("keeps ascending order for a left-bound book", () => {
    expect(visualPageOrder([2, 3], "left")).toEqual([2, 3]);
  });

  it("reverses the pair for a right-bound book", () => {
    expect(visualPageOrder([2, 3], "right")).toEqual([3, 2]);
  });

  it("leaves a single-page spread untouched in both bindings", () => {
    expect(visualPageOrder([1], "left")).toEqual([1]);
    expect(visualPageOrder([1], "right")).toEqual([1]);
  });

  it("does not mutate the input spread", () => {
    const spread = [4, 5];
    visualPageOrder(spread, "right");
    expect(spread).toEqual([4, 5]);
  });
});

describe("spreadIndexOfPage", () => {
  const spreads = buildSpreads(6, "spread"); // [1] [2,3] [4,5] [6]

  it("finds the spread holding a page", () => {
    expect(spreadIndexOfPage(spreads, 1)).toBe(0);
    expect(spreadIndexOfPage(spreads, 3)).toBe(1);
    expect(spreadIndexOfPage(spreads, 6)).toBe(3);
  });

  it("returns -1 for a page outside the document", () => {
    expect(spreadIndexOfPage(spreads, 0)).toBe(-1);
    expect(spreadIndexOfPage(spreads, 7)).toBe(-1);
  });
});

describe("leadPage", () => {
  it("uses the lowest page number of the spread", () => {
    expect(leadPage([2, 3])).toBe(2);
    expect(leadPage([9])).toBe(9);
  });

  it("returns 0 for an empty spread", () => {
    expect(leadPage([])).toBe(0);
  });
});

describe("stepForArrowKey", () => {
  it("advances with the right arrow in a left-bound book", () => {
    expect(stepForArrowKey("ArrowRight", "left")).toBe(1);
    expect(stepForArrowKey("ArrowLeft", "left")).toBe(-1);
  });

  it("advances with the left arrow in a right-bound book", () => {
    expect(stepForArrowKey("ArrowLeft", "right")).toBe(1);
    expect(stepForArrowKey("ArrowRight", "right")).toBe(-1);
  });

  it("ignores keys that are not horizontal arrows", () => {
    expect(stepForArrowKey("ArrowUp", "left")).toBe(0);
    expect(stepForArrowKey("a", "right")).toBe(0);
  });
});

describe("clampSpreadIndex", () => {
  it("keeps an in-range index", () => {
    expect(clampSpreadIndex(2, 5)).toBe(2);
  });

  it("clamps to the first and last spread", () => {
    expect(clampSpreadIndex(-4, 5)).toBe(0);
    expect(clampSpreadIndex(99, 5)).toBe(4);
  });

  it("returns 0 when the document has no spreads", () => {
    expect(clampSpreadIndex(3, 0)).toBe(0);
  });

  it("returns 0 for a non-finite index", () => {
    expect(clampSpreadIndex(Number.NaN, 5)).toBe(0);
  });
});

describe("toDomIndex", () => {
  it("is the identity for a left-bound book", () => {
    expect(toDomIndex(0, 4, "left")).toBe(0);
    expect(toDomIndex(3, 4, "left")).toBe(3);
  });

  it("reverses the order for a right-bound book", () => {
    expect(toDomIndex(0, 4, "right")).toBe(3);
    expect(toDomIndex(3, 4, "right")).toBe(0);
  });

  it("is its own inverse", () => {
    for (const binding of ["left", "right"] as const) {
      for (let i = 0; i < 5; i++) {
        expect(toDomIndex(toDomIndex(i, 5, binding), 5, binding)).toBe(i);
      }
    }
  });
});
