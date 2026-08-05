import { FALLBACK_PAGE_SIZE, type PageSize } from "../pdf";
import type { Spread } from "./spreads";

/** Horizontal gap between the two pages of a spread, in CSS pixels. */
export const PAGE_GAP = 8;
/** Breathing room on each side of a spread, in CSS pixels. */
export const SPREAD_PADDING = 24;

/** Natural size of a page, or the fallback when its size is not known yet. */
export function pageSizeAt(
  pageSizes: readonly PageSize[],
  pageNumber: number,
): PageSize {
  return pageSizes[pageNumber - 1] ?? FALLBACK_PAGE_SIZE;
}

/** On-screen size of a page at the given zoom. */
export function pageDisplaySize(size: PageSize, zoom: number): PageSize {
  return {
    width: Math.max(1, Math.round(size.width * zoom)),
    height: Math.max(1, Math.round(size.height * zoom)),
  };
}

/** Combined width of a spread's pages plus the gap between them. */
export function spreadContentWidth(
  spread: Spread,
  pageSizes: readonly PageSize[],
  zoom: number,
  gap = PAGE_GAP,
): number {
  if (spread.length === 0) return 0;
  const pagesWidth = spread.reduce(
    (total, page) =>
      total + pageDisplaySize(pageSizeAt(pageSizes, page), zoom).width,
    0,
  );
  return pagesWidth + gap * (spread.length - 1);
}

/**
 * The zoom above which at least one spread would no longer fit inside
 * `availableWidth` — the tightest constraint across every spread, used to
 * pick a "fit" zoom that shows every spread without clipping (issue #68).
 *
 * The gap between a spread's pages is fixed and does not scale with zoom
 * (see `spreadContentWidth`), so this is *not* simply
 * `availableWidth / widest natural spread`: each spread's own allowance is
 * `(availableWidth - gap * (pages - 1)) / natural pages width`, and the fit
 * must satisfy the *smallest* of those — a spread with fewer, wider pages
 * can be the tighter constraint even when it is not the widest spread at
 * zoom 1, because it has less gap to absorb the difference.
 *
 * Returns `null` when there is no spread to size against — an empty
 * document, or every spread's pages measuring zero width — so the caller
 * can fall back to a default instead of dividing by it.
 */
export function fitZoomForSpreads(
  spreads: readonly Spread[],
  pageSizes: readonly PageSize[],
  availableWidth: number,
  gap = PAGE_GAP,
): number | null {
  let tightest: number | null = null;
  for (const spread of spreads) {
    if (spread.length === 0) continue;
    const pagesWidth = spread.reduce(
      (total, page) => total + pageSizeAt(pageSizes, page).width,
      0,
    );
    if (pagesWidth <= 0) continue;
    const allowed = (availableWidth - gap * (spread.length - 1)) / pagesWidth;
    tightest = tightest === null ? allowed : Math.min(tightest, allowed);
  }
  return tightest;
}

/**
 * Width of a spread's scroll-snap box. A spread is always at least as wide as
 * the viewport so exactly one spread fills the screen and snapping lands on it.
 */
export function spreadBoxWidth(
  contentWidth: number,
  viewportWidth: number,
  padding = SPREAD_PADDING,
): number {
  return Math.max(viewportWidth, contentWidth + padding * 2);
}

/** Tallest page in a spread, at the given zoom. */
export function spreadContentHeight(
  spread: Spread,
  pageSizes: readonly PageSize[],
  zoom: number,
): number {
  if (spread.length === 0) return 0;
  return Math.max(
    ...spread.map(
      (page) => pageDisplaySize(pageSizeAt(pageSizes, page), zoom).height,
    ),
  );
}
