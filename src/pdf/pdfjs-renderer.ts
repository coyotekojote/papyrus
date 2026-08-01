import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist";
// Vite resolves `?url` to the emitted asset URL, so the worker ships with the
// bundle instead of being fetched from a CDN (which the app's CSP forbids).
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

import { backingStoreRatio } from "./canvas-scale";
import { resolveOutline } from "./outline-resolve";
import {
  PdfPageOutOfRangeError,
  type OutlineNode,
  type PageSize,
  type PdfDocumentHandle,
  type PdfRenderer,
  type RenderPageOptions,
} from "./types";

GlobalWorkerOptions.workerSrc = workerUrl;

function devicePixelRatio(): number {
  return typeof window === "undefined" ? 1 : (window.devicePixelRatio ?? 1);
}

class PdfJsDocument implements PdfDocumentHandle {
  readonly pageCount: number;

  private readonly pages = new Map<number, Promise<PDFPageProxy>>();
  private outline: Promise<OutlineNode[]> | null = null;
  private destroyed = false;

  constructor(
    private readonly doc: PDFDocumentProxy,
    private readonly loadingTask: PDFDocumentLoadingTask,
  ) {
    this.pageCount = doc.numPages;
  }

  private page(pageNumber: number): Promise<PDFPageProxy> {
    if (
      !Number.isInteger(pageNumber) ||
      pageNumber < 1 ||
      pageNumber > this.pageCount
    ) {
      return Promise.reject(
        new PdfPageOutOfRangeError(pageNumber, this.pageCount),
      );
    }
    let pending = this.pages.get(pageNumber);
    if (!pending) {
      pending = this.doc.getPage(pageNumber);
      this.pages.set(pageNumber, pending);
    }
    return pending;
  }

  async getPageSize(pageNumber: number): Promise<PageSize> {
    const page = await this.page(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    return { width: viewport.width, height: viewport.height };
  }

  async renderPage(
    pageNumber: number,
    { scale, canvas, signal }: RenderPageOptions,
  ): Promise<void> {
    const page = await this.page(pageNumber);
    if (signal?.aborted || this.destroyed) return;

    const cssViewport = page.getViewport({ scale });
    // May be < 1 for very large pages or extreme zoom: the backing store is
    // then coarser than the CSS size, which is the only way to stay paintable.
    const ratio = backingStoreRatio(
      cssViewport.width,
      cssViewport.height,
      devicePixelRatio(),
    );
    const viewport = page.getViewport({ scale: scale * ratio });

    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    canvas.style.width = `${cssViewport.width}px`;
    canvas.style.height = `${cssViewport.height}px`;

    const context = canvas.getContext("2d");
    if (!context) throw new Error("Failed to acquire a 2d canvas context");

    const task: RenderTask = page.render({
      canvas,
      canvasContext: context,
      viewport,
    });
    const onAbort = () => task.cancel();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await task.promise;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Resolving every bookmark costs one worker round-trip per destination, so
   * the whole tree is resolved once and the promise reused from then on.
   */
  getOutline(): Promise<OutlineNode[]> {
    this.outline ??= this.doc
      .getOutline()
      .then((items) => resolveOutline(items, this.doc))
      .catch(() => []);
    return this.outline;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pages.clear();
    // Destroying the loading task also tears down the worker-side document.
    await this.loadingTask.destroy();
  }
}

export class PdfJsRenderer implements PdfRenderer {
  readonly id = "pdfjs";

  async open(data: Uint8Array): Promise<PdfDocumentHandle> {
    // pdf.js transfers and neuters the buffer it is given, so hand it a copy:
    // callers (and the recent-files retry path) keep using their own bytes.
    const loadingTask = getDocument({
      data: data.slice(),
      // Bundled by the `papyrus:pdfjs-runtime-assets` Vite plugin. Without
      // these, CJK documents fall back to substituted glyphs.
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      wasmUrl: "/pdfjs/wasm/",
    });
    const doc = await loadingTask.promise;
    return new PdfJsDocument(doc, loadingTask);
  }
}
