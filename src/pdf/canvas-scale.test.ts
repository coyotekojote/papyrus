import { describe, expect, it } from "vitest";
import { MAX_CANVAS_PIXELS, backingStoreRatio } from "./canvas-scale";

/** US Letter at 72dpi, the size pdf.js reports at scale 1. */
const LETTER = { width: 612, height: 792 };

/** Backing-store pixel count the renderer would allocate for a page. */
function backingStorePixels(
  page: { width: number; height: number },
  zoom: number,
  devicePixelRatio: number,
) {
  const cssWidth = page.width * zoom;
  const cssHeight = page.height * zoom;
  const ratio = backingStoreRatio(cssWidth, cssHeight, devicePixelRatio);
  return Math.floor(cssWidth * ratio) * Math.floor(cssHeight * ratio);
}

describe("backingStoreRatio", () => {
  it("uses the device pixel ratio when the page is comfortably small", () => {
    expect(backingStoreRatio(612, 792, 2)).toBe(2);
    expect(backingStoreRatio(612, 792, 1)).toBe(1);
  });

  it("caps the ratio below the device pixel ratio when that would overflow", () => {
    // Letter at 3x zoom is 4.36M CSS px — fine on its own, but 17.4M once a
    // retina backing store doubles each axis.
    const cssWidth = LETTER.width * 3;
    const cssHeight = LETTER.height * 3;
    expect(cssWidth * cssHeight).toBeLessThan(MAX_CANVAS_PIXELS);
    expect(cssWidth * 2 * (cssHeight * 2)).toBeGreaterThan(MAX_CANVAS_PIXELS);

    const ratio = backingStoreRatio(cssWidth, cssHeight, 2);

    expect(ratio).toBeGreaterThan(1);
    expect(ratio).toBeLessThan(2);
    expect(cssWidth * ratio * (cssHeight * ratio)).toBeLessThanOrEqual(
      MAX_CANVAS_PIXELS,
    );
  });

  it("shrinks below 1 when the CSS area alone exceeds the budget", () => {
    // The regression this guards: Letter at 6x zoom is ~17.5M CSS px, already
    // past the limit, so the backing store must be scaled *down*, not left at 1.
    const cssWidth = LETTER.width * 6;
    const cssHeight = LETTER.height * 6;
    expect(cssWidth * cssHeight).toBeGreaterThan(MAX_CANVAS_PIXELS);

    const ratio = backingStoreRatio(cssWidth, cssHeight, 2);

    expect(ratio).toBeLessThan(1);
    expect(cssWidth * ratio * (cssHeight * ratio)).toBeLessThanOrEqual(
      MAX_CANVAS_PIXELS,
    );
  });

  it("keeps every zoom level within the budget at any device pixel ratio", () => {
    for (const zoom of [0.25, 1, 1.5, 2, 3, 4, 5, 6]) {
      for (const dpr of [1, 2, 3]) {
        expect(backingStorePixels(LETTER, zoom, dpr)).toBeLessThanOrEqual(
          MAX_CANVAS_PIXELS,
        );
      }
    }
  });

  it("keeps an A0 poster within the budget even at 1x zoom", () => {
    const a0 = { width: 2384, height: 3370 };
    expect(a0.width * a0.height).toBeGreaterThan(MAX_CANVAS_PIXELS / 3);

    expect(backingStorePixels(a0, 1, 2)).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
    expect(backingStorePixels(a0, 6, 2)).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
  });

  it("falls back to 1 for a degenerate page size", () => {
    expect(backingStoreRatio(0, 792, 2)).toBe(1);
    expect(backingStoreRatio(612, 0, 2)).toBe(1);
    expect(backingStoreRatio(Number.NaN, 792, 2)).toBe(1);
  });

  it("falls back to 1 for a missing or nonsensical device pixel ratio", () => {
    expect(backingStoreRatio(612, 792, Number.NaN)).toBe(1);
    expect(backingStoreRatio(612, 792, 0)).toBe(1);
  });

  it("honours a caller-supplied budget", () => {
    const ratio = backingStoreRatio(1000, 1000, 4, 1_000_000);

    expect(ratio).toBe(1);
    expect(1000 * ratio * (1000 * ratio)).toBeLessThanOrEqual(1_000_000);
  });
});
