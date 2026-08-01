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

/** The item whose centre is nearest the viewport centre — i.e. the one on screen. */
export function nearestItemIndex(
  layout: readonly LayoutItem[],
  scrollOffset: number,
  viewportSize: number,
): number {
  if (layout.length === 0) return 0;
  const centre = Math.max(0, scrollOffset) + Math.max(0, viewportSize) / 2;
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [index, item] of layout.entries()) {
    const distance = Math.abs(item.offset + item.size / 2 - centre);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}
