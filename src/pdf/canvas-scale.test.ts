import { describe, expect, it } from "vitest";
import {
  MAX_CANVAS_PIXELS,
  PREVIEW_MAX_PIXELS,
  backingStoreRatio,
  previewScale,
} from "./canvas-scale";

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

/** Backing-store pixel count `previewScale`'s return value would itself
 * produce, mirroring how a caller re-renders at that scale: the CSS size
 * shrinks by the same factor the scale did, then goes through the renderer's
 * own `backingStoreRatio` exactly like a full render would. */
function previewBackingPixels(
  scale: number,
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  maxPixels?: number,
) {
  const preview = previewScale(
    scale,
    cssWidth,
    cssHeight,
    devicePixelRatio,
    maxPixels,
  );
  if (preview === null) return null;

  const factor = preview / scale;
  const previewWidth = cssWidth * factor;
  const previewHeight = cssHeight * factor;
  const ratio = backingStoreRatio(
    previewWidth,
    previewHeight,
    devicePixelRatio,
  );
  return previewWidth * ratio * (previewHeight * ratio);
}

describe("previewScale", () => {
  it("returns null when the full render lands exactly on the budget", () => {
    // 1024x1024 at dpr 1 is exactly PREVIEW_MAX_PIXELS worth of backing
    // pixels — no cap in play, so nothing a preview would save.
    expect(previewScale(1, 1024, 1024, 1)).toBeNull();
  });

  it("returns a scale once the full render exceeds the budget by even one pixel row", () => {
    const result = previewScale(1, 1024, 1025, 1);

    expect(result).not.toBeNull();
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1);
  });

  it("rounds down to (not above) the pixel budget rather than a fixed fraction of scale", () => {
    // A large page, comfortably below MAX_CANVAS_PIXELS on its own, at dpr 1.
    const pixels = previewBackingPixels(2, 4000, 4000, 1);

    expect(pixels).not.toBeNull();
    expect(pixels as number).toBeLessThanOrEqual(PREVIEW_MAX_PIXELS);
    // "near" the budget, not some much smaller fixed-ratio result.
    expect(pixels as number).toBeGreaterThan(PREVIEW_MAX_PIXELS * 0.99);
  });

  it("accounts for a device pixel ratio above 1", () => {
    const scale = 1;
    const cssWidth = 612;
    const cssHeight = 792;
    const dpr = 2;

    const result = previewScale(scale, cssWidth, cssHeight, dpr);
    expect(result).not.toBeNull();
    expect(result as number).toBeLessThan(scale);

    const pixels = previewBackingPixels(scale, cssWidth, cssHeight, dpr);
    expect(pixels as number).toBeLessThanOrEqual(PREVIEW_MAX_PIXELS);
    expect(pixels as number).toBeGreaterThan(PREVIEW_MAX_PIXELS * 0.99);
  });

  it("still lands near the pixel budget once extreme zoom makes the full render hit MAX_CANVAS_PIXELS", () => {
    // Same Letter-at-6x-zoom, dpr-2 case that pushes backingStoreRatio's own
    // ratio below 1 (see canvas-scale.test.ts's "shrinks below 1" case) —
    // the full render here saturates at MAX_CANVAS_PIXELS regardless of dpr.
    const scale = 6;
    const cssWidth = LETTER.width * scale;
    const cssHeight = LETTER.height * scale;
    const dpr = 2;
    expect(cssWidth * cssHeight).toBeGreaterThan(MAX_CANVAS_PIXELS);

    const result = previewScale(scale, cssWidth, cssHeight, dpr);
    expect(result).not.toBeNull();
    expect(result as number).toBeGreaterThan(0);
    expect(result as number).toBeLessThan(scale);

    const pixels = previewBackingPixels(scale, cssWidth, cssHeight, dpr);
    expect(pixels as number).toBeLessThanOrEqual(PREVIEW_MAX_PIXELS);
    expect(pixels as number).toBeGreaterThan(PREVIEW_MAX_PIXELS * 0.99);
  });

  it("returns null for a degenerate CSS area", () => {
    expect(previewScale(1, 0, 792, 2)).toBeNull();
    expect(previewScale(1, 612, 0, 2)).toBeNull();
    expect(previewScale(1, Number.NaN, 792, 2)).toBeNull();
  });

  it("returns null for a non-finite or non-positive scale", () => {
    expect(previewScale(Number.NaN, 4000, 4000, 1)).toBeNull();
    expect(previewScale(0, 4000, 4000, 1)).toBeNull();
    expect(previewScale(-1, 4000, 4000, 1)).toBeNull();
    expect(previewScale(Number.POSITIVE_INFINITY, 4000, 4000, 1)).toBeNull();
  });

  it("honours a caller-supplied budget", () => {
    const result = previewScale(1, 4000, 4000, 1, 1_000_000);

    expect(result).not.toBeNull();
    const pixels = previewBackingPixels(1, 4000, 4000, 1, 1_000_000);
    expect(pixels as number).toBeLessThanOrEqual(1_000_000);
  });
});
