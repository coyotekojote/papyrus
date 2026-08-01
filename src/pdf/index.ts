export type {
  OutlineNode,
  PageSize,
  PdfDocumentHandle,
  PdfRenderer,
  RegionRect,
  RenderPageOptions,
  RenderRegionOptions,
  RenderTextLayerOptions,
} from "./types";
export { PdfPageOutOfRangeError } from "./types";
export { FALLBACK_PAGE_SIZE, loadPageSizes } from "./page-sizes";
export { LruCache } from "./lru-cache";

import type { PdfRenderer } from "./types";

/**
 * Resolves the renderer the app should use. The engine is imported lazily so
 * pdf.js (worker included) stays out of the initial bundle, and so swapping in
 * another `PdfRenderer` implementation is a one-line change here.
 */
export async function loadDefaultRenderer(): Promise<PdfRenderer> {
  const { PdfJsRenderer } = await import("./pdfjs-renderer");
  return new PdfJsRenderer();
}
