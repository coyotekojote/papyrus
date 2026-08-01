import { LruCache } from "../pdf";

interface CachedPage {
  scale: number;
  canvas: HTMLCanvasElement;
}

/** How many rendered pages to keep. Comfortably covers the overscan window. */
export const DEFAULT_PAGE_CACHE_CAPACITY = 12;

/**
 * Keeps rendered page canvases alive after they scroll out of the virtualized
 * window, so scrolling back does not re-run the renderer.
 *
 * Entries are tagged with the scale they were rendered at; a stale-scale hit is
 * treated as a miss so a zoom change always produces a fresh, sharp render.
 */
export class PageRenderCache {
  private readonly cache: LruCache<number, CachedPage>;

  constructor(capacity = DEFAULT_PAGE_CACHE_CAPACITY) {
    this.cache = new LruCache<number, CachedPage>(capacity, (_, entry) => {
      // Release the backing store immediately instead of waiting for GC.
      entry.canvas.width = 0;
      entry.canvas.height = 0;
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

  set(pageNumber: number, scale: number, canvas: HTMLCanvasElement): void {
    this.cache.set(pageNumber, { scale, canvas });
  }

  /** Drops everything — used when the scale changes or the document closes. */
  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
