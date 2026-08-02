import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Highlight } from "../files/sidecar";
import type { PdfDocumentHandle } from "../pdf";
import { previewScale } from "../pdf/canvas-scale";
import { clearStart, markEnd, markStart } from "../perf/marks";
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
    setError(null);

    // Two-stage rendering (issue #37) only ever applies to the page actually
    // on screen (`priority === "visible"`) going through a queue at all —
    // an overscan/prefetch page competing to show a *blurry* stand-in ahead
    // of some other page's full render would be a net loss, and thumbnails
    // (no `queue`) have no such urgency to begin with. Narrowed into its own
    // variable (rather than re-checking `queue` below) so TypeScript knows
    // it is defined everywhere the two-stage branch actually uses it.
    const twoStageQueue: RenderQueue | null =
      queue && priority === "visible" ? queue : null;
    const pScale = twoStageQueue
      ? previewScale(scale, width, height, window.devicePixelRatio ?? 1)
      : null;

    if (!twoStageQueue || pScale === null) {
      const canvas = document.createElement("canvas");
      canvas.className = "page__canvas";
      host.replaceChildren(canvas);

      const render = (signal: AbortSignal) =>
        doc.renderPage(pageNumber, { scale, canvas, signal }).then(() => {
          if (signal.aborted) return;
          cache.set(pageNumber, scale, canvas);
        });

      // Without a queue (thumbnails, still) the render starts immediately,
      // as before #35. With one, `priority` decides whether this page's
      // turn at the (single-slot) worker comes before or after whatever
      // else is queued — see render-queue.ts for why that matters.
      const task = queue
        ? queue.schedule(priority, render, controller.signal)
        : render(controller.signal);

      task.catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });

      return () => controller.abort();
    }

    // Two-stage path: a low-resolution preview goes up immediately (at the
    // "preview" priority, which always dequeues ahead of the full render —
    // see render-queue.ts), while the full-resolution render happens
    // offscreen and swaps in only once it is ready. The preview stays
    // mounted until that swap so the reader never sees a blank canvas in
    // between (issue #37).
    const previewMark = `viewer:preview-shown:${pageNumber}`;
    const fullMark = `viewer:full-shown:${pageNumber}`;
    markStart(previewMark);
    markStart(fullMark);

    const previewCanvas = document.createElement("canvas");
    previewCanvas.className = "page__canvas";
    host.replaceChildren(previewCanvas);

    const renderPreview = (signal: AbortSignal) =>
      // Wrapped in `Promise.resolve().then(...)` rather than calling
      // `doc.renderPage` directly: a renderer that throws synchronously
      // (instead of returning a rejected promise) would otherwise bypass
      // the `.catch` below entirely, leaking `previewMark` unmeasured.
      Promise.resolve()
        .then(() =>
          doc.renderPage(pageNumber, {
            scale: pScale,
            canvas: previewCanvas,
            signal,
          }),
        )
        .then(() => {
          if (signal.aborted) return;
          // `renderPage` sets the canvas's own CSS size to match `pScale`;
          // stretch it back out to the page's real display size now that
          // the pixels it needs are actually in place.
          previewCanvas.style.width = `${width}px`;
          previewCanvas.style.height = `${height}px`;
          markEnd(previewMark);
        })
        .catch(() => {
          // A failed preview is not fatal — the full render below is what
          // actually matters, and it reports its own failure if it fails.
          // Still clear the start mark, though: without this, a preview
          // that never reaches its `then` leaves an unmeasured start mark
          // sitting around until cleanup (or forever, if cleanup never
          // fires for this signal — e.g. `run` itself throwing before
          // `signal` is ever aborted).
          clearStart(previewMark);
        });

    const fullCanvas = document.createElement("canvas");
    fullCanvas.className = "page__canvas";

    const renderFull = (signal: AbortSignal) =>
      // Same reasoning as `renderPreview`'s wrapper above: a synchronous
      // throw from `doc.renderPage` must still reach `fullTask`'s `.catch`
      // below (which clears `fullMark` and reports the error), not escape
      // as an unhandled exception.
      Promise.resolve()
        .then(() =>
          doc.renderPage(pageNumber, { scale, canvas: fullCanvas, signal }),
        )
        .then(() => {
          if (signal.aborted) return;
          cache.set(pageNumber, scale, fullCanvas);
          host.replaceChildren(fullCanvas);
          markEnd(fullMark);
        });

    // `renderPreview` above already swallows its own rejection, so this
    // never actually rejects in practice — but `schedule`'s own promise
    // rejects too if `run` throws synchronously (see render-queue.ts), and
    // an unawaited, unhandled rejection there would surface as a console
    // warning nobody is listening for. Nothing here needs the result.
    twoStageQueue
      .schedule("preview", renderPreview, controller.signal)
      .catch(() => {});
    const fullTask = twoStageQueue.schedule(
      priority,
      renderFull,
      controller.signal,
    );

    fullTask.catch((cause: unknown) => {
      // Unconditional — unlike the `setError` below, this is safe (and
      // correct) to run even after an abort: it is a no-op if `fullMark`
      // was already cleared or measured, and otherwise is exactly the
      // cleanup that would be missed if `renderFull` threw synchronously
      // before ever reaching its own `then`.
      clearStart(fullMark);
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    });

    return () => {
      controller.abort();
      clearStart(previewMark);
      clearStart(fullMark);
    };
    // `priority` is intentionally a dependency: a change (an overscan page
    // becoming the visible one, say) must abort whatever this effect queued
    // last time and re-schedule at the new priority. The cache check above
    // makes that a no-op — never a second render — once the page is warm.
  }, [doc, cache, pageNumber, scale, width, height, queue, priority]);

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
