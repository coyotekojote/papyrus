import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Highlight, NormalizedRect } from "../files/sidecar";
import type { OutlineNode, PageSize, PdfDocumentHandle } from "../pdf";
import { HighlightsPanel } from "./HighlightsPanel";
import { OutlineSidebar } from "./OutlineSidebar";
import { PageCanvas } from "./PageCanvas";
import {
  CreateHighlightPopup,
  HighlightActionsPopup,
  type PopupPosition,
} from "./SelectionPopup";
import { ThumbnailList } from "./ThumbnailList";
import {
  highlightAtPoint,
  makeHighlight,
  normalizeSelectionRects,
} from "./highlights";
import { appendHighlightToNotes, useAnnotations } from "./use-annotations";
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

/**
 * How far the pointer may travel between press and release and still count as
 * a click. Anything further is a drag — a touch pan, most often — and must not
 * pop up the actions for whatever highlight it happens to end on.
 */
const CLICK_SLOP_PX = 6;

export interface PdfViewerProps {
  doc: PdfDocumentHandle;
  pageSizes: readonly PageSize[];
  /** Path of the PDF on disk; annotations live in its sidecar folder. */
  filePath: string;
  fileName: string;
  onClose: () => void;
}

type Popup =
  | {
      kind: "create";
      page: number;
      rects: NormalizedRect[];
      text: string;
      position: PopupPosition;
    }
  | { kind: "actions"; highlight: Highlight; position: PopupPosition };

/** The page element (carrying `data-page`) around a DOM node, if any. */
function closestPage(node: Node | null): HTMLElement | null {
  const element =
    node instanceof Element ? node : (node?.parentElement ?? null);
  return element?.closest<HTMLElement>(".page[data-page]") ?? null;
}

function copyToClipboard(text: string): void {
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (!clipboard) return;
  void clipboard.writeText(text).catch(() => {
    // Losing a copy is not worth an error dialog.
  });
}

export function PdfViewer({
  doc,
  pageSizes,
  filePath,
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
  const [highlightsOpen, setHighlightsOpen] = useState(false);
  const [popup, setPopup] = useState<Popup | null>(null);
  /** Why the reader's last highlight action did not happen, if it did not. */
  const [actionError, setActionError] = useState<string | null>(null);
  /** null until the outline has been fetched; the fetch happens on first open. */
  const [outline, setOutline] = useState<OutlineNode[] | null>(null);

  const annotations = useAnnotations(filePath);
  const highlightsByPage = useMemo(() => {
    const byPage = new Map<number, Highlight[]>();
    for (const highlight of annotations.annotations.highlights) {
      const list = byPage.get(highlight.page);
      if (list) list.push(highlight);
      else byPage.set(highlight.page, [highlight]);
    }
    return byPage;
  }, [annotations.annotations.highlights]);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** Where the current gesture started, for telling a click from a drag. */
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
  /** False once unmounted, so late async results skip their state updates. */
  const mountedRef = useRef(true);
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

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

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
      // The popup is anchored to viewport coordinates; scrolling moves the
      // page out from under it.
      setPopup(null);

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
    // Any direct grab of the scroller also abandons an in-flight smooth scroll
    // and dismisses a floating popup, whose anchor is about to go stale.
    const onPointerDown = (event: PointerEvent) => {
      pointerDownRef.current = { x: event.clientX, y: event.clientY };
      cancelPendingScroll();
      setPopup(null);
    };

    /**
     * A gesture that ends anywhere else — released over the sidebar, or off
     * the window entirely — never reaches the scroller's own pointerup. Left
     * behind, its start would be measured against the next release and turn a
     * genuine click into a "drag". These fire after React's handler has run.
     */
    const forgetPointerDown = () => {
      pointerDownRef.current = null;
    };

    scroller.addEventListener("wheel", onWheel, { passive: false });
    scroller.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", forgetPointerDown);
    window.addEventListener("pointercancel", forgetPointerDown);
    return () => {
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", forgetPointerDown);
      window.removeEventListener("pointercancel", forgetPointerDown);
    };
  }, [cancelPendingScroll]);

  /**
   * A finished pointer gesture either carries a text selection (offer to
   * highlight it) or is a plain click (hit-test the existing highlights).
   * Both popups anchor to the pointer, positioned inside `.viewer__body`.
   */
  const handlePointerUp = useCallback(
    (event: ReactPointerEvent) => {
      const start = pointerDownRef.current;
      pointerDownRef.current = null;
      const bodyRect = bodyRef.current?.getBoundingClientRect();
      if (!bodyRect) return;
      const position: PopupPosition = {
        left: event.clientX - bodyRect.left,
        top: event.clientY - bodyRect.top + 12,
      };

      const selection = window.getSelection();
      const range =
        selection && !selection.isCollapsed && selection.rangeCount > 0
          ? selection.getRangeAt(0)
          : null;
      // Thumbnails are pages too (same PageCanvas, same `data-page`), so a
      // selection has to be inside the scroller to be one of *these* pages —
      // otherwise its rects would be normalized against a thumbnail's box.
      const selectedInScroller = range
        ? closestPage(range.startContainer)
        : null;
      const selectedPage =
        selectedInScroller && scrollerRef.current?.contains(selectedInScroller)
          ? selectedInScroller
          : null;
      // Anything that does not yield a highlightable selection — no selection,
      // one made outside the pages (in the highlights panel, say), or one with
      // nothing to extract — leaves this a plain click, handled below.
      if (range && selectedPage) {
        // A selection running past the page it started on — onto the next one,
        // or off into a panel — is cut back to that page. Text and geometry
        // are taken from the same cut, so the extract always says exactly what
        // the highlight covers.
        const onPage = range.cloneRange();
        if (closestPage(range.endContainer) !== selectedPage) {
          // Cut at the end of the text layer, not of the page: the page also
          // holds the page-number label, which is not part of the document.
          const end = selectedPage.querySelector(".textLayer") ?? selectedPage;
          onPage.setEnd(end, end.childNodes.length);
        }
        const text = onPage.toString().trim();
        const rects = normalizeSelectionRects(
          Array.from(onPage.getClientRects()),
          selectedPage.getBoundingClientRect(),
        );
        if (text !== "" && rects.length > 0) {
          setPopup({
            kind: "create",
            page: Number(selectedPage.dataset.page),
            rects,
            text,
            position,
          });
          return;
        }
      }

      // A pan (a touch scroll, most often) ends on whatever page it drifted
      // onto. Releasing there is not a click on the highlight underneath.
      const travel = start
        ? Math.hypot(event.clientX - start.x, event.clientY - start.y)
        : 0;
      if (travel > CLICK_SLOP_PX) return;

      const pageElement = closestPage(
        event.target instanceof Node ? event.target : null,
      );
      if (!pageElement) return;
      const pageRect = pageElement.getBoundingClientRect();
      if (pageRect.width <= 0 || pageRect.height <= 0) return;
      const hit = highlightAtPoint(
        annotations.annotations.highlights,
        Number(pageElement.dataset.page),
        {
          x: (event.clientX - pageRect.left) / pageRect.width,
          y: (event.clientY - pageRect.top) / pageRect.height,
        },
      );
      if (hit) setPopup({ kind: "actions", highlight: hit, position });
    },
    [annotations.annotations.highlights],
  );

  const createHighlight = useCallback(
    (colorId: string) => {
      if (popup?.kind !== "create") return;
      // The hook drops mutations until the sidecar has loaded, so without this
      // the popup would close as if the highlight had been saved.
      if (!annotations.loaded) {
        setActionError(
          "注釈をまだ読み込めていないため、ハイライトを保存できません",
        );
        setHighlightsOpen(true);
        setPopup(null);
        return;
      }
      setActionError(null);
      annotations.addHighlight(
        makeHighlight({
          page: popup.page,
          rects: popup.rects,
          color: colorId,
          text: popup.text,
          createdAt: new Date(),
        }),
      );
      window.getSelection()?.removeAllRanges();
      setPopup(null);
    },
    [annotations, popup],
  );

  const insertToNotes = useCallback(
    (highlight: Highlight) => {
      setActionError(null);
      appendHighlightToNotes(filePath, highlight).catch((cause: unknown) => {
        // The write outlives the viewer if the reader closes the document
        // while it is in flight; there is then nobody left to tell.
        if (!mountedRef.current) return;
        setActionError(cause instanceof Error ? cause.message : String(cause));
        setHighlightsOpen(true);
      });
    },
    [filePath],
  );

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
        <button
          type="button"
          className="toolbar__button"
          aria-pressed={highlightsOpen}
          onClick={() => setHighlightsOpen((open) => !open)}
        >
          ハイライト
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

      <div className="viewer__body" ref={bodyRef}>
        {sidebarOpen ? (
          <aside
            className="sidebar"
            aria-label="目次"
            // The window-level page-turn shortcut must not swallow arrow keys
            // meant for the focused tree or thumbnail list.
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.stopPropagation();
              }
            }}
          >
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
          onPointerUp={handlePointerUp}
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
                        highlights={highlightsByPage.get(pageNumber)}
                        withTextLayer
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

        {highlightsOpen ? (
          <aside
            className="sidebar sidebar--right"
            aria-label="ハイライト"
            // Same as the outline sidebar: keep arrow keys away from the
            // window-level page-turn shortcut while the panel has focus.
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.stopPropagation();
              }
            }}
          >
            {(annotations.error ?? actionError) ? (
              <p className="sidebar__status sidebar__status--error">
                {annotations.error ?? actionError}
              </p>
            ) : null}
            {annotations.loaded ? (
              <HighlightsPanel
                highlights={annotations.annotations.highlights}
                onJumpToPage={goToPage}
                onCopy={(highlight) => copyToClipboard(highlight.text)}
                onInsertToNotes={insertToNotes}
                onDelete={(highlight) =>
                  annotations.removeHighlight(highlight.id)
                }
              />
            ) : annotations.error ? null : (
              // Only while the load is genuinely in flight: a failed load is
              // already reported above and is never going to finish.
              <p className="sidebar__status">読み込み中…</p>
            )}
          </aside>
        ) : null}

        {popup?.kind === "create" ? (
          <CreateHighlightPopup
            position={popup.position}
            onPick={createHighlight}
            onDismiss={() => setPopup(null)}
          />
        ) : null}
        {popup?.kind === "actions" ? (
          <HighlightActionsPopup
            position={popup.position}
            onCopy={() => {
              copyToClipboard(popup.highlight.text);
              setPopup(null);
            }}
            onInsertToNotes={() => {
              insertToNotes(popup.highlight);
              setPopup(null);
            }}
            onDelete={() => {
              annotations.removeHighlight(popup.highlight.id);
              setPopup(null);
            }}
            onDismiss={() => setPopup(null)}
          />
        ) : null}
      </div>
    </div>
  );
}
