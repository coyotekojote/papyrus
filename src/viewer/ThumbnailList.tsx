import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PageSize, PdfDocumentHandle } from "../pdf";
import { pageDisplaySize, pageSizeAt } from "./layout";
import { PageCanvas } from "./PageCanvas";
import { PageRenderCache } from "./page-cache";
import {
  computeLayout,
  rangeIncludes,
  scrollOffsetForItem,
  visibleRange,
} from "./virtualization";

/** Width of a thumbnail in CSS pixels; the scale follows from the page size. */
const THUMBNAIL_WIDTH = 120;
/** Vertical gap between thumbnails, including room for the page number. */
const THUMBNAIL_GAP = 28;
/** Thumbnails rendered above and below the visible window. */
const OVERSCAN = 2;

interface ThumbnailListProps {
  doc: PdfDocumentHandle;
  pageSizes: readonly PageSize[];
  currentPage: number;
  onJumpToPage: (pageNumber: number) => void;
}

function thumbnailScale(size: PageSize): number {
  return size.width > 0 ? THUMBNAIL_WIDTH / size.width : 1;
}

/**
 * Page thumbnails, shown in place of the outline for documents that have no
 * bookmarks. Virtualized vertically so a 500-page document costs the same as a
 * short one.
 */
export function ThumbnailList({
  doc,
  pageSizes,
  currentPage,
  onJumpToPage,
}: ThumbnailListProps) {
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Scroll events fire faster than frames paint; fold them to one state
  // update per frame, the same way the main viewer's scroller does.
  const scrollFrameRef = useRef<number | null>(null);
  const handleScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const scroller = scrollerRef.current;
      if (scroller) setScrollTop(scroller.scrollTop);
    });
  }, []);
  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
    },
    [],
  );

  // Thumbnails are rendered at their own scale, so they need a cache of their
  // own rather than evicting the main viewer's full-size pages.
  const cacheRef = useRef<PageRenderCache | null>(null);
  cacheRef.current ??= new PageRenderCache();
  const cache = cacheRef.current;
  useEffect(() => () => cache.clear(), [cache]);

  /** Display size and render scale of every page, in page order. */
  const thumbnails = useMemo(
    () =>
      Array.from({ length: doc.pageCount }, (_, index) => {
        const natural = pageSizeAt(pageSizes, index + 1);
        const scale = thumbnailScale(natural);
        return { scale, size: pageDisplaySize(natural, scale) };
      }),
    [doc.pageCount, pageSizes],
  );

  const layout = useMemo(
    () =>
      computeLayout(
        thumbnails.map((thumbnail) => thumbnail.size.height),
        THUMBNAIL_GAP,
      ),
    [thumbnails],
  );

  const range = useMemo(
    () => visibleRange(layout, scrollTop, viewportHeight, OVERSCAN),
    [layout, scrollTop, viewportHeight],
  );

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    setViewportHeight(scroller.clientHeight);
    const observer = new ResizeObserver(([entry]) => {
      setViewportHeight(entry.contentRect.height);
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  // Follow the reader. Scrolled explicitly rather than with `scrollIntoView`,
  // which cannot reach a thumbnail that virtualization has not mounted.
  useEffect(() => {
    scrollerRef.current?.scrollTo({
      top: scrollOffsetForItem(layout, currentPage - 1, viewportHeight),
      behavior: "auto",
    });
  }, [currentPage, layout, viewportHeight]);

  return (
    <div className="thumbnails" ref={scrollerRef} onScroll={handleScroll}>
      {thumbnails.map(({ scale, size }, index) => {
        const pageNumber = index + 1;
        const active = pageNumber === currentPage;
        return (
          <button
            type="button"
            key={pageNumber}
            className={`thumbnail${active ? " thumbnail--active" : ""}`}
            aria-current={active ? "page" : undefined}
            aria-label={`${pageNumber}ページ`}
            onClick={() => onJumpToPage(pageNumber)}
          >
            {rangeIncludes(range, index) ? (
              <PageCanvas
                doc={doc}
                cache={cache}
                pageNumber={pageNumber}
                scale={scale}
                width={size.width}
                height={size.height}
              />
            ) : (
              // Reserve the exact footprint so the scroll track never shifts
              // when this thumbnail comes into view.
              <span
                className="page page--placeholder"
                style={{ width: size.width, height: size.height }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
