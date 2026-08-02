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
      const batch = await Promise.all(
        Array.from({ length: end - start + 1 }, (_, i) =>
          doc.getPageSize(start + i).catch(() => FALLBACK_PAGE_SIZE),
        ),
      );
      sizes.push(...batch);
      onProgress?.(sizes);
    }
    return sizes;
  } finally {
    markEnd("pdf:page-sizes");
  }
}
