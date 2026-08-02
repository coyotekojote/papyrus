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
 * left where it started rather than dividing by zero. A non-finite reading on
 * either side gets the same treatment — a glitched sample mid-gesture must
 * not slam the zoom to an extreme. A negative `currentDistance` is clamped
 * to zero (all the way pinched in), not allowed to flip the ratio's sign.
 */
export function pinchZoomFromTouch(
  startZoom: number,
  startDistance: number,
  currentDistance: number,
): number {
  if (!Number.isFinite(startDistance) || startDistance <= 0) {
    return clampZoom(startZoom);
  }
  if (!Number.isFinite(currentDistance)) return clampZoom(startZoom);
  const current = Math.max(0, currentDistance);
  return clampZoom(startZoom * (current / startDistance));
}
