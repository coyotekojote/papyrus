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

/** A rectangle in page-normalized (0-1) coordinates, as annotations store it. */
export interface RegionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RenderRegionOptions {
  /** The part of the page to cut out, in page-normalized (0-1) coordinates. */
  rect: RegionRect;
  /** Aborts an in-flight render (e.g. the reader left the document). */
  signal?: AbortSignal;
}

export interface RenderTextLayerOptions {
  /** Same scale as the page canvas, so the text sits exactly over the paint. */
  scale: number;
  /** Target element. The renderer owns its contents and sizing during the call. */
  container: HTMLElement;
  /** Aborts an in-flight render (e.g. the page scrolled out of range). */
  signal?: AbortSignal;
}

/**
 * One bookmark of the document outline.
 *
 * Destinations are resolved by the renderer, so the rest of the app never sees
 * an engine-specific destination object. `pageNumber` is null when a bookmark
 * points somewhere unresolvable (an external URL, or a broken destination).
 */
export interface OutlineNode {
  title: string;
  /** 1-based page number, or null when the destination could not be resolved. */
  pageNumber: number | null;
  children: OutlineNode[];
}

/** An opened document. Always `destroy()` it when done. */
export interface PdfDocumentHandle {
  readonly pageCount: number;
  /** 1-based page number. Rejects for out-of-range pages. */
  getPageSize(pageNumber: number): Promise<PageSize>;
  /** 1-based page number. Draws the page into `options.canvas`. */
  renderPage(pageNumber: number, options: RenderPageOptions): Promise<void>;
  /**
   * 1-based page number. Renders just `options.rect` of the page, at a higher
   * resolution than the screen shows, and resolves to it as a PNG.
   */
  renderRegion(pageNumber: number, options: RenderRegionOptions): Promise<Blob>;
  /**
   * 1-based page number. Fills `options.container` with selectable text spans
   * positioned over the rendered page (replacing any previous contents).
   */
  renderTextLayer(
    pageNumber: number,
    options: RenderTextLayerOptions,
  ): Promise<void>;
  /** Bookmark tree with destinations already resolved. Empty when there is none. */
  getOutline(): Promise<OutlineNode[]>;
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
