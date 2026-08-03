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

/**
 * Pixel budget for a low-resolution preview render (issue #37), well under a
 * full render's {@link MAX_CANVAS_PIXELS}. ~1MP: enough to look like a page
 * rather than a smear, small enough that pdf.js can rasterize it fast.
 */
export const PREVIEW_MAX_PIXELS = 1_048_576;

/**
 * Scale to use for a page's preview render, or `null` if the page's full
 * render already fits within `maxPixels` — at that size there is nothing a
 * preview would save, so the caller should skip straight to one render pass.
 *
 * The full render's own backing store is estimated with the same
 * {@link backingStoreRatio} calculation (device pixel ratio, capped by
 * {@link MAX_CANVAS_PIXELS}) the renderer itself will use, purely to decide
 * whether a preview is worth it at all. When it is, this scales *down* from
 * `scale` by just enough that the preview's own backing store lands at (not
 * above) `maxPixels` — a pixel-count cap rather than a fixed fraction of
 * `scale`, on purpose: a fixed fraction (say 1/4) would make the preview
 * balloon right along with the full render at high zoom, defeating the point
 * of a preview being cheap to rasterize.
 */
export function previewScale(
  scale: number,
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  maxPixels = PREVIEW_MAX_PIXELS,
): number | null {
  const area = cssWidth * cssHeight;
  if (!Number.isFinite(area) || area <= 0) return null;
  if (!Number.isFinite(scale) || scale <= 0) return null;

  const fullRatio = backingStoreRatio(cssWidth, cssHeight, devicePixelRatio);
  const fullPixels = area * fullRatio * fullRatio;
  if (fullPixels <= maxPixels) return null;

  // Deliberately not `fullPixels` here: once the full render is large enough
  // to hit the `MAX_CANVAS_PIXELS` cap, `fullPixels` stops tracking device
  // pixel ratio at all (it saturates at the cap), and solving from it would
  // hand back a preview `scale` whose *own* backing-store calculation — at
  // the real `devicePixelRatio`, on the preview's much smaller CSS area —
  // lands nowhere near `maxPixels`. Solving from the uncapped device-pixel
  // target instead keeps the two consistent: `maxPixels` is small enough
  // that the preview's own backing store never approaches the cap, so this
  // is exact rather than just an approximation.
  const ratio = Number.isFinite(devicePixelRatio)
    ? Math.max(devicePixelRatio, 0) || 1
    : 1;
  return scale * Math.sqrt(maxPixels / (area * ratio * ratio));
}
