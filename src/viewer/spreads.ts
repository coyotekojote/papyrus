/** Single page at a time, or two facing pages. */
export type ViewMode = "single" | "spread";

/**
 * Which edge the book is bound on.
 * `left` = western order (page 1 at the left, read left-to-right).
 * `right` = Japanese order (page 1 at the right, read right-to-left).
 */
export type Binding = "left" | "right";

/** Page numbers (1-based) shown together, in ascending logical order. */
export type Spread = readonly number[];

/**
 * Groups pages into the units the viewer scrolls between.
 *
 * In spread mode page 1 stands alone as the cover, so the remaining pages pair
 * up as (2,3), (4,5), ... — the way a physical book falls open. A trailing odd
 * page forms a one-page spread.
 */
export function buildSpreads(pageCount: number, mode: ViewMode): Spread[] {
  if (!Number.isFinite(pageCount) || pageCount < 1) return [];
  const count = Math.floor(pageCount);

  if (mode === "single") {
    return Array.from({ length: count }, (_, i) => [i + 1]);
  }

  const spreads: Spread[] = [[1]];
  for (let page = 2; page <= count; page += 2) {
    spreads.push(page + 1 <= count ? [page, page + 1] : [page]);
  }
  return spreads;
}

/**
 * Orders a spread's pages the way they appear on screen, left to right.
 * A right-bound book puts the lower page number on the right.
 */
export function visualPageOrder(spread: Spread, binding: Binding): number[] {
  return binding === "right" ? [...spread].reverse() : [...spread];
}

/** Index of the spread containing `page`, or -1 when no spread holds it. */
export function spreadIndexOfPage(
  spreads: readonly Spread[],
  page: number,
): number {
  return spreads.findIndex((spread) => spread.includes(page));
}

/** The page a spread is identified by (its lowest page number). */
export function leadPage(spread: Spread): number {
  return spread.length === 0 ? 0 : Math.min(...spread);
}

/**
 * How an arrow key moves through the spread list. Forward is always "further
 * into the book", which is the right arrow for left-bound and the left arrow
 * for right-bound books. Returns 0 for keys that do not navigate.
 */
export function stepForArrowKey(key: string, binding: Binding): -1 | 0 | 1 {
  const forward = binding === "right" ? "ArrowLeft" : "ArrowRight";
  const backward = binding === "right" ? "ArrowRight" : "ArrowLeft";
  if (key === forward) return 1;
  if (key === backward) return -1;
  return 0;
}

/** Clamps a spread index into `[0, total - 1]`; returns 0 when there are none. */
export function clampSpreadIndex(index: number, total: number): number {
  if (total < 1) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.floor(index), 0), total - 1);
}

/**
 * Position of a spread in DOM/scroll order.
 *
 * A right-bound book is laid out with the spreads reversed inside a plain
 * left-to-right scroller, so page 1 sits at the far right. This avoids relying
 * on `direction: rtl`, whose `scrollLeft` sign differs across engines. The
 * mapping is its own inverse.
 */
export function toDomIndex(
  spreadIndex: number,
  total: number,
  binding: Binding,
): number {
  return binding === "right" ? total - 1 - spreadIndex : spreadIndex;
}

/**
 * Converts a vertical wheel delta into a horizontal scroll delta.
 *
 * Scrolling the wheel down always means "read on". A right-bound book is laid
 * out with its spreads reversed, so reading on there is a move towards a
 * *smaller* scroll offset — the delta has to flip with the binding.
 */
export function wheelScrollDelta(deltaY: number, binding: Binding): number {
  if (!Number.isFinite(deltaY)) return 0;
  return binding === "right" ? -deltaY : deltaY;
}
