import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OutlineNode, PageSize, PdfDocumentHandle } from "../pdf";
import { OutlineSidebar } from "./OutlineSidebar";
import { PageCanvas } from "./PageCanvas";
import { ThumbnailList } from "./ThumbnailList";
import {
  PAGE_GAP,
  SPREAD_PADDING,
  pageDisplaySize,
  pageSizeAt,
  spreadBoxWidth,
  spreadContentHeight,
  spreadContentWidth,
} from "./layout";
import { PageRenderCache } from "./page-cache";
import {
  buildSpreads,
  clampSpreadIndex,
  leadPage,
  spreadIndexOfPage,
  stepForArrowKey,
  toDomIndex,
  visualPageOrder,
  wheelScrollDelta,
  type Binding,
  type ViewMode,
} from "./spreads";
import {
  computeLayout,
  nearestItemIndex,
  rangeIncludes,
  scrollOffsetForItem,
  visibleRange,
} from "./virtualization";
import {
  DEFAULT_ZOOM,
  applyZoomCommand,
  pinchZoom,
  zoomCommandForKey,
  type ZoomCommand,
} from "./zoom";

/** Spreads rendered on each side of the visible one. */
const OVERSCAN = 1;

export interface PdfViewerProps {
  doc: PdfDocumentHandle;
  pageSizes: readonly PageSize[];
  fileName: string;
  onClose: () => void;
}

export function PdfViewer({
  doc,
  pageSizes,
  fileName,
  onClose,
}: PdfViewerProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("single");
  const [binding, setBinding] = useState<Binding>("left");
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [currentPage, setCurrentPage] = useState(1);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /** null until the outline has been fetched; the fetch happens on first open. */
  const [outline, setOutline] = useState<OutlineNode[] | null>(null);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const cacheRef = useRef<PageRenderCache | null>(null);
  cacheRef.current ??= new PageRenderCache();
  const cache = cacheRef.current;

  /** DOM index we scrolled to on purpose; scroll events ignore it until reached. */
  const pendingDomIndexRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);

  const spreads = useMemo(
    () => buildSpreads(doc.pageCount, viewMode),
    [doc.pageCount, viewMode],
  );
  const total = spreads.length;

  const spreadIndex = clampSpreadIndex(
    Math.max(0, spreadIndexOfPage(spreads, currentPage)),
    total,
  );
  const spreadIndexRef = useRef(spreadIndex);
  spreadIndexRef.current = spreadIndex;
  // Read inside the wheel listener so it never has to be re-registered.
  const bindingRef = useRef(binding);
  bindingRef.current = binding;

  /** Spreads in scroll order: reversed for a right-bound book. */
  const domSpreads = useMemo(
    () => spreads.map((_, index) => spreads[toDomIndex(index, total, binding)]),
    [spreads, total, binding],
  );

  const layout = useMemo(
    () =>
      computeLayout(
        domSpreads.map((spread) =>
          spreadBoxWidth(
            spreadContentWidth(spread, pageSizes, zoom, PAGE_GAP),
            viewportWidth,
            SPREAD_PADDING,
          ),
        ),
      ),
    [domSpreads, pageSizes, zoom, viewportWidth],
  );

  const range = useMemo(
    () => visibleRange(layout, scrollLeft, viewportWidth, OVERSCAN),
    [layout, scrollLeft, viewportWidth],
  );

  // Measure the scroll viewport; every layout number below depends on it.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    setViewportWidth(scroller.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      setViewportWidth(entry.contentRect.width);
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  // Free rendered canvases when the document is closed.
  useEffect(() => () => cache.clear(), [cache]);

  const goToSpread = useCallback(
    (index: number, behavior: ScrollBehavior = "smooth") => {
      if (total === 0) return;
      const next = clampSpreadIndex(index, total);
      setCurrentPage(leadPage(spreads[next]));
      const domIndex = toDomIndex(next, total, binding);
      pendingDomIndexRef.current = domIndex;
      scrollerRef.current?.scrollTo({
        left: scrollOffsetForItem(layout, domIndex, viewportWidth),
        behavior,
      });
    },
    [binding, layout, spreads, total, viewportWidth],
  );

  // Keep the current spread on screen when the layout changes (zoom, view mode,
  // binding, window resize). Deliberately not triggered by `spreadIndex`, which
  // would fight the user's own scrolling.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || total === 0) return;
    const domIndex = toDomIndex(spreadIndexRef.current, total, binding);
    pendingDomIndexRef.current = domIndex;
    scroller.scrollTo({
      left: scrollOffsetForItem(layout, domIndex, viewportWidth),
      behavior: "auto",
    });
  }, [layout, viewportWidth, binding, total]);

  /**
   * Abandons an in-flight programmatic scroll. Without this, interrupting a
   * smooth scroll (wheel, drag) would leave the target latched forever and the
   * page indicator stuck at a position the viewer is no longer at.
   */
  const cancelPendingScroll = useCallback(() => {
    pendingDomIndexRef.current = null;
  }, []);

  const handleScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const scroller = scrollerRef.current;
      if (!scroller) return;

      const left = scroller.scrollLeft;
      setScrollLeft(left);

      const nearest = nearestItemIndex(layout, left, viewportWidth);
      if (pendingDomIndexRef.current !== null) {
        if (pendingDomIndexRef.current !== nearest) return;
        pendingDomIndexRef.current = null;
      }
      const spread = domSpreads[nearest];
      if (spread) setCurrentPage(leadPage(spread));
    });
  }, [domSpreads, layout, viewportWidth]);

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
    },
    [],
  );

  const goToPage = useCallback(
    (pageNumber: number) => {
      const index = spreadIndexOfPage(spreads, pageNumber);
      if (index >= 0) goToSpread(index, "auto");
    },
    [goToSpread, spreads],
  );

  // Fetched lazily: a document the reader never opens the sidebar for should
  // not pay for resolving every bookmark destination.
  useEffect(() => {
    if (!sidebarOpen || outline !== null) return;
    let cancelled = false;
    void doc
      .getOutline()
      .then((nodes) => {
        if (!cancelled) setOutline(nodes);
      })
      .catch(() => {
        if (!cancelled) setOutline([]);
      });
    return () => {
      cancelled = true;
    };
  }, [doc, sidebarOpen, outline]);

  const runZoomCommand = useCallback((command: ZoomCommand) => {
    setZoom((current) => applyZoomCommand(current, command));
  }, []);

  // Keyboard: arrows follow the binding direction, Cmd/Ctrl +/-/0 zoom.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const zoomCommand = zoomCommandForKey(event);
      if (zoomCommand) {
        event.preventDefault();
        runZoomCommand(zoomCommand);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const step = stepForArrowKey(event.key, binding);
      if (step !== 0) {
        event.preventDefault();
        goToSpread(spreadIndexRef.current + step);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [binding, goToSpread, runZoomCommand]);

  // Pinch-to-zoom arrives as ctrl+wheel; a plain vertical wheel scrolls the
  // horizontal track, which is the only axis this viewer has.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        setZoom((current) => pinchZoom(current, event.deltaY));
        return;
      }
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        event.preventDefault();
        cancelPendingScroll();
        scroller.scrollBy({
          left: wheelScrollDelta(event.deltaY, bindingRef.current),
          behavior: "auto",
        });
      } else if (event.deltaX !== 0) {
        cancelPendingScroll();
      }
    };
    // Any direct grab of the scroller also abandons an in-flight smooth scroll.
    const onPointerDown = () => cancelPendingScroll();

    scroller.addEventListener("wheel", onWheel, { passive: false });
    scroller.addEventListener("pointerdown", onPointerDown);
    return () => {
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("pointerdown", onPointerDown);
    };
  }, [cancelPendingScroll]);

  const currentSpread = spreads[spreadIndex] ?? [];
  const pageLabel =
    currentSpread.length > 1
      ? `${currentSpread[0]}–${currentSpread.at(-1)} / ${doc.pageCount}`
      : `${currentSpread[0] ?? 0} / ${doc.pageCount}`;

  return (
    <div className="viewer">
      <header className="toolbar">
        <button type="button" className="toolbar__button" onClick={onClose}>
          ← ライブラリ
        </button>
        <button
          type="button"
          className="toolbar__button"
          aria-pressed={sidebarOpen}
          onClick={() => setSidebarOpen((open) => !open)}
        >
          目次
        </button>
        <span className="toolbar__title" title={fileName}>
          {fileName}
        </span>

        <div className="toolbar__group" role="group" aria-label="ページ送り">
          <button
            type="button"
            className="toolbar__button"
            onClick={() => goToSpread(spreadIndex - 1)}
            disabled={spreadIndex <= 0}
            aria-label="前のページ"
          >
            {binding === "right" ? "→" : "←"}
          </button>
          <span className="toolbar__page">{pageLabel}</span>
          <button
            type="button"
            className="toolbar__button"
            onClick={() => goToSpread(spreadIndex + 1)}
            disabled={spreadIndex >= total - 1}
            aria-label="次のページ"
          >
            {binding === "right" ? "←" : "→"}
          </button>
        </div>

        <div className="toolbar__group" role="group" aria-label="表示">
          <button
            type="button"
            className="toolbar__button"
            aria-pressed={viewMode === "spread"}
            onClick={() =>
              setViewMode((mode) => (mode === "single" ? "spread" : "single"))
            }
          >
            {viewMode === "spread" ? "見開き" : "単ページ"}
          </button>
          <button
            type="button"
            className="toolbar__button"
            aria-pressed={binding === "right"}
            onClick={() =>
              setBinding((current) => (current === "left" ? "right" : "left"))
            }
          >
            {binding === "right" ? "右綴じ" : "左綴じ"}
          </button>
        </div>

        <div className="toolbar__group" role="group" aria-label="ズーム">
          <button
            type="button"
            className="toolbar__button"
            onClick={() => runZoomCommand("out")}
            aria-label="縮小"
          >
            −
          </button>
          <button
            type="button"
            className="toolbar__button"
            onClick={() => runZoomCommand("reset")}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            className="toolbar__button"
            onClick={() => runZoomCommand("in")}
            aria-label="拡大"
          >
            +
          </button>
        </div>
      </header>

      <div className="viewer__body">
        {sidebarOpen ? (
          <aside className="sidebar" aria-label="目次">
            {outline === null ? (
              <p className="sidebar__status">読み込み中…</p>
            ) : outline.length > 0 ? (
              <OutlineSidebar
                nodes={outline}
                currentPage={currentPage}
                onJumpToPage={goToPage}
              />
            ) : (
              // No bookmarks: thumbnails are the only table of contents this
              // document can offer.
              <ThumbnailList
                doc={doc}
                pageSizes={pageSizes}
                currentPage={currentPage}
                onJumpToPage={goToPage}
              />
            )}
          </aside>
        ) : null}

        <div
          className="scroller"
          ref={scrollerRef}
          onScroll={handleScroll}
          tabIndex={0}
          role="region"
          aria-label="PDFページ"
        >
          {domSpreads.map((spread, domIndex) => {
            const box = layout[domIndex];
            const visible = rangeIncludes(range, domIndex);
            return (
              <div
                className="spread"
                key={leadPage(spread)}
                style={{ width: box?.size ?? 0 }}
              >
                {visible ? (
                  visualPageOrder(spread, binding).map((pageNumber) => {
                    const size = pageDisplaySize(
                      pageSizeAt(pageSizes, pageNumber),
                      zoom,
                    );
                    return (
                      <PageCanvas
                        key={pageNumber}
                        doc={doc}
                        cache={cache}
                        pageNumber={pageNumber}
                        scale={zoom}
                        width={size.width}
                        height={size.height}
                      />
                    );
                  })
                ) : (
                  // Not rendered: reserve the exact page footprint so the scroll
                  // track never shifts when this spread comes into view.
                  <div
                    className="page page--placeholder"
                    style={{
                      width: spreadContentWidth(
                        spread,
                        pageSizes,
                        zoom,
                        PAGE_GAP,
                      ),
                      height: spreadContentHeight(spread, pageSizes, zoom),
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
