import { clampZoom } from "./zoom";

/** A pointer's screen position, as read from a `PointerEvent`. */
export interface TouchPoint {
  x: number;
  y: number;
}

/** Straight-line distance between two pointers. */
export function pointerDistance(a: TouchPoint, b: TouchPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Zoom for an in-progress two-finger pinch: the finger separation grows or
 * shrinks by a ratio against where the gesture started, and the zoom scales
 * by that same ratio — a pinch that returns to its starting spread lands
 * back on `startZoom` exactly, rather than drifting.
 *
 * `startDistance` of zero (fingers landed on the same point, or the touch
 * hardware briefly reported it that way) has no ratio to compute; the zoom is
 * left where it started rather than dividing by zero. The same guard covers
 * `currentDistance`, which is clamped to zero rather than allowed negative.
 */
export function pinchZoomFromTouch(
  startZoom: number,
  startDistance: number,
  currentDistance: number,
): number {
  if (!Number.isFinite(startDistance) || startDistance <= 0) {
    return clampZoom(startZoom);
  }
  const current = Number.isFinite(currentDistance)
    ? Math.max(0, currentDistance)
    : 0;
  return clampZoom(startZoom * (current / startDistance));
}
