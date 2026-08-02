import { markEnd, markStart } from "../perf/marks";
import type { PageSize, PdfDocumentHandle } from "./types";

/** Fallback used when a page's real size cannot be read (US Letter, 72dpi). */
export const FALLBACK_PAGE_SIZE: PageSize = { width: 612, height: 792 };

export interface LoadPageSizesOptions {
  /** Pages queried in parallel per batch. Keeps a 1000-page open responsive. */
  chunkSize?: number;
  /** Called after each batch with the sizes collected so far. */
  onProgress?: (sizes: PageSize[]) => void;
  signal?: AbortSignal;
}

/** Fetches one contiguous range of page sizes in parallel, page by page. */
async function fetchPageSizeRange(
  doc: Pick<PdfDocumentHandle, "getPageSize">,
  start: number,
  end: number,
): Promise<PageSize[]> {
  return Promise.all(
    Array.from({ length: end - start + 1 }, (_, i) =>
      doc.getPageSize(start + i).catch(() => FALLBACK_PAGE_SIZE),
    ),
  );
}

/**
 * Reads every page's natural size so the viewer can lay out (and reserve space
 * for) pages it has not rendered yet. Pages that fail to report a size fall
 * back to {@link FALLBACK_PAGE_SIZE} rather than failing the whole document.
 */
export async function loadPageSizes(
  doc: Pick<PdfDocumentHandle, "pageCount" | "getPageSize">,
  { chunkSize = 32, onProgress, signal }: LoadPageSizesOptions = {},
): Promise<PageSize[]> {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError(
      `chunkSize must be a positive integer, got ${chunkSize}`,
    );
  }

  markStart("pdf:page-sizes");
  const sizes: PageSize[] = [];
  try {
    for (let start = 1; start <= doc.pageCount; start += chunkSize) {
      if (signal?.aborted) return sizes;
      const end = Math.min(start + chunkSize - 1, doc.pageCount);
      sizes.push(...(await fetchPageSizeRange(doc, start, end)));
      onProgress?.(sizes);
    }
    return sizes;
  } finally {
    markEnd("pdf:page-sizes");
  }
}

export interface LoadPageSizesProgressiveOptions {
  /** Pages awaited before this resolves. The rest load in the background. */
  firstChunk?: number;
  /** Pages queried in parallel per background batch. */
  chunkSize?: number;
  /** Called after every batch (the first one included) with the sizes collected so far. */
  onProgress?: (sizes: PageSize[]) => void;
  signal?: AbortSignal;
}

export interface ProgressivePageSizes {
  /** Sizes for the first `firstChunk` pages (or all of them, if there are fewer). */
  initial: PageSize[];
  /** Resolves once every remaining page's size has loaded in the background. */
  done: Promise<PageSize[]>;
}

/**
 * Like {@link loadPageSizes}, but only waits for the first `firstChunk` pages:
 * the rest load in the background so a large document's open is not blocked on
 * every page reporting its size. `pageSizeAt` already falls back to
 * {@link FALLBACK_PAGE_SIZE} for pages `initial` has not reached yet, so the
 * viewer can lay out with `initial` alone and simply re-render as `onProgress`
 * (or `done`) fills the rest in.
 */
export async function loadPageSizesProgressive(
  doc: Pick<PdfDocumentHandle, "pageCount" | "getPageSize">,
  {
    firstChunk = 32,
    chunkSize = 32,
    onProgress,
    signal,
  }: LoadPageSizesProgressiveOptions = {},
): Promise<ProgressivePageSizes> {
  if (!Number.isInteger(firstChunk) || firstChunk < 1) {
    throw new RangeError(
      `firstChunk must be a positive integer, got ${firstChunk}`,
    );
  }
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError(
      `chunkSize must be a positive integer, got ${chunkSize}`,
    );
  }

  markStart("pdf:page-sizes-initial");
  const sizes: PageSize[] = [];
  const firstEnd = Math.min(firstChunk, doc.pageCount);
  if (firstEnd >= 1 && !signal?.aborted) {
    sizes.push(...(await fetchPageSizeRange(doc, 1, firstEnd)));
    onProgress?.(sizes.slice());
  }
  markEnd("pdf:page-sizes-initial");
  // Snapshot: `sizes` keeps growing in the background below, and `initial`
  // must not silently grow with it out from under whoever holds it.
  const initial = sizes.slice();

  const done = (async () => {
    markStart("pdf:page-sizes-background");
    try {
      for (
        let start = firstEnd + 1;
        start <= doc.pageCount;
        start += chunkSize
      ) {
        if (signal?.aborted) return sizes;
        const end = Math.min(start + chunkSize - 1, doc.pageCount);
        sizes.push(...(await fetchPageSizeRange(doc, start, end)));
        onProgress?.(sizes.slice());
      }
      return sizes;
    } finally {
      markEnd("pdf:page-sizes-background");
    }
  })();

  return { initial, done };
}
