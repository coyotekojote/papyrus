import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Highlight } from "../files/sidecar";
import type { PdfDocumentHandle } from "../pdf";
import { highlightColorCss } from "./highlights";
import type { PageRenderCache } from "./page-cache";

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

    doc
      .renderPage(pageNumber, { scale, canvas, signal: controller.signal })
      .then(() => {
        if (controller.signal.aborted) return;
        cache.set(pageNumber, scale, canvas);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => controller.abort();
  }, [doc, cache, pageNumber, scale]);

  // The text layer is cheap relative to the canvas and never cached: it is
  // rebuilt whenever the page mounts or the zoom changes.
  useEffect(() => {
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
