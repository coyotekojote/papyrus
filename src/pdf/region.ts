import type { RegionRect } from "./types";

/**
 * Clips a region to the page and normalizes its orientation.
 *
 * A rect can arrive from anywhere — an annotations.json written by another
 * device, a future build with a wider schema — so the renderer never trusts
 * one to be inside 0-1 or to have positive extents. A rect that falls entirely
 * off the page collapses to zero size, which the caller rejects.
 */
export function clampRegion(rect: RegionRect): RegionRect {
  const left = clampUnitOrZero(Math.min(rect.x, rect.x + rect.w));
  const right = clampUnitOrZero(Math.max(rect.x, rect.x + rect.w));
  const top = clampUnitOrZero(Math.min(rect.y, rect.y + rect.h));
  const bottom = clampUnitOrZero(Math.max(rect.y, rect.y + rect.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * Deliberately not `viewer/normalize.ts`'s `clampUnit`: that one clamps
 * measurements the DOM produced, which are always numbers, while a rect out of
 * annotations.json may hold anything. The name says which of the two this is.
 */
function clampUnitOrZero(value: number): number {
  // NaN survives Math.min/Math.max, so it is caught explicitly rather than
  // reaching the canvas as a NaN width. Infinities need no special case: they
  // clamp to the page edge like any out-of-range coordinate.
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
