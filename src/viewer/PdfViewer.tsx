import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { blobToBase64 } from "../files/base64";
import {
  saveClip,
  type Highlight,
  type NormalizedRect,
} from "../files/sidecar";
import { NotesPanel } from "../notes/NotesPanel";
import { useNotes } from "../notes/use-notes";
import type { OutlineNode, PageSize, PdfDocumentHandle } from "../pdf";
import {
  NO_CONTEXT,
  surroundingText,
  type SelectionContext,
} from "../translation/context";
import { TranslationPanel } from "../translation/TranslationPanel";
import { useTranslation } from "../translation/use-translation";
import { HighlightsPanel } from "./HighlightsPanel";
import { OutlineSidebar } from "./OutlineSidebar";
import { PageCanvas } from "./PageCanvas";
import {
  HighlightActionsPopup,
  SelectionActionsPopup,
  type PopupPosition,
} from "./SelectionPopup";
import { ThumbnailList } from "./ThumbnailList";
import {
  makeClip,
  marqueeBox,
  normalizeDragRect,
  type DragPoint,
} from "./clips";
import {
  pinchZoomFromTouch,
  pointerDistance,
  type TouchPoint,
} from "./touch-pinch";
import {
  highlightAtPoint,
  makeHighlight,
  normalizeSelectionRects,
} from "./highlights";
import type { RectLike } from "./normalize";
import { useAnnotations } from "./use-annotations";
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
import { RenderQueue } from "./render-queue";
import { defaultViewModeForScreen, useIsCompactScreen } from "./responsive";
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
  prefetchRange,
  rangeIncludes,
  scrollOffsetForItem,
  visibleRange,
  type ScrollDirection,
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
 * How many further spreads to warm the render cache for, beyond `OVERSCAN`,
 * in the direction the reader is scrolling (issue #12). Kept out of the
 * synchronous render path — see the prefetch effect below — so it never
 * competes with what is actually on screen for the renderer's attention.
 */
const PREFETCH_COUNT = 3;

/**
 * How long `strictRange` must sit still before an overscan-only spread is
 * trusted with full `"overscan"` render priority again (issue #35's
 * "検討" debounce). While the reader is mashing the page-turn key or
 * flicking through spreads, `strictRange` moves on every turn — rendering
 * each overscan neighbour along the way just spends the single-slot worker
 * on pages the reader is not going to linger on. Dropping those renders to
 * `"prefetch"` for this long after each move means they still happen (once
 * the queue is otherwise idle), but never at the expense of whichever
 * spread turns out to be the one the reader actually stops on.
 * `"visible"` is untouched by this — the spread on screen always renders
 * immediately, `strictRange` settled or not.
 */
export const OVERSCAN_SETTLE_MS = 150;

/** Schedules `callback` for a moment the browser is otherwise idle, falling
 * back to a macrotask where `requestIdleCallback` does not exist (jsdom,
 * Safari as of this writing). */
function scheduleIdle(callback: () => void): number {
  const ric = (
    window as unknown as { requestIdleCallback?: (cb: () => void) => number }
  ).requestIdleCallback;
  return typeof ric === "function"
    ? ric(callback)
    : window.setTimeout(callback, 1);
}

function cancelIdle(handle: number): void {
  const cic = (
    window as unknown as { cancelIdleCallback?: (handle: number) => void }
  ).cancelIdleCallback;
  if (typeof cic === "function") cic(handle);
  else window.clearTimeout(handle);
}

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
  /**
   * How documents are laid out, from the app settings (issue #9). A change
   * applies to this document too; the toolbar overrides it until then, for
   * this document only.
   */
  defaultBinding?: Binding;
  defaultViewMode?: ViewMode;
  /**
   * 1-based page to open on (issue #43), from the recent-files entry.
   * Clamping into `[1, doc.pageCount]` is this component's job, not the
   * caller's: omitted starts the document at page 1, and an out-of-range
   * value (a stale entry from a since-shortened file, say) starts it at the
   * nearest valid page instead — page 1 for anything below the range, the
   * last page for anything above it.
   */
  initialPage?: number;
  /**
   * Notified whenever the page the reader is looking at changes, including
   * once on mount with the (possibly clamped) starting page — so the caller
   * can persist it (issue #43) without having to duplicate the clamping.
   */
  onPageChange?: (page: number) => void;
  onClose: () => void;
  onOpenSettings?: () => void;
}

type Popup =
  | {
      kind: "create";
      page: number;
      rects: NormalizedRect[];
      text: string;
      /** Page text either side of the selection, for translating it (#10). */
      context: SelectionContext;
      position: PopupPosition;
    }
  | { kind: "actions"; highlight: Highlight; position: PopupPosition };

/**
 * A rectangle selection in progress. The page and the mount point are measured
 * once, when the drag starts: they cannot move under it, and re-measuring on
 * every pointer move would make the marquee lag the cursor.
 */
interface ClipDrag {
  page: number;
  pageRect: RectLike;
  /** Top-left of `.viewer__body`, which the marquee is positioned inside. */
  origin: DragPoint;
  start: DragPoint;
  current: DragPoint;
}

/** Why the note cannot take a clip's image. */
type NotesRefusal = "loading" | "conflict";

/**
 * What to tell the reader when the note cannot take the image. Which of the
 * two applies depends on whether the clip itself made it to disk: before the
 * write there is nothing to keep and the cut is simply declined, after it the
 * clip is saved and only the markdown is missing. Saying "切り取ってください"
 * once the file exists would send the reader to do it all again.
 */
const CLIP_DECLINED: Record<NotesRefusal, string> = {
  loading: "メモをまだ読み込めていないため、切り取りできません",
  conflict: "メモが競合しています。どちらを残すか選んでから切り取ってください",
};

const IMAGE_NOT_INSERTED: Record<NotesRefusal, string> = {
  loading:
    "切り取りは保存しました。ただしメモを読み込めていないため、画像を挿入できませんでした",
  conflict:
    "切り取りは保存しました。ただしメモが競合しているため、画像を挿入できませんでした",
};

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
  defaultBinding = "left",
  defaultViewMode = "single",
  initialPage,
  onPageChange,
  onClose,
  onOpenSettings,
}: PdfViewerProps) {
  // Compact screens (issue #11) never start on a two-page spread: read before
  // the view-mode state below, which needs it for its own initial value.
  const isCompact = useIsCompactScreen();

  // Where the document starts; the toolbar then overrides both for this
  // document only. Changing the setting takes them back over (see below).
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    defaultViewModeForScreen(defaultViewMode, isCompact),
  );
  const [binding, setBinding] = useState<Binding>(defaultBinding);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  // Clamped once, from the initial props: `doc` never changes for the
  // lifetime of this component (the caller remounts via `key={path}` for a
  // new one), so there is nothing to re-clamp against later.
  const [currentPage, setCurrentPage] = useState(() =>
    Math.min(
      Math.max(Math.floor(initialPage ?? 1) || 1, 1),
      Math.max(doc.pageCount, 1),
    ),
  );
  const [viewportWidth, setViewportWidth] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [highlightsOpen, setHighlightsOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [popup, setPopup] = useState<Popup | null>(null);
  /** Rectangle selection: on, the pages are dragged over instead of read. */
  const [clipMode, setClipMode] = useState(false);
  const [drag, setDrag] = useState<ClipDrag | null>(null);
  /** True while a region is being rendered and written to the sidecar. */
  const [clipping, setClipping] = useState(false);
  const [clipError, setClipError] = useState<string | null>(null);
  /** Set when a highlight could not be created; the reason is derived. */
  const [createRefused, setCreateRefused] = useState(false);
  /** Set when the notes panel refused an insertion; the reason is derived. */
  const [insertRefused, setInsertRefused] = useState(false);
  /** null until the outline has been fetched; the fetch happens on first open. */
  const [outline, setOutline] = useState<OutlineNode[] | null>(null);
  /** Where the translation panel sits: where the selection it came from was. */
  const [translationAt, setTranslationAt] = useState<PopupPosition | null>(
    null,
  );

  // Changing the setting is a deliberate act on the app, so it lands on the
  // document being read as well — waiting for the next one to open would look
  // like the setting did nothing. Only a change moves these: the toolbar's own
  // toggles stand until the reader touches the setting again.
  useEffect(() => setBinding(defaultBinding), [defaultBinding]);
  // Also re-applies when the screen crosses the compact breakpoint (a window
  // resize, an iPad rotating): a spread that no longer fits is dropped back
  // to single, and single goes back to the setting once there is room again.
  useEffect(
    () => setViewMode(defaultViewModeForScreen(defaultViewMode, isCompact)),
    [defaultViewMode, isCompact],
  );

  const annotations = useAnnotations(filePath);
  const notes = useNotes(filePath);
  const translation = useTranslation();
  // Pulled out so the callback below depends on the starter rather than on the
  // object the hook rebuilds on every state change.
  const { start: beginTranslation } = translation;
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
  /** The live drag, for the window listeners that must not re-register on move. */
  const dragRef = useRef<ClipDrag | null>(null);
  /**
   * Pointers currently down on the scroller, for two-finger pinch-to-zoom.
   * Tracked by id because a third finger touching down (a stray palm, most
   * often) must not be mistaken for one of the original two.
   */
  const pinchPointersRef = useRef<Map<number, TouchPoint>>(new Map());
  /**
   * Set once two fingers are down; null the rest of the time. The pinch is
   * pinned to the two pointers that started it: a third finger joining, or
   * one of the pair being replaced mid-gesture, must not silently swap in a
   * different pair — its distance to the survivor has nothing to do with
   * `startDistance`, and comparing them would jolt the zoom.
   */
  const pinchStateRef = useRef<{
    pointers: readonly [number, number];
    startZoom: number;
    startDistance: number;
  } | null>(null);
  /**
   * Whether the gesture in progress included a pinch. Read by
   * {@link handlePointerUp} so the fingers lifting off does not also get
   * read as a click or a text-selection release — the pinch already used
   * that gesture for something else.
   */
  const pinchOccurredRef = useRef(false);
  /** Aborts an in-flight region render when the reader leaves the document. */
  const clipAbortRef = useRef<AbortController | null>(null);
  /** The latest `createClip`, for the same reason as `dragRef`. */
  const createClipRef = useRef<
    (page: number, rect: NormalizedRect) => Promise<void>
  >(() => Promise.resolve());
  /**
   * Whether the note can take an image, as of the last commit. A cut spans
   * several awaits, and the `notes` object it started with says what was true
   * when it began — not what is true when it finishes.
   */
  const notesStateRef = useRef<{ loaded: boolean; conflict: string | null }>({
    loaded: false,
    conflict: null,
  });
  const cacheRef = useRef<PageRenderCache | null>(null);
  cacheRef.current ??= new PageRenderCache();
  const cache = cacheRef.current;
  /**
   * One render queue for the document's whole lifetime (issue #35): a fresh
   * instance per render would just let every `PageCanvas` mount straight
   * through it again, defeating the point of serializing renders across
   * them.
   */
  const renderQueueRef = useRef<RenderQueue | null>(null);
  renderQueueRef.current ??= new RenderQueue();
  const renderQueue = renderQueueRef.current;

  /** DOM index we scrolled to on purpose; scroll events ignore it until reached. */
  const pendingDomIndexRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  /** Which way the reader is scrolling, updated alongside `scrollLeft` in
   * {@link handleScroll}; read (not depended on) by the prefetch effect. */
  const scrollDirectionRef = useRef<ScrollDirection>("none");
  const lastScrollLeftRef = useRef(0);

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
  // Read inside the pinch listener, for the same reason.
  const zoomRef = useRef(zoom);
  /** A pinch starting while a clip drag is being made would fight it for the
   * same two fingers; read inside the pointerdown listener to keep it from
   * starting one. */
  const clipModeRef = useRef(clipMode);
  // Written after the commit rather than during the render: React can throw
  // a render away and redo it, and a discarded render must not leave these
  // pointing at state that never became the UI. (Same reasoning as the
  // createClipRef/dragRef effect further down.)
  useEffect(() => {
    zoomRef.current = zoom;
    clipModeRef.current = clipMode;
  });

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
  /**
   * `range` widened by `OVERSCAN`; this is the same computation with no
   * overscan at all, i.e. exactly the spread(s) actually on screen. The
   * difference between the two is what separates render priority
   * `"visible"` from `"overscan"` below (issue #35) — overscan pages still
   * render synchronously, same as before, but never ahead of a spread the
   * reader is actually looking at right now.
   */
  const strictRange = useMemo(
    () => visibleRange(layout, scrollLeft, viewportWidth, 0),
    [layout, scrollLeft, viewportWidth],
  );
  // Destructured for the prefetch effect below: `range` is a fresh object on
  // every recompute even when its bounds have not moved, and depending on it
  // directly would abort (and thus never finish) an in-flight prefetch on
  // every single scroll event's re-render.
  const { start: rangeStart, end: rangeEnd } = range;

  /**
   * Whether `strictRange` has sat still for `OVERSCAN_SETTLE_MS` (issue #35).
   * Starts `true`: the document's own opening overscan neighbour must render
   * at once, not wait out a debounce nothing has actually triggered yet.
   */
  const [overscanSettled, setOverscanSettled] = useState(true);
  /**
   * The `strictRange` bounds as of the last render, compared against the
   * current ones *during* render rather than in a `useEffect`. An effect
   * would only flip `overscanSettled` to `false` a render *after* the one
   * that first mounts the new range's overscan neighbours — those would be
   * scheduled at full `"overscan"` priority for that one render, self
   * -correcting to `"prefetch"` only on the render right behind it. That is
   * exactly the race this debounce exists to close, so the flip has to land
   * in the very same render `strictRange` first moves — this is React's own
   * endorsed pattern for adjusting state during rendering (calling `set…`
   * conditionally, guarded on the previous value having actually changed,
   * bails out and re-renders before committing anything the reader would see).
   */
  const [lastStrictRange, setLastStrictRange] = useState(strictRange);
  if (
    lastStrictRange.start !== strictRange.start ||
    lastStrictRange.end !== strictRange.end
  ) {
    // The very first render seeds `lastStrictRange` with that same render's
    // own `strictRange` (same object), so this branch cannot fire before an
    // actual move — no separate "skip the first one" case needed.
    setLastStrictRange(strictRange);
    setOverscanSettled(false);
  }
  // Re-settles `OVERSCAN_SETTLE_MS` after the *last* such move. Starting a
  // timer is a side effect in its own right, so — unlike the flip above —
  // this part does belong in an effect; running one render behind costs
  // nothing here, since nothing renders differently while merely waiting
  // for the timer to land.
  useEffect(() => {
    if (overscanSettled) return;
    const timer = window.setTimeout(
      () => setOverscanSettled(true),
      OVERSCAN_SETTLE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [overscanSettled, strictRange.start, strictRange.end]);

  /**
   * Warms the render cache for pages just outside the synchronously rendered
   * `range`, in the direction the reader is scrolling (issue #12). Runs one
   * page per idle slot, chained until the target set is warm or a new range
   * (a further scroll, a zoom, a document switch) supersedes it — never
   * touching the DOM: a prefetched page only ever reaches the screen through
   * `PageCanvas`'s own cache hit.
   *
   * Each warmed page's own render goes through `renderQueue` at `"prefetch"`
   * priority (issue #35), the lowest of the three — so even though this
   * effect still only ever has *one* prefetch render in flight at a time
   * (the idle pacing below is unchanged), that one render never competes
   * with a `"visible"` or `"overscan"` page still waiting on the same
   * single-slot worker for the renderer's attention.
   */
  useEffect(() => {
    if (total === 0) return;
    const currentRange = { start: rangeStart, end: rangeEnd };

    const target = prefetchRange(
      layout,
      currentRange,
      scrollDirectionRef.current,
      PREFETCH_COUNT,
    );
    const domIndices: number[] = [];
    for (let i = target.behind.start; i < target.behind.end; i += 1) {
      domIndices.push(i);
    }
    for (let i = target.ahead.start; i < target.ahead.end; i += 1) {
      domIndices.push(i);
    }

    const pageNumbers = new Set<number>();
    for (const domIndex of domIndices) {
      // Already in the synchronous render range: PageCanvas already covers it.
      if (rangeIncludes(currentRange, domIndex)) continue;
      for (const pageNumber of domSpreads[domIndex] ?? []) {
        pageNumbers.add(pageNumber);
      }
    }
    const pending = Array.from(pageNumbers).filter(
      (pageNumber) => !cache.has(pageNumber, zoom),
    );
    if (pending.length === 0) return;

    // Local to this effect run, not refs: nothing outside this closure ever
    // reads them, and each new run of the effect (a further scroll, a zoom,
    // a document switch) gets its own pair via the cleanup below rather than
    // sharing state across runs.
    const controller = new AbortController();
    let idleHandle: number | null = null;

    const warmNext = () => {
      idleHandle = null;
      if (controller.signal.aborted) return;
      const pageNumber = pending.shift();
      if (pageNumber === undefined) return;
      if (cache.has(pageNumber, zoom)) {
        // Warmed by something else (the visible range's own render, most
        // likely) since this was queued: move on without re-rendering it.
        idleHandle = scheduleIdle(warmNext);
        return;
      }
      const canvas = document.createElement("canvas");
      // A cache hit is spliced straight into the DOM as-is (see PageCanvas),
      // so a prefetched canvas without this class would paint inline instead
      // of `display: block` and throw off the page's baseline spacing the
      // moment the reader scrolls to it.
      canvas.className = "page__canvas";
      renderQueue
        .schedule(
          "prefetch",
          (signal) =>
            doc.renderPage(pageNumber, { scale: zoom, canvas, signal }),
          controller.signal,
        )
        .then(() => {
          if (controller.signal.aborted) return;
          // A prefetch warms an offscreen canvas nobody is necessarily
          // looking at — unlike `PageCanvas`'s own render, it must not lean
          // on `cache.set`'s "keep the one entry that alone exceeds the
          // budget" rule, which assumes that entry is the page on screen
          // right now. At extreme zoom (zoom 6 × DPR 2, an A4 page is
          // ~70,000,000px — already over the 64,000,000px default budget on
          // its own) a prefetched page could otherwise evict every page
          // actually visible and then sit there itself, uselessly, as the
          // cache's only entry. Skipping the cache here just means this
          // page renders again if the reader actually scrolls to it — no
          // worse than never having prefetched it.
          if (cache.fitsBudget(canvas.width * canvas.height)) {
            cache.set(pageNumber, zoom, canvas);
          } else {
            canvas.width = 0;
            canvas.height = 0;
          }
        })
        .catch(() => {
          // A prefetch that fails just stays cold; the reader's own render,
          // if they scroll here, is what surfaces a real error.
        })
        .finally(() => {
          if (!controller.signal.aborted && pending.length > 0) {
            idleHandle = scheduleIdle(warmNext);
          }
        });
    };
    idleHandle = scheduleIdle(warmNext);

    return () => {
      controller.abort();
      if (idleHandle !== null) cancelIdle(idleHandle);
    };
  }, [
    rangeStart,
    rangeEnd,
    layout,
    domSpreads,
    doc,
    cache,
    zoom,
    total,
    renderQueue,
  ]);

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

  // Tells the caller which page is on screen, including the very first
  // render — so persisting it (issue #43) needs no separate "what did it
  // start on" logic of its own.
  useEffect(() => {
    onPageChange?.(currentPage);
  }, [currentPage, onPageChange]);

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
      const previousLeft = lastScrollLeftRef.current;
      lastScrollLeftRef.current = left;
      scrollDirectionRef.current =
        left > previousLeft
          ? "forward"
          : left < previousLeft
            ? "backward"
            : "none";
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

  // WKWebView still fires its own `gesture*` events for a two-finger touch
  // even with the viewport's `user-scalable=no` (index.html) — that setting
  // only stops the *page* from being magnified, not the events themselves.
  // Left unhandled, the native pinch would zoom the whole WebView on top of
  // the zoom this viewer already applies to the pages. Registered on
  // `document` rather than the scroller: WebKit dispatches these outside the
  // normal bubble path, so an element-level listener would miss some of them.
  useEffect(() => {
    const preventNativeGesture = (event: Event) => event.preventDefault();
    document.addEventListener("gesturestart", preventNativeGesture, {
      passive: false,
    });
    document.addEventListener("gesturechange", preventNativeGesture, {
      passive: false,
    });
    document.addEventListener("gestureend", preventNativeGesture, {
      passive: false,
    });
    return () => {
      document.removeEventListener("gesturestart", preventNativeGesture);
      document.removeEventListener("gesturechange", preventNativeGesture);
      document.removeEventListener("gestureend", preventNativeGesture);
    };
  }, []);

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
    // The scroller's `touch-action: pan-x` hands two-finger movement to the
    // browser as a pan, and once the browser claims the gesture it kills the
    // pointer stream with `pointercancel` — the pinch would die on its first
    // move. `touch-action` is only sampled when a gesture starts, so it
    // cannot be loosened mid-pinch; cancelling the two-finger `touchmove`
    // itself is what keeps the gesture ours. One finger stays untouched:
    // that is the swipe that turns pages.
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length >= 2) event.preventDefault();
    };

    /** The pinch's own two pointers, current positions. */
    const pinchPoints = (state: {
      pointers: readonly [number, number];
    }): [TouchPoint, TouchPoint] | null => {
      const first = pinchPointersRef.current.get(state.pointers[0]);
      const second = pinchPointersRef.current.get(state.pointers[1]);
      return first && second ? [first, second] : null;
    };

    // Any direct grab of the scroller also abandons an in-flight smooth scroll
    // and dismisses a floating popup, whose anchor is about to go stale.
    const onPointerDown = (event: PointerEvent) => {
      pointerDownRef.current = { x: event.clientX, y: event.clientY };
      cancelPendingScroll();
      setPopup(null);

      // A clip drag already owns a single finger; letting a second one start
      // a pinch on top of it would fight the drag for the same gesture.
      if (clipModeRef.current) return;
      pinchPointersRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
      // Exactly two, and none earlier in this gesture: a pinch begins only
      // when the second finger joins the first. Once a pinch has run and
      // ended (one of its fingers lifted), whatever fingers remain down —
      // a stray palm among them, often enough — must not seed a new one;
      // lifting everything is what arms the next pinch.
      const ids = Array.from(pinchPointersRef.current.keys());
      if (
        ids.length === 2 &&
        !pinchOccurredRef.current &&
        pinchStateRef.current === null
      ) {
        const pointers = [ids[0], ids[1]] as const;
        const state = { pointers };
        const points = pinchPoints(state);
        if (!points) return;
        pinchStateRef.current = {
          pointers,
          startZoom: zoomRef.current,
          startDistance: pointerDistance(points[0], points[1]),
        };
        pinchOccurredRef.current = true;
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!pinchPointersRef.current.has(event.pointerId)) return;
      pinchPointersRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
      const state = pinchStateRef.current;
      if (!state) return;
      const points = pinchPoints(state);
      if (!points) return;
      const distance = pointerDistance(points[0], points[1]);
      setZoom(
        pinchZoomFromTouch(state.startZoom, state.startDistance, distance),
      );
    };

    /**
     * A gesture that ends anywhere else — released over the sidebar, or off
     * the window entirely — never reaches the scroller's own pointerup. Left
     * behind, its start would be measured against the next release and turn a
     * genuine click into a "drag". These fire after React's handler has run.
     */
    const forgetPointerDown = (event: PointerEvent) => {
      pointerDownRef.current = null;
      pinchPointersRef.current.delete(event.pointerId);
      // Either of the pinch's own fingers lifting ends the pinch. Fingers
      // that were never part of it (a stray palm) come and go freely — but
      // the gesture is not over until every finger is up: `pinchOccurredRef`
      // stays set until then, keeping the release from reading as a click
      // and (see `onPointerDown`) blocking a new pinch from starting.
      if (pinchStateRef.current?.pointers.includes(event.pointerId)) {
        pinchStateRef.current = null;
      }
      if (pinchPointersRef.current.size === 0) {
        pinchOccurredRef.current = false;
      }
    };

    scroller.addEventListener("wheel", onWheel, { passive: false });
    scroller.addEventListener("touchmove", onTouchMove, { passive: false });
    scroller.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", forgetPointerDown);
    window.addEventListener("pointercancel", forgetPointerDown);
    return () => {
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("touchmove", onTouchMove);
      scroller.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
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
      // A pinch already used this gesture; the fingers lifting off is not a
      // click or a text-selection release on top of it. Left to the checks
      // below, whichever finger happened to land near where it started would
      // otherwise pop up a highlight's actions or offer to highlight a
      // selection the pinch never intended to make.
      if (pinchOccurredRef.current) return;
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
        // Only the text layer holds the document's own text; the page also
        // carries the page-number label, which must never be extracted.
        const textLayer = selectedPage.querySelector(".textLayer");
        const onPage = range.cloneRange();
        if (textLayer && !textLayer.contains(range.endContainer)) {
          onPage.setEnd(textLayer, textLayer.childNodes.length);
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
            // Read here, while the selection is still on screen: by the time
            // the reader picks "翻訳" the range may be gone.
            context: textLayer
              ? surroundingText(onPage, textLayer)
              : NO_CONTEXT,
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
        setCreateRefused(true);
        setHighlightsOpen(true);
        setPopup(null);
        return;
      }
      setCreateRefused(false);
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

  /**
   * Everything the app adds to notes.md goes through the open editor rather
   * than straight to the file: a direct write would be overwritten by the
   * panel's next autosave, and the reader would watch it disappear.
   */
  const appendToNotes = useCallback(
    (append: () => void) => {
      setNotesOpen(true);
      if (!notes.loaded || notes.conflict !== null) {
        setInsertRefused(true);
        return;
      }
      setInsertRefused(false);
      append();
    },
    [notes],
  );

  const insertToNotes = useCallback(
    (highlight: Highlight) => appendToNotes(() => notes.insertQuote(highlight)),
    [appendToNotes, notes],
  );

  /**
   * Translates a piece of the document (issue #10). The panel opens where the
   * popup was, and the request runs while the reader keeps reading.
   */
  const startTranslation = useCallback(
    (
      text: string,
      page: number,
      context: SelectionContext,
      position: PopupPosition,
    ) => {
      setTranslationAt(position);
      beginTranslation({
        input: {
          text,
          contextBefore: context.before,
          contextAfter: context.after,
        },
        page,
      });
      setPopup(null);
      window.getSelection()?.removeAllRanges();
    },
    [beginTranslation],
  );

  /**
   * Keeps the original above the translation in the note: a translation on its
   * own cannot be checked against the paper later.
   */
  const insertTranslationToNotes = useCallback(() => {
    const current = translation.state;
    if (current.status !== "done") return;
    appendToNotes(() =>
      notes.insertTranslation({
        original: current.source.input.text,
        translated: current.result.text,
        page: current.source.page,
        targetLanguage: current.result.targetLanguage,
      }),
    );
  }, [appendToNotes, notes, translation.state]);

  /** Why the note cannot take an image right now, or null when it can. */
  const notesRefusal = useCallback((): NotesRefusal | null => {
    const { loaded, conflict } = notesStateRef.current;
    if (!loaded) return "loading";
    if (conflict !== null) return "conflict";
    return null;
  }, []);

  /**
   * Cuts the selected region out of the page: renders it well above screen
   * resolution, writes it into the sidecar's `clips/` folder, records it in
   * annotations.json, and drops the markdown image into the note.
   *
   * The clip file is written before the annotation, so a failure anywhere
   * leaves at worst an orphaned PNG — never an annotations entry (or a note)
   * pointing at a picture that is not there.
   */
  const createClip = useCallback(
    async (page: number, rect: NormalizedRect) => {
      // The annotations hook drops mutations until the sidecar has loaded;
      // without this the clip would be cut and then quietly forgotten.
      if (!annotations.loaded) {
        setClipError(
          "注釈をまだ読み込めていないため、切り取りを保存できません",
        );
        return;
      }
      // A clip this build cannot put in the note is a clip the reader has no
      // way back to: there is no clips panel, and nothing draws them on the
      // page. Rather than cut a PNG nobody can reach, the whole thing waits
      // until the note can take it — both states resolve on their own.
      const refusedUpFront = notesRefusal();
      if (refusedUpFront) {
        setClipError(CLIP_DECLINED[refusedUpFront]);
        setNotesOpen(true);
        return;
      }
      const controller = new AbortController();
      clipAbortRef.current?.abort();
      clipAbortRef.current = controller;
      setClipping(true);
      setClipError(null);
      try {
        const png = await doc.renderRegion(page, {
          rect,
          signal: controller.signal,
        });
        // Checked before the write, not only after it: a drag the reader has
        // already replaced must not leave a PNG behind that nothing refers to.
        if (controller.signal.aborted) return;
        // Encoding is another await the reader can walk away during, so the
        // check is repeated on both sides of the write.
        const encoded = await blobToBase64(png);
        if (controller.signal.aborted) return;
        // The note can go out from under a cut that is already running — an
        // iCloud sync landing mid-render is enough. Re-checked here so a
        // clip that has become uninsertable costs no file at all.
        const refusedBeforeWrite = notesRefusal();
        if (refusedBeforeWrite) {
          setClipError(CLIP_DECLINED[refusedBeforeWrite]);
          setNotesOpen(true);
          return;
        }
        const file = await saveClip(filePath, encoded);
        if (controller.signal.aborted) return;
        // Past this point the PNG exists. If the note turned unusable during
        // the write, the clip is still recorded: a file annotations.json does
        // not know about is lost to every device, while an entry without the
        // markdown is one the reader can still be pointed at.
        const clip = makeClip({ page, rect, file, createdAt: new Date() });
        annotations.addClip(clip);
        const refusedAfterWrite = notesRefusal();
        if (refusedAfterWrite) {
          setClipError(IMAGE_NOT_INSERTED[refusedAfterWrite]);
          setNotesOpen(true);
          return;
        }
        appendToNotes(() => notes.insertImage(clip));
      } catch (cause) {
        if (controller.signal.aborted) return;
        setClipError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (clipAbortRef.current === controller) {
          clipAbortRef.current = null;
          setClipping(false);
        }
      }
    },
    [annotations, appendToNotes, doc, filePath, notes, notesRefusal],
  );

  // Written after the commit, not during the render. A render React throws
  // away (an interrupted concurrent one) would otherwise leave these pointing
  // at closures over state that never became the UI — and the pointer
  // listeners below read them long after the render that produced them.
  useEffect(() => {
    createClipRef.current = createClip;
    dragRef.current = drag;
    notesStateRef.current = { loaded: notes.loaded, conflict: notes.conflict };
  });

  const beginClipDrag = useCallback(
    (event: ReactPointerEvent) => {
      // `saveClip` takes no abort signal, so a cut that has reached the write
      // finishes whatever happens next. Starting another one on top of it
      // would leave the first PNG on disk with nothing referring to it — the
      // notice says a cut is still running, and this drag waits for it.
      if (clipping || dragRef.current !== null) return;
      const pageElement = closestPage(
        event.target instanceof Node ? event.target : null,
      );
      const bodyRect = bodyRef.current?.getBoundingClientRect();
      if (!pageElement || !bodyRect) return;
      const pageRect = pageElement.getBoundingClientRect();
      if (pageRect.width <= 0 || pageRect.height <= 0) return;
      // Without this the drag would also select the text layer underneath, and
      // release would leave the highlight popup behind.
      event.preventDefault();

      const point = { x: event.clientX, y: event.clientY };
      setClipError(null);
      setDrag({
        page: Number(pageElement.dataset.page),
        pageRect,
        origin: { x: bodyRect.left, y: bodyRect.top },
        start: point,
        current: point,
      });
    },
    [clipping],
  );

  // Tracked on the window rather than the scroller: a drag that leaves the
  // pages — over a panel, or off the window — still has to finish where the
  // reader let go, not wherever it last crossed a page.
  useEffect(() => {
    if (drag === null) return;
    const onMove = (event: PointerEvent) => {
      setDrag((current) =>
        current === null
          ? null
          : { ...current, current: { x: event.clientX, y: event.clientY } },
      );
    };
    const onUp = (event: PointerEvent) => {
      const finished = dragRef.current;
      setDrag(null);
      if (!finished) return;
      const rect = normalizeDragRect(
        finished.start,
        { x: event.clientX, y: event.clientY },
        finished.pageRect,
      );
      // Too small to be a region: treated as a stray click, silently.
      if (rect) void createClipRef.current(finished.page, rect);
    };
    const onCancel = () => setDrag(null);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    // Only whether a drag is running matters here. Both the drag itself and
    // the cut it ends in are read from refs: `createClip` closes over the
    // notes and annotations hooks, whose results are new objects on every
    // render, so depending on it would re-register these listeners on every
    // pointer move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag === null]);

  // Escape backs out one step: the drag in progress, then the mode itself.
  useEffect(() => {
    if (!clipMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (dragRef.current) setDrag(null);
      else setClipMode(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clipMode]);

  // A render still running when the reader closes the document has nowhere to
  // put its result.
  useEffect(() => () => clipAbortRef.current?.abort(), []);

  // Both complaints below are derived rather than stored, so each goes away by
  // itself once the state that produced it resolves — a sidecar that finishes
  // loading, a conflict the reader settles.
  const actionError =
    createRefused && !annotations.loaded
      ? "注釈をまだ読み込めていないため、ハイライトを保存できません"
      : null;
  const noteError = !insertRefused
    ? null
    : !notes.loaded
      ? "メモをまだ読み込めていないため、引用を挿入できません"
      : notes.conflict !== null
        ? "メモが競合しています。どちらを残すか選んでから挿入してください"
        : null;

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
        <button
          type="button"
          className="toolbar__button"
          aria-pressed={notesOpen}
          onClick={() => setNotesOpen((open) => !open)}
        >
          メモ
        </button>
        <button
          type="button"
          className="toolbar__button"
          aria-pressed={clipMode}
          onClick={() => {
            setDrag(null);
            setClipError(null);
            setClipMode((on) => !on);
          }}
        >
          切り取り
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

        {onOpenSettings ? (
          <button
            type="button"
            className="toolbar__button"
            onClick={onOpenSettings}
          >
            設定
          </button>
        ) : null}
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
          className={clipMode ? "scroller scroller--clipping" : "scroller"}
          ref={scrollerRef}
          onScroll={handleScroll}
          onPointerDown={clipMode ? beginClipDrag : undefined}
          onPointerUp={clipMode ? undefined : handlePointerUp}
          tabIndex={0}
          role="region"
          aria-label="PDFページ"
        >
          {domSpreads.map((spread, domIndex) => {
            const box = layout[domIndex];
            const visible = rangeIncludes(range, domIndex);
            // Inside the strict (no-overscan) range: this spread is what the
            // reader is actually looking at right now, so it outranks the
            // overscan spreads either side of it for the renderer's
            // attention (issue #35). An overscan spread itself only gets
            // full "overscan" priority once `strictRange` has sat still for
            // a while — mid-burst, it is dropped to "prefetch" so a run of
            // page turns cannot each leave a wake of renders competing with
            // whichever spread the reader actually stops on.
            const priority = rangeIncludes(strictRange, domIndex)
              ? "visible"
              : overscanSettled
                ? "overscan"
                : "prefetch";
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
                        queue={renderQueue}
                        priority={priority}
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

        {notesOpen ? (
          <aside
            className="sidebar sidebar--right sidebar--notes"
            aria-label="メモ"
            // Arrow keys belong to the editor's caret here, not to page turns.
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.stopPropagation();
              }
            }}
          >
            <NotesPanel
              pdfPath={filePath}
              clips={annotations.annotations.clips}
              content={notes.content}
              loaded={notes.loaded}
              status={notes.status}
              error={notes.error ?? noteError}
              conflict={notes.conflict}
              onChange={notes.setContent}
              onKeepLocal={notes.keepLocal}
              onTakeDisk={notes.takeDisk}
            />
          </aside>
        ) : null}

        {drag ? (
          <div
            className="clip-marquee"
            aria-hidden="true"
            style={marqueeBox(
              drag.start,
              drag.current,
              drag.pageRect,
              drag.origin,
            )}
          />
        ) : null}

        {/* `clipping` is listed on its own: leaving the mode does not abort a
            cut already under way, and the reader should still see it finish. */}
        {clipMode || clipping || clipError ? (
          <p
            className={
              clipError ? "clip-notice clip-notice--error" : "clip-notice"
            }
            role={clipError ? "alert" : "status"}
          >
            {clipError ??
              (clipping
                ? "切り取っています…"
                : "切り取る範囲をドラッグしてください（Esc で終了）")}
          </p>
        ) : null}

        {popup?.kind === "create" ? (
          <SelectionActionsPopup
            position={popup.position}
            onPick={createHighlight}
            onTranslate={() =>
              startTranslation(
                popup.text,
                popup.page,
                popup.context,
                popup.position,
              )
            }
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
            // A saved highlight has no page around it any more, so it is
            // translated on its own — the extract is what was worth keeping.
            onTranslate={() =>
              startTranslation(
                popup.highlight.text,
                popup.highlight.page,
                NO_CONTEXT,
                popup.position,
              )
            }
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

        {/* Left up until it is closed, unlike the popups: it is a result to
            read and act on, not a toolbar that follows the pointer. */}
        {translation.state.status !== "idle" && translationAt ? (
          <TranslationPanel
            position={translationAt}
            state={translation.state}
            onCopy={() => {
              if (translation.state.status === "done") {
                copyToClipboard(translation.state.result.text);
              }
            }}
            onInsertToNotes={insertTranslationToNotes}
            onRetry={translation.retry}
            onDismiss={translation.dismiss}
          />
        ) : null}
      </div>
    </div>
  );
}
