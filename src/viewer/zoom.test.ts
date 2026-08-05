import { describe, expect, it } from "vitest";
import type { PageSize } from "../pdf";
import { PAGE_GAP, SPREAD_PADDING } from "./layout";
import type { Spread } from "./spreads";
import {
  applyZoomCommand,
  clampZoom,
  DEFAULT_ZOOM,
  fitZoom,
  MAX_ZOOM,
  MIN_ZOOM,
  pinchZoom,
  steppedZoom,
  zoomCommandForKey,
} from "./zoom";

/** A single spread whose one page is exactly `width` wide. */
function singlePageSpreads(width: number): [Spread[], PageSize[]] {
  return [[[1]], [{ width, height: 1 }]];
}

describe("clampZoom", () => {
  it("keeps a value inside the range", () => {
    expect(clampZoom(1.5)).toBe(1.5);
  });

  it("clamps to the bounds", () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(100)).toBe(MAX_ZOOM);
  });

  it("falls back to the default for a non-finite value", () => {
    expect(clampZoom(Number.NaN)).toBe(DEFAULT_ZOOM);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(DEFAULT_ZOOM);
  });
});

describe("steppedZoom", () => {
  it("moves to the next stop up", () => {
    expect(steppedZoom(1, 1)).toBe(1.25);
    expect(steppedZoom(2, 1)).toBe(2.5);
  });

  it("moves to the next stop down", () => {
    expect(steppedZoom(1, -1)).toBe(0.75);
    expect(steppedZoom(2.5, -1)).toBe(2);
  });

  it("snaps a value between stops onto the neighbouring stop", () => {
    expect(steppedZoom(1.1, 1)).toBe(1.25);
    expect(steppedZoom(1.1, -1)).toBe(1);
  });

  it("stays put at the bounds", () => {
    expect(steppedZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(steppedZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });
});

describe("pinchZoom", () => {
  it("zooms in when the pinch delta is negative", () => {
    expect(pinchZoom(1, -50)).toBeGreaterThan(1);
  });

  it("zooms out when the pinch delta is positive", () => {
    expect(pinchZoom(1, 50)).toBeLessThan(1);
  });

  it("is symmetric: pinching back returns to the starting zoom", () => {
    expect(pinchZoom(pinchZoom(1, -40), 40)).toBeCloseTo(1, 10);
  });

  it("never leaves the allowed range", () => {
    expect(pinchZoom(MAX_ZOOM, -10000)).toBe(MAX_ZOOM);
    expect(pinchZoom(MIN_ZOOM, 10000)).toBe(MIN_ZOOM);
  });

  it("ignores a non-finite delta", () => {
    expect(pinchZoom(1.5, Number.NaN)).toBe(1.5);
  });
});

describe("fitZoom", () => {
  it("falls back to the default before the viewport has been measured", () => {
    const [spreads, pageSizes] = singlePageSpreads(800);
    expect(fitZoom(0, spreads, pageSizes)).toBe(DEFAULT_ZOOM);
  });

  it("falls back to the default when there is no spread to size against", () => {
    const [, pageSizes] = singlePageSpreads(800);
    expect(fitZoom(800, [], pageSizes)).toBe(DEFAULT_ZOOM);
  });

  it("lands exactly on the default zoom when the spread just fits", () => {
    // padding defaults to SPREAD_PADDING (24 either side): a spread of 800
    // fits at 100% in a viewport of 800 + 2*24.
    const [spreads, pageSizes] = singlePageSpreads(800);
    expect(fitZoom(848, spreads, pageSizes)).toBe(DEFAULT_ZOOM);
  });

  it("shrinks to fit a narrower viewport", () => {
    const [spreads, pageSizes] = singlePageSpreads(800);
    expect(fitZoom(448, spreads, pageSizes)).toBeCloseTo(0.5, 10);
  });

  it("clamps to MIN_ZOOM instead of shrinking past it", () => {
    const [spreads, pageSizes] = singlePageSpreads(800);
    expect(fitZoom(100, spreads, pageSizes)).toBe(MIN_ZOOM);
  });

  it("never magnifies past the default, however wide the viewport is", () => {
    const [spreads, pageSizes] = singlePageSpreads(800);
    expect(fitZoom(4000, spreads, pageSizes)).toBe(DEFAULT_ZOOM);
  });

  it("honours a custom padding", () => {
    const [spreads, pageSizes] = singlePageSpreads(500);
    expect(fitZoom(500, spreads, pageSizes, 0)).toBe(DEFAULT_ZOOM);
    expect(fitZoom(250, spreads, pageSizes, 0)).toBeCloseTo(0.5, 10);
  });

  it("falls back to the default for a non-finite viewport width", () => {
    const [spreads, pageSizes] = singlePageSpreads(800);
    expect(fitZoom(Number.NaN, spreads, pageSizes)).toBe(DEFAULT_ZOOM);
  });

  it("accounts for the fixed gap between a spread's pages, not just their own width (issue #68 review)", () => {
    // Two pages, 100 + 150 wide, with the default PAGE_GAP between them, in
    // a viewport too narrow to show them at 100%. Dividing availableWidth by
    // (pagesWidth + gap) — the old, buggy approach — would let the real
    // displayed width (pagesWidth * zoom + gap) overshoot availableWidth by
    // up to gap * (1 - zoom), since the gap does not itself scale with zoom.
    const spreads: Spread[] = [[1, 2]];
    const pageSizes: PageSize[] = [
      { width: 100, height: 1 },
      { width: 150, height: 1 },
    ];
    const viewportWidth = 200 + 2 * SPREAD_PADDING;
    const zoom = fitZoom(viewportWidth, spreads, pageSizes);
    const availableWidth = viewportWidth - 2 * SPREAD_PADDING;
    // The zoom this returns must not let the real content overflow: pages
    // scaled by it, plus the untouched gap, stay within availableWidth.
    expect(250 * zoom + PAGE_GAP).toBeLessThanOrEqual(availableWidth + 1e-9);
    // The old formula (availableWidth / (pagesWidth + gap)) would have
    // returned this larger, overflowing value instead.
    const oldBuggyZoom = availableWidth / (250 + PAGE_GAP);
    expect(zoom).toBeLessThan(oldBuggyZoom);
  });
});

describe("zoomCommandForKey", () => {
  it("maps Cmd/Ctrl with +, - and 0", () => {
    expect(zoomCommandForKey({ key: "=", metaKey: true, ctrlKey: false })).toBe(
      "in",
    );
    expect(zoomCommandForKey({ key: "+", metaKey: false, ctrlKey: true })).toBe(
      "in",
    );
    expect(zoomCommandForKey({ key: "-", metaKey: true, ctrlKey: false })).toBe(
      "out",
    );
    expect(zoomCommandForKey({ key: "0", metaKey: true, ctrlKey: false })).toBe(
      "reset",
    );
  });

  it("ignores the same keys without a modifier", () => {
    expect(
      zoomCommandForKey({ key: "=", metaKey: false, ctrlKey: false }),
    ).toBeNull();
    expect(
      zoomCommandForKey({ key: "0", metaKey: false, ctrlKey: false }),
    ).toBeNull();
  });

  it("ignores other keys and Alt-modified combinations", () => {
    expect(
      zoomCommandForKey({ key: "a", metaKey: true, ctrlKey: false }),
    ).toBeNull();
    expect(
      zoomCommandForKey({
        key: "=",
        metaKey: true,
        ctrlKey: false,
        altKey: true,
      }),
    ).toBeNull();
  });
});

describe("applyZoomCommand", () => {
  it("steps up and down from the effective zoom, going manual", () => {
    expect(applyZoomCommand(1, "in")).toEqual({ mode: "manual", value: 1.25 });
    expect(applyZoomCommand(1, "out")).toEqual({
      mode: "manual",
      value: 0.75,
    });
  });

  it("steps from whatever effective zoom it is given, e.g. a fit zoom", () => {
    expect(applyZoomCommand(0.73, "in")).toEqual({
      mode: "manual",
      value: 0.75,
    });
  });

  it("resets to fit mode, not a fixed number, from any level (issue #68)", () => {
    expect(applyZoomCommand(3, "reset")).toEqual({ mode: "fit" });
    expect(applyZoomCommand(0.25, "reset")).toEqual({ mode: "fit" });
  });
});
