import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Highlight } from "../files/sidecar";
import type { PdfDocumentHandle } from "../pdf";
import { highlightColorCss } from "./highlights";
import type { PageRenderCache } from "./page-cache";
import type { RenderPriority, RenderQueue } from "./render-queue";

interface PageCanvasProps {
  doc: PdfDocumentHandle;
  cache: PageRenderCache;
  pageNumber: number;
  scale: number;
  /** Display size in CSS pixels, reserved before the render finishes. */
  width: number;
  height: number;
  /** Highlights belonging to this page. Omit to render a bare page (thumbnails). */
  highlights?: readonly Highlight[];
  /** Also mounts the selectable text layer. Off for thumbnails. */
  withTextLayer?: boolean;
  /**
   * Routes this page's render through the given queue instead of calling
   * `doc.renderPage` straight away (issue #35). Omitted by `ThumbnailList`,
   * whose pages never compete with the main viewer for the worker's
   * attention and so have no priority worth expressing.
   */
  queue?: RenderQueue;
  /** Ignored without `queue`. Defaults to `"visible"`, the only sensible
   * choice for a caller that passes a queue but no priority. */
  priority?: RenderPriority;
}

/**
 * One rendered page. The canvas is created imperatively so a cached canvas can
 * be re-attached as-is — re-rendering a page that is still in the cache would
 * defeat the point of caching it.
 */
export function PageCanvas({
  doc,
  cache,
  pageNumber,
  scale,
  width,
  height,
  highlights = [],
  withTextLayer = false,
  queue,
  priority = "visible",
}: PageCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const cached = cache.get(pageNumber, scale);
    if (cached) {
      host.replaceChildren(cached);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const canvas = document.createElement("canvas");
    canvas.className = "page__canvas";
    host.replaceChildren(canvas);
    setError(null);

    const render = (signal: AbortSignal) =>
      doc.renderPage(pageNumber, { scale, canvas, signal }).then(() => {
        if (signal.aborted) return;
        cache.set(pageNumber, scale, canvas);
      });

    // Without a queue (thumbnails, still) the render starts immediately, as
    // before #35. With one, `priority` decides whether this page's turn at
    // the (single-slot) worker comes before or after whatever else is
    // queued — see render-queue.ts for why that matters.
    const task = queue
      ? queue.schedule(priority, render, controller.signal)
      : render(controller.signal);

    task.catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    });

    return () => controller.abort();
    // `priority` is intentionally a dependency: a change (an overscan page
    // becoming the visible one, say) must abort whatever this effect queued
    // last time and re-schedule at the new priority. The cache check above
    // makes that a no-op — never a second render — once the page is warm.
  }, [doc, cache, pageNumber, scale, queue, priority]);

  // The text layer is cheap relative to the canvas and never cached: it is
  // rebuilt whenever the page mounts or the zoom changes.
  useEffect(() => {
    if (!withTextLayer) return;
    const container = textLayerRef.current;
    if (!container) return;

    const controller = new AbortController();
    doc
      .renderTextLayer(pageNumber, {
        scale,
        container,
        signal: controller.signal,
      })
      .catch(() => {
        // A page without a text layer is still readable; selection just
        // won't work there.
      });
    return () => controller.abort();
  }, [doc, pageNumber, scale, withTextLayer]);

  return (
    <div
      className="page"
      data-page={pageNumber}
      style={
        // pdf.js's text layer sizes its font off this variable.
        { width, height, "--total-scale-factor": scale } as CSSProperties
      }
    >
      <div className="page__surface" ref={hostRef} aria-hidden="true" />
      {highlights.length > 0 ? (
        <div className="page__highlights" aria-hidden="true">
          {highlights.flatMap((highlight) =>
            highlight.rects.map((rect, index) => (
              <div
                key={`${highlight.id}:${index}`}
                className="page__highlight"
                style={{
                  left: `${rect.x * 100}%`,
                  top: `${rect.y * 100}%`,
                  width: `${rect.w * 100}%`,
                  height: `${rect.h * 100}%`,
                  background: highlightColorCss(highlight.color),
                }}
              />
            )),
          )}
        </div>
      ) : null}
      {withTextLayer ? <div className="textLayer" ref={textLayerRef} /> : null}
      <span className="page__label">{pageNumber}</span>
      {error ? <p className="page__error">{error}</p> : null}
    </div>
  );
}
