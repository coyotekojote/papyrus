/**
 * Shared geometry for turning what happened on screen into the normalized
 * (0-1) page coordinates annotations are stored in — highlights (#6) and
 * figure clips (#8) both land here.
 */

/** Subset of DOMRect the math needs, so tests can use plain objects. */
export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Keeps a coordinate on the page it was measured against. */
export function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Four decimals: finer than a pixel on any page this app renders, and short
 * enough that annotations.json stays readable when another tool opens it.
 */
export function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
