// Must stay above the pdf.js import: it patches globals pdf.js depends on.
import "./polyfills";

import {
  GlobalWorkerOptions,
  TextLayer,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist";
// Vite bundles the worker entry and resolves `?worker&url` to the emitted
// asset URL, so the worker ships with the bundle instead of being fetched from
// a CDN (which the app's CSP forbids). Handing pdf.js a URL rather than a
// `workerPort` keeps it owning the worker's lifetime, so `destroy()` still
// tears it down per document.
import workerUrl from "./pdf-worker?worker&url";

import { backingStoreRatio } from "./canvas-scale";
import { resolveOutline } from "./outline-resolve";
import { markEnd, markStart } from "../perf/marks";
import { LruCache } from "./lru-cache";
import { clampRegion } from "./region";
import {
  PdfPageOutOfRangeError,
  type OutlineNode,
  type PageSize,
  type PdfDocumentHandle,
  type PdfRenderer,
  type RenderPageOptions,
  type RenderRegionOptions,
  type RenderTextLayerOptions,
} from "./types";

GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Resolution a clipped region is rendered at, as a multiple of the page's
 * natural size. Clips are meant to survive being looked at outside the app —
 * in a note, on another device's screen — so they are cut at more than the
 * viewer itself ever shows. `backingStoreRatio` caps it when the region is
 * large enough that the canvas would stop being paintable.
 */
const CLIP_SCALE = 3;

/**
 * How many `PDFPageProxy` objects a document keeps alive at once. Unlike
 * {@link PageRenderCache}, this is not about rendered pixels — a page proxy
 * mainly holds parsed content-stream/operator-list state — but a document the
 * reader scrolls end to end (a scan, a long thesis) would otherwise grow this
 * without bound for as long as the document stays open.
 */
const PAGE_PROXY_CACHE_CAPACITY = 64;

/**
 * Releases a page proxy's resources once it is no longer cached. Evicting a
 * promise that has not resolved yet is safe: the fetch already in flight is
 * left to finish on its own (pdf.js has no way to cancel `getPage`), and
 * `cleanup` simply runs once it does. If the proxy is mid-render when this
 * fires, `cleanup` reports that by returning `false` rather than throwing —
 * nothing else to do here but leave it be until it is next evicted.
 */
function cleanupPage(pending: Promise<PDFPageProxy>): void {
  pending.then(
    (page) => {
      page.cleanup();
    },
    () => {
      // The fetch itself failed — there is no proxy to clean up.
    },
  );
}

function devicePixelRatio(): number {
  return typeof window === "undefined" ? 1 : (window.devicePixelRatio ?? 1);
}

/**
 * Unlike a page render — where an abort just leaves a canvas nobody looks at —
 * a clip has to resolve to an image or not at all, so an abandoned one fails
 * loudly instead of handing back a half-painted picture.
 */
function throwIfAborted(
  signal: AbortSignal | undefined,
  destroyed: boolean,
): void {
  if (signal?.aborted || destroyed) {
    throw new Error("The region render was cancelled");
  }
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Failed to encode the region as PNG"));
    }, "image/png");
  });
}

class PdfJsDocument implements PdfDocumentHandle {
  readonly pageCount: number;

  private readonly pages = new LruCache<number, Promise<PDFPageProxy>>(
    PAGE_PROXY_CACHE_CAPACITY,
    (_, pending) => cleanupPage(pending),
  );
  private outline: Promise<OutlineNode[]> | null = null;
  private destroyed = false;
  /** Marks only the very first `renderPage` on this document — the one that
   * decides how long the reader stares at a blank page after opening. */
  private firstRenderMarked = false;

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
    const isFirstRender = !this.firstRenderMarked;
    this.firstRenderMarked = true;
    if (isFirstRender) markStart("pdfjs:first-render-page");

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
      if (isFirstRender) markEnd("pdfjs:first-render-page");
    }
  }

  async renderRegion(
    pageNumber: number,
    { rect, signal }: RenderRegionOptions,
  ): Promise<Blob> {
    const page = await this.page(pageNumber);
    throwIfAborted(signal, this.destroyed);

    const natural = page.getViewport({ scale: 1 });
    const region = clampRegion(rect);
    const regionWidth = region.w * natural.width;
    const regionHeight = region.h * natural.height;
    if (regionWidth <= 0 || regionHeight <= 0) {
      throw new Error("Cannot render an empty region");
    }

    const scale = backingStoreRatio(regionWidth, regionHeight, CLIP_SCALE);
    // Offsetting the viewport shifts the region's top-left onto the canvas
    // origin, so only that part of the page is ever painted — rendering the
    // whole page and cropping afterwards would cost the full page's pixels.
    const viewport = page.getViewport({
      scale,
      offsetX: -region.x * natural.width * scale,
      offsetY: -region.y * natural.height * scale,
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(regionWidth * scale));
    canvas.height = Math.max(1, Math.round(regionHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Failed to acquire a 2d canvas context");
    // PDF pages have no background of their own; without this the clip would
    // be transparent wherever the page is blank.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);

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
    throwIfAborted(signal, this.destroyed);
    return canvasToPng(canvas);
  }

  async renderTextLayer(
    pageNumber: number,
    { scale, container, signal }: RenderTextLayerOptions,
  ): Promise<void> {
    const page = await this.page(pageNumber);
    if (signal?.aborted || this.destroyed) return;

    // The layer positions spans in page-percentages and sizes the font off the
    // `--total-scale-factor` CSS variable, which the page element provides.
    container.replaceChildren();
    const layer = new TextLayer({
      textContentSource: page.streamTextContent(),
      container,
      viewport: page.getViewport({ scale }),
    });
    const onAbort = () => layer.cancel();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await layer.render();
    } catch (cause) {
      // Cancelling rejects with pdf.js's AbortException; that is not a failure.
      if (signal?.aborted) return;
      throw cause;
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
      .then((items) =>
        resolveOutline(items, this.doc, { pageCount: this.pageCount }),
      )
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
    markStart("pdfjs:open");
    // pdf.js transfers and neuters the buffer it is given. Every caller in
    // this app (App.tsx's openPath, PdfCover's renderCover) reads `data`
    // fresh from disk right before this call and never touches it again, so
    // there is nothing left for a defensive copy to protect — handing pdf.js
    // the buffer directly avoids doubling peak memory on a large PDF. A
    // future caller that needs to keep using its own bytes must copy before
    // calling `open`, per the `PdfRenderer.open` contract.
    const loadingTask = getDocument({
      data,
      // Bundled by the `papyrus:pdfjs-runtime-assets` Vite plugin. Without
      // these, CJK documents fall back to substituted glyphs.
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      wasmUrl: "/pdfjs/wasm/",
    });
    try {
      const doc = await loadingTask.promise;
      return new PdfJsDocument(doc, loadingTask);
    } finally {
      markEnd("pdfjs:open");
    }
  }
}
