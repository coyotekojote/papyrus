import { LruCache } from "../pdf";

interface CachedPage {
  scale: number;
  canvas: HTMLCanvasElement;
  /** `canvas.width * canvas.height` at insertion time, cached so an entry's
   * contribution to the running total is exact even after `canvas` is zeroed
   * out on eviction. */
  pixels: number;
}

/**
 * How many rendered pages to keep, as a safety valve on top of the pixel
 * budget below — a document made entirely of tiny pages could otherwise cache
 * an unbounded number of them without ever touching the budget.
 *
 * Sized for the worst case a two-page spread plus prefetch can produce: up to
 * 6 pages visible at once (3 spreads × 2 pages, `OVERSCAN = 1`) and up to 8
 * more warmed by the prefetch (`PREFETCH_COUNT = 3` spreads ahead × 2 pages,
 * plus 1 spread × 2 pages behind) — 14 pages that must all fit without
 * pushing a page still on screen out of the cache (see the `onEvict` note
 * below on why an evicted-but-visible page is a real bug, not just a wasted
 * re-render).
 */
export const DEFAULT_PAGE_CACHE_CAPACITY = 16;

/**
 * Total backing-store pixels the cache may hold across all its canvases, e.g.
 * ~256MB of RGBA at 64,000,000 pixels (4 bytes/px). A flat page-count cap (the previous
 * policy) either wastes memory at low zoom, where 12 tiny canvases cost
 * nothing, or overruns it at high zoom, where 12 canvases can each be many
 * times the screen's own pixel count.
 */
export const DEFAULT_PIXEL_BUDGET = 64_000_000;

/**
 * Keeps rendered page canvases alive after they scroll out of the virtualized
 * window, so scrolling back does not re-run the renderer.
 *
 * Entries are tagged with the scale they were rendered at; a stale-scale hit is
 * treated as a miss so a zoom change always produces a fresh, sharp render.
 *
 * Eviction is LRU, driven by two limits: the page-count `capacity` (a floor
 * on how few pages stay cached at any zoom) and `pixelBudget` (the ceiling on
 * total backing-store memory). Whichever one an insertion crosses first is
 * what triggers the eviction — the two are independent, not layered.
 */
export class PageRenderCache {
  private readonly cache: LruCache<number, CachedPage>;
  private totalPixels = 0;

  constructor(
    capacity = DEFAULT_PAGE_CACHE_CAPACITY,
    private readonly pixelBudget = DEFAULT_PIXEL_BUDGET,
  ) {
    if (!Number.isFinite(pixelBudget) || pixelBudget < 1) {
      throw new RangeError(
        `pixelBudget must be a positive number, got ${pixelBudget}`,
      );
    }
    this.cache = new LruCache<number, CachedPage>(capacity, (_, entry) => {
      this.totalPixels -= entry.pixels;
      // `PageCanvas` keeps a cache hit's canvas mounted in the DOM directly
      // (it does not clone it), so a canvas can be evicted from here while
      // still being what the reader is looking at — fast page-turning can
      // push more pages through the cache than are on screen at any instant.
      // Zeroing the backing store of a *connected* canvas would blank a page
      // still visible with no re-render to fix it (nothing tells `PageCanvas`
      // its cached entry is gone). So only a canvas already detached from the
      // DOM gets its backing store released immediately here; a connected one
      // is freed the ordinary way, once `PageCanvas` itself unmounts it and
      // GC reclaims it — a small, bounded delay in reclaiming memory next to
      // blanking a page the reader has not scrolled away from.
      if (!entry.canvas.isConnected) {
        entry.canvas.width = 0;
        entry.canvas.height = 0;
      }
    });
  }

  get(pageNumber: number, scale: number): HTMLCanvasElement | undefined {
    const entry = this.cache.get(pageNumber);
    if (!entry) return undefined;
    if (entry.scale !== scale) {
      this.cache.delete(pageNumber);
      return undefined;
    }
    return entry.canvas;
  }

  /**
   * Like {@link get}, but a read-only existence check: it does not promote
   * the entry to most-recently-used, and (unlike `get`) never evicts a
   * stale-scale hit either — a mere "is this warm" check has no business
   * mutating the cache's own order or contents. Meant for callers deciding
   * whether a page is worth rendering (e.g. the prefetch in `PdfViewer`),
   * where doing so for a page nobody has scrolled to yet must not bump a
   * page actually on screen closer to eviction.
   */
  has(pageNumber: number, scale: number): boolean {
    const entry = this.cache.peek(pageNumber);
    return entry !== undefined && entry.scale === scale;
  }

  set(pageNumber: number, scale: number, canvas: HTMLCanvasElement): void {
    const pixels = canvas.width * canvas.height;
    // `LruCache.set` fires `onEvict` (above) for both an overwritten entry at
    // this key and any entries the capacity cap pushes out, so `totalPixels`
    // is already correct for everything except the entry being added here.
    this.cache.set(pageNumber, { scale, canvas, pixels });
    this.totalPixels += pixels;

    // A single page larger than the whole budget must still be kept — it is
    // the one on screen right now — so eviction stops at one entry left
    // rather than trying to reach the budget no matter what.
    while (this.totalPixels > this.pixelBudget && this.cache.size > 1) {
      const oldest = this.cache.keys()[0];
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /** Drops everything — used when the scale changes or the document closes. */
  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  /** Total backing-store pixels currently held. Exposed for tests. */
  get pixels(): number {
    return this.totalPixels;
  }
}
