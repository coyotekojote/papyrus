/** A laid-out spread: where it starts along the scroll axis and how wide it is. */
export interface LayoutItem {
  offset: number;
  size: number;
}

/** Half-open range of item indices: `[start, end)`. */
export interface IndexRange {
  start: number;
  end: number;
}

/** Lays items out end to end with a fixed gap between them. */
export function computeLayout(sizes: readonly number[], gap = 0): LayoutItem[] {
  const items: LayoutItem[] = [];
  let offset = 0;
  for (const size of sizes) {
    items.push({ offset, size });
    offset += size + gap;
  }
  return items;
}

/** Total extent of a layout, including the gaps between items. */
export function layoutExtent(layout: readonly LayoutItem[]): number {
  const last = layout.at(-1);
  return last ? last.offset + last.size : 0;
}

/**
 * Which items overlap the viewport, widened by `overscan` items on each side.
 *
 * `overscan` is what keeps page turns smooth: neighbouring spreads are already
 * rendered by the time they scroll into view, so a 100+ page document never
 * waits on the renderer mid-scroll.
 */
export function visibleRange(
  layout: readonly LayoutItem[],
  scrollOffset: number,
  viewportSize: number,
  overscan = 1,
): IndexRange {
  if (layout.length === 0) return { start: 0, end: 0 };

  const from = Math.max(0, scrollOffset);
  const to = from + Math.max(0, viewportSize);

  let start = layout.findIndex((item) => item.offset + item.size > from);
  if (start === -1) start = layout.length - 1;

  let end = start;
  while (end < layout.length && layout[end].offset < to) end += 1;
  // A zero-height viewport (or one sitting exactly in a gap) must still yield
  // the item the scroll position points at, never an empty range.
  if (end === start) end = start + 1;

  const pad = Math.max(0, Math.floor(overscan));
  return {
    start: Math.max(0, start - pad),
    end: Math.min(layout.length, end + pad),
  };
}

/** True when index `i` falls inside a half-open range. */
export function rangeIncludes(range: IndexRange, index: number): boolean {
  return index >= range.start && index < range.end;
}

/**
 * Which way the reader is scrolling, in DOM-index order (not necessarily page
 * order — a right-bound spread's DOM order is already reversed by
 * `toDomIndex`, so "forward" here always means "towards higher DOM index").
 * `"none"` covers both a scroll position that has not moved and one nobody
 * has measured yet (the first render).
 */
export type ScrollDirection = "forward" | "backward" | "none";

/** Where {@link prefetchRange} suggests warming the render cache next. */
export interface PrefetchTarget {
  /** Items just past the visible range, on its higher-DOM-index side. Gets
   * the larger share of `count` when scrolling forward, the smaller (0-1)
   * share when scrolling backward. */
  ahead: IndexRange;
  /** Items just before the visible range, on its lower-DOM-index side. Gets
   * the larger share of `count` when scrolling backward, the smaller (0-1)
   * share when scrolling forward. */
  behind: IndexRange;
}

/**
 * Extends {@link visibleRange}'s window with a further lookahead for the
 * background prefetch (issue #12) to warm — pages the synchronous overscan
 * does not render but the reader is likely to reach soon.
 *
 * Unlike overscan, this is deliberately lopsided: `count` items ahead of
 * travel, but only up to one behind it — a reader who reverses direction
 * still gets the immediately preceding page warm from when it was ahead a
 * moment ago, without spending the same budget on both directions at once.
 * Direction `"none"` has no side to favour, so both get an equal (and
 * necessarily smaller) share of `count` instead.
 */
export function prefetchRange(
  layout: readonly LayoutItem[],
  range: IndexRange,
  direction: ScrollDirection,
  count: number,
): PrefetchTarget {
  const length = layout.length;
  const clampAhead = (n: number): IndexRange => ({
    start: Math.min(length, range.end),
    end: Math.max(range.end, Math.min(length, range.end + Math.max(0, n))),
  });
  const clampBehind = (n: number): IndexRange => ({
    start: Math.min(range.start, Math.max(0, range.start - Math.max(0, n))),
    end: Math.max(0, range.start),
  });

  if (direction === "forward") {
    return { ahead: clampAhead(count), behind: clampBehind(1) };
  }
  if (direction === "backward") {
    return { ahead: clampAhead(1), behind: clampBehind(count) };
  }
  const half = Math.floor(count / 2);
  return { ahead: clampAhead(half), behind: clampBehind(half) };
}

/**
 * Scroll offset that centres an item in the viewport, clamped to the scrollable
 * area. Items wider than the viewport are aligned to their leading edge.
 */
export function scrollOffsetForItem(
  layout: readonly LayoutItem[],
  index: number,
  viewportSize: number,
): number {
  const item = layout[index];
  if (!item) return 0;
  const target =
    item.size >= viewportSize
      ? item.offset
      : item.offset - (viewportSize - item.size) / 2;
  const max = Math.max(0, layoutExtent(layout) - viewportSize);
  return Math.min(Math.max(target, 0), max);
}

function itemCentre(item: LayoutItem): number {
  return item.offset + item.size / 2;
}

/**
 * The item whose centre is nearest the viewport centre — i.e. the one on screen.
 *
 * Runs on every (rAF-throttled) scroll update, so it binary-searches rather than
 * sweeping the layout: `computeLayout` places items end to end, which makes
 * their centres non-decreasing. Exact ties resolve to the earliest item.
 */
export function nearestItemIndex(
  layout: readonly LayoutItem[],
  scrollOffset: number,
  viewportSize: number,
): number {
  if (layout.length === 0) return 0;
  const centre = Math.max(0, scrollOffset) + Math.max(0, viewportSize) / 2;

  // Lower bound: the first item whose centre is at or past the viewport centre.
  let low = 0;
  let high = layout.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (itemCentre(layout[mid]) < centre) low = mid + 1;
    else high = mid;
  }

  // Centres before `low` grow towards it and centres after it grow away, so the
  // winner is `low` or its predecessor.
  let best = low;
  if (low >= layout.length) {
    best = layout.length - 1;
  } else if (low > 0) {
    const before = centre - itemCentre(layout[low - 1]);
    const after = itemCentre(layout[low]) - centre;
    // `<=` keeps the earlier item on an exact tie, matching a forward scan.
    if (before <= after) best = low - 1;
  }

  // Zero-size items can share a centre; step back to the first of any such run
  // so the result never depends on where the search happened to land.
  while (
    best > 0 &&
    itemCentre(layout[best - 1]) === itemCentre(layout[best])
  ) {
    best -= 1;
  }
  return best;
}
