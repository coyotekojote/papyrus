/**
 * Renderer-agnostic PDF abstraction.
 *
 * Nothing outside `src/pdf/` may import a concrete engine (pdf.js today,
 * possibly pdfium via Rust later). The rest of the app only knows these types.
 */

/** Page dimensions in CSS pixels at scale 1 (i.e. the PDF's own 72dpi units). */
export interface PageSize {
  width: number;
  height: number;
}

export interface RenderPageOptions {
  /** 1 = natural size. The renderer applies device pixel ratio internally. */
  scale: number;
  /** Target canvas. The renderer owns its width/height/style during the call. */
  canvas: HTMLCanvasElement;
  /** Aborts an in-flight render (e.g. the page scrolled out of range). */
  signal?: AbortSignal;
}

/** An opened document. Always `destroy()` it when done. */
export interface PdfDocumentHandle {
  readonly pageCount: number;
  /** 1-based page number. Rejects for out-of-range pages. */
  getPageSize(pageNumber: number): Promise<PageSize>;
  /** 1-based page number. Draws the page into `options.canvas`. */
  renderPage(pageNumber: number, options: RenderPageOptions): Promise<void>;
  destroy(): Promise<void>;
}

export interface PdfRenderer {
  /** Stable identifier, useful for diagnostics and cache keys. */
  readonly id: string;
  open(data: Uint8Array): Promise<PdfDocumentHandle>;
}

export class PdfPageOutOfRangeError extends Error {
  constructor(
    readonly pageNumber: number,
    readonly pageCount: number,
  ) {
    super(`Page ${pageNumber} is out of range (1..${pageCount})`);
    this.name = "PdfPageOutOfRangeError";
  }
}
