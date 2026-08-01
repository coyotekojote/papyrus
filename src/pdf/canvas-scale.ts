/**
 * Upper bound on a canvas backing store, in pixels. WebKit (and therefore the
 * WKWebView this app ships in) silently refuses to paint canvases past its own
 * area limit, leaving a blank page rather than raising an error.
 */
export const MAX_CANVAS_PIXELS = 16_777_216; // 4096 x 4096

/**
 * Multiplier applied to the render scale to produce the canvas backing store.
 *
 * Normally this is the device pixel ratio, for a crisp render. When the page's
 * CSS area alone would already exceed {@link MAX_CANVAS_PIXELS} — a Letter page
 * at 6x zoom does — the result drops *below* 1 so the backing store shrinks and
 * stays paintable. The CSS size is set separately, so the page still occupies
 * its full on-screen footprint; only the resolution degrades.
 */
export function backingStoreRatio(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  maxPixels = MAX_CANVAS_PIXELS,
): number {
  const area = cssWidth * cssHeight;
  if (!Number.isFinite(area) || area <= 0) return 1;

  const ratio = Number.isFinite(devicePixelRatio)
    ? Math.max(devicePixelRatio, 0)
    : 1;
  return Math.min(ratio || 1, Math.sqrt(maxPixels / area));
}
