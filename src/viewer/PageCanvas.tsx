import { useEffect, useRef, useState } from "react";
import type { PdfDocumentHandle } from "../pdf";
import type { PageRenderCache } from "./page-cache";

interface PageCanvasProps {
  doc: PdfDocumentHandle;
  cache: PageRenderCache;
  pageNumber: number;
  scale: number;
  /** Display size in CSS pixels, reserved before the render finishes. */
  width: number;
  height: number;
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
}: PageCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
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

  return (
    <div className="page" style={{ width, height }}>
      <div className="page__surface" ref={hostRef} aria-hidden="true" />
      <span className="page__label">{pageNumber}</span>
      {error ? <p className="page__error">{error}</p> : null}
    </div>
  );
}
