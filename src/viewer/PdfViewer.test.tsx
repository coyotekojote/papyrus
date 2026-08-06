import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyAnnotations,
  loadAnnotations,
  loadNotes,
  saveAnnotations,
  saveClip,
  saveNotes,
  type Annotations,
  type Highlight,
} from "../files/sidecar";
import { SAVE_DEBOUNCE_MS } from "../notes/use-notes";
import type { OutlineNode, PageSize, PdfDocumentHandle } from "../pdf";
import { translate } from "../translation/translate";
import { OVERSCAN_SETTLE_MS, PdfViewer } from "./PdfViewer";
import { RenderQueue } from "./render-queue";
import type { Binding, ViewMode } from "./spreads";
import { pinchZoom } from "./zoom";

vi.mock("../files/sidecar", async (importActual) => {
  const actual = await importActual<typeof import("../files/sidecar")>();
  return {
    ...actual,
    loadAnnotations: vi.fn(),
    saveAnnotations: vi.fn(),
    loadNotes: vi.fn(),
    saveNotes: vi.fn(),
    saveClip: vi.fn(),
    loadClip: vi.fn(),
  };
});

vi.mock("../translation/translate", async (importActual) => {
  const actual =
    await importActual<typeof import("../translation/translate")>();
  return { ...actual, translate: vi.fn() };
});

const PAGE_COUNT = 8;

function fakeDoc(
  pageCount = PAGE_COUNT,
  outline: OutlineNode[] = [],
): PdfDocumentHandle {
  return {
    pageCount,
    getPageSize: vi.fn(async () => ({ width: 100, height: 140 })),
    renderPage: vi.fn(async () => {}),
    renderRegion: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])])),
    renderTextLayer: vi.fn(async () => {}),
    getOutline: vi.fn(async () => outline),
    destroy: vi.fn(async () => {}),
  };
}

function fakeHighlight(overrides: Partial<Highlight> = {}): Highlight {
  return {
    id: "h1",
    page: 3,
    rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.02 }],
    color: "yellow",
    text: "抜き出した本文",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function mockSidecar(annotations: Annotations = emptyAnnotations()) {
  vi.mocked(loadAnnotations).mockResolvedValue({
    annotations,
    modifiedAtMs: 1,
  });
  vi.mocked(saveAnnotations).mockResolvedValue(2);
  vi.mocked(loadNotes).mockResolvedValue({ content: "", modifiedAtMs: null });
  vi.mocked(saveNotes).mockResolvedValue(3);
  vi.mocked(saveClip).mockResolvedValue("clips/clip-0001.png");
}

beforeEach(() => {
  vi.mocked(loadAnnotations).mockReset();
  vi.mocked(saveAnnotations).mockReset();
  vi.mocked(loadNotes).mockReset();
  vi.mocked(saveNotes).mockReset();
  vi.mocked(saveClip).mockReset();
  vi.mocked(translate).mockReset();
  mockSidecar();
});

afterEach(() => {
  // Some tests stub the Range geometry jsdom does not implement; it must not
  // leak into the next one.
  delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
  window.getSelection()?.removeAllRanges();
});

function pageSizes(pageCount = PAGE_COUNT): PageSize[] {
  return Array.from({ length: pageCount }, () => ({ width: 100, height: 140 }));
}

/** Page numbers whose canvas is actually mounted (placeholders have no label). */
function renderedPages(): number[] {
  return screen
    .getAllByText(/^\d+$/)
    .map((element) => Number(element.textContent))
    .sort((a, b) => a - b);
}

/** Page numbers of the first rendered two-page spread, in on-screen order. */
function firstRenderedPair(): number[] {
  for (const spread of document.querySelectorAll(".spread")) {
    const labels = [...spread.querySelectorAll(".page__label")].map((element) =>
      Number(element.textContent),
    );
    if (labels.length === 2) return labels;
  }
  throw new Error("no two-page spread is currently rendered");
}

function scroller(): HTMLElement {
  const element = document.querySelector(".scroller");
  if (!element) throw new Error("the scroll container is not rendered");
  return element as HTMLElement;
}

/** Pixel width of a laid-out `.spread`. Every spread is the same width for a
 * fixture whose pages are all the same size (as `fakeDoc`'s are), so this is
 * enough to compute the `scrollLeft` a given single-page spread sits at. */
function spreadWidthPx(): number {
  const element = document.querySelector<HTMLElement>(".spread");
  if (!element) throw new Error("no spread is currently rendered");
  const width = Number.parseFloat(element.style.width);
  if (!Number.isFinite(width) || width <= 0) {
    throw new Error(
      `could not read a usable spread width (got "${element.style.width}")`,
    );
  }
  return width;
}

/**
 * A press and release at the given viewport coordinates. Built as MouseEvents
 * because jsdom has no PointerEvent, and fireEvent.pointerUp would then drop
 * the coordinates the hit-test reads.
 */
function pointerGesture(
  target: HTMLElement,
  down: { x: number; y: number },
  up: { x: number; y: number },
) {
  fireEvent(
    target,
    new MouseEvent("pointerdown", {
      bubbles: true,
      clientX: down.x,
      clientY: down.y,
    }),
  );
  fireEvent(
    target,
    new MouseEvent("pointerup", {
      bubbles: true,
      clientX: up.x,
      clientY: up.y,
    }),
  );
}

/**
 * A MouseEvent carrying a `pointerId`, so two concurrent "fingers" can be
 * told apart for a pinch gesture. jsdom has no PointerEvent (see
 * `pointerGesture` above); the id is bolted on afterwards since
 * `MouseEventInit` has no such field.
 */
function touch(
  type: string,
  pointerId: number,
  point: { x: number; y: number },
): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    clientX: point.x,
    clientY: point.y,
  });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

/**
 * A `ResizeObserver` stand-in tests can fire by hand. jsdom's layout is
 * always zero-sized (`src/test/setup.ts`'s stub reports nothing observable),
 * so this is the only way to simulate the scroller actually changing width —
 * the window resizing, or the notes panel opening and narrowing it (issue
 * #68). Swapped in only for the tests that need it (`vi.stubGlobal`), since
 * every other test relies on the inert default from the setup file.
 */
class ControllableResizeObserver {
  static instances: ControllableResizeObserver[] = [];
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ControllableResizeObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  fire(width: number) {
    this.callback(
      [{ contentRect: { width } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

/** Reports a new scroller width through the most recently registered observer. */
function resizeViewport(width: number) {
  const observer = ControllableResizeObserver.instances.at(-1);
  if (!observer) throw new Error("no ResizeObserver was registered");
  act(() => observer.fire(width));
}

/** Lets the rAF-throttled scroll handler run. */
async function flushScroll() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

interface ViewerDefaults {
  binding?: Binding;
  viewMode?: ViewMode;
  /** Issue #46; left at the component defaults (both on) unless overridden. */
  notesOutlineInsert?: boolean;
  notesOutlineFollow?: boolean;
}

function renderViewer(
  pageCount = PAGE_COUNT,
  outline: OutlineNode[] = [],
  /** App settings this document opens with (issue #9). */
  defaults: ViewerDefaults = {},
  /** Where to start, and how to observe page changes (issue #43). */
  paging: { initialPage?: number; onPageChange?: (page: number) => void } = {},
) {
  const doc = fakeDoc(pageCount, outline);
  const onClose = vi.fn();
  const onOpenSettings = vi.fn();
  const view = (next: ViewerDefaults) => (
    <PdfViewer
      doc={doc}
      pageSizes={pageSizes(pageCount)}
      filePath="/papers/paper.pdf"
      fileName="paper.pdf"
      defaultBinding={next.binding}
      defaultViewMode={next.viewMode}
      notesOutlineInsert={next.notesOutlineInsert}
      notesOutlineFollow={next.notesOutlineFollow}
      initialPage={paging.initialPage}
      onPageChange={paging.onPageChange}
      onClose={onClose}
      onOpenSettings={onOpenSettings}
    />
  );
  const { rerender, unmount } = render(view(defaults));
  return {
    doc,
    onClose,
    onOpenSettings,
    unmount,
    user: userEvent.setup(),
    /** Stands in for the reader changing the settings mid-document. */
    changeSettings: (next: ViewerDefaults) => rerender(view(next)),
  };
}

describe("PdfViewer", () => {
  it("shows the file name and starts on page 1", () => {
    renderViewer();

    expect(screen.getByTitle("paper.pdf")).toBeInTheDocument();
    expect(screen.getByText(`1 / ${PAGE_COUNT}`)).toBeInTheDocument();
  });

  it("renders only a few pages of a long document, not all of them", () => {
    renderViewer(200);

    expect(renderedPages().length).toBeLessThanOrEqual(4);
  });

  describe("starting page (issue #43)", () => {
    it("reports page 1 when initialPage is omitted", () => {
      const onPageChange = vi.fn();
      renderViewer(20, [], {}, { onPageChange });

      expect(screen.getByText(`1 / 20`)).toBeInTheDocument();
      expect(onPageChange).toHaveBeenCalledWith(1);
      expect(onPageChange).toHaveBeenCalledTimes(1);
    });

    it("starts on initialPage and reports it once on mount", () => {
      const onPageChange = vi.fn();
      renderViewer(20, [], {}, { initialPage: 5, onPageChange });

      expect(screen.getByText(`5 / 20`)).toBeInTheDocument();
      expect(onPageChange).toHaveBeenCalledWith(5);
      expect(onPageChange).toHaveBeenCalledTimes(1);
    });

    it("clamps an initialPage beyond the document's page count to the last page", () => {
      const onPageChange = vi.fn();
      renderViewer(20, [], {}, { initialPage: 999, onPageChange });

      expect(screen.getByText(`20 / 20`)).toBeInTheDocument();
      expect(onPageChange).toHaveBeenCalledWith(20);
      expect(onPageChange).toHaveBeenCalledTimes(1);
    });
  });

  it("renders the pages it shows via the injected renderer", async () => {
    const { doc } = renderViewer();

    // The render now goes through `RenderQueue` (issue #35), which starts
    // the first task a microtask after it is scheduled rather than
    // synchronously within the mounting effect.
    await waitFor(() => expect(doc.renderPage).toHaveBeenCalled());
    expect(vi.mocked(doc.renderPage).mock.calls[0][0]).toBe(1);
  });

  it("advances with the right arrow in a left-bound book", async () => {
    const onPageChange = vi.fn();
    const { user } = renderViewer(PAGE_COUNT, [], {}, { onPageChange });

    await user.keyboard("{ArrowRight}");
    expect(screen.getByText(`2 / ${PAGE_COUNT}`)).toBeInTheDocument();
    // First call is the mount-time report of page 1 (issue #43); this checks
    // the arrow key's own move landed on top of it.
    expect(onPageChange).toHaveBeenLastCalledWith(2);

    await user.keyboard("{ArrowLeft}");
    expect(screen.getByText(`1 / ${PAGE_COUNT}`)).toBeInTheDocument();
    expect(onPageChange).toHaveBeenLastCalledWith(1);
  });

  it("does not move past the first or last page", async () => {
    const { user } = renderViewer(3);

    await user.keyboard("{ArrowLeft}");
    expect(screen.getByText("1 / 3")).toBeInTheDocument();

    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}");
    expect(screen.getByText("3 / 3")).toBeInTheDocument();
  });

  it("reverses the arrow keys once the book is right-bound", async () => {
    const { user } = renderViewer();

    await user.click(screen.getByRole("button", { name: "左綴じ" }));
    await user.keyboard("{ArrowLeft}");

    expect(screen.getByText(`2 / ${PAGE_COUNT}`)).toBeInTheDocument();
  });

  it("keeps page 1 alone as the cover when switching to spread mode", async () => {
    const { user } = renderViewer();

    await user.click(screen.getByRole("button", { name: "単ページ" }));

    expect(screen.getByText(`1 / ${PAGE_COUNT}`)).toBeInTheDocument();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText(`2–3 / ${PAGE_COUNT}`)).toBeInTheDocument();
  });

  it("orders a spread's pages by the binding direction", async () => {
    const { user } = renderViewer();
    await user.click(screen.getByRole("button", { name: "単ページ" }));

    const [leftFirst, leftSecond] = firstRenderedPair();
    expect(leftFirst).toBeLessThan(leftSecond);

    await user.click(screen.getByRole("button", { name: "左綴じ" }));

    const [rightFirst, rightSecond] = firstRenderedPair();
    expect(rightFirst).toBeGreaterThan(rightSecond);
  });

  it("opens with the binding and view mode from the settings", () => {
    renderViewer(PAGE_COUNT, [], { binding: "right", viewMode: "spread" });

    expect(screen.getByRole("button", { name: "右綴じ" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "見開き" })).toBeInTheDocument();
    const [first, second] = firstRenderedPair();
    expect(first).toBeGreaterThan(second);
  });

  it("follows a settings change on the document already open", () => {
    const { changeSettings } = renderViewer();

    changeSettings({ binding: "right", viewMode: "spread" });

    expect(screen.getByRole("button", { name: "右綴じ" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "見開き" })).toBeInTheDocument();
  });

  it("keeps a toolbar override until the setting itself changes", async () => {
    const { changeSettings, user } = renderViewer(PAGE_COUNT, [], {
      binding: "left",
    });

    await user.click(screen.getByRole("button", { name: "左綴じ" }));
    expect(screen.getByRole("button", { name: "右綴じ" })).toBeInTheDocument();

    // Re-rendering for an unrelated reason must not undo the reader's choice.
    changeSettings({ binding: "left" });
    expect(screen.getByRole("button", { name: "右綴じ" })).toBeInTheDocument();
  });

  it("opens the settings from the toolbar", async () => {
    const { onOpenSettings, user } = renderViewer();

    await user.click(screen.getByRole("button", { name: "設定" }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("zooms with the toolbar and resets to 100%", async () => {
    const { user } = renderViewer();

    await user.click(screen.getByRole("button", { name: "拡大" }));
    expect(screen.getByRole("button", { name: "125%" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "125%" }));
    expect(screen.getByRole("button", { name: "100%" })).toBeInTheDocument();
  });

  it("zooms with the Cmd/Ctrl keyboard shortcuts", async () => {
    const { user } = renderViewer();

    await user.keyboard("{Control>}={/Control}");
    expect(screen.getByRole("button", { name: "125%" })).toBeInTheDocument();

    await user.keyboard("{Control>}-{/Control}");
    expect(screen.getByRole("button", { name: "100%" })).toBeInTheDocument();

    await user.keyboard("{Control>}={/Control}{Control>}={/Control}");
    await user.keyboard("{Control>}0{/Control}");
    expect(screen.getByRole("button", { name: "100%" })).toBeInTheDocument();
  });

  it("pinches the zoom in and out with two fingers", async () => {
    const { user } = renderViewer();
    await user.click(screen.getByRole("button", { name: "拡大" }));
    expect(screen.getByRole("button", { name: "125%" })).toBeInTheDocument();

    const track = scroller();
    // Two fingers 100px apart, spreading to 200px apart: the gesture doubles
    // whatever zoom it started at.
    fireEvent(track, touch("pointerdown", 1, { x: 100, y: 100 }));
    fireEvent(track, touch("pointerdown", 2, { x: 200, y: 100 }));
    fireEvent(window, touch("pointermove", 2, { x: 300, y: 100 }));
    expect(screen.getByRole("button", { name: "250%" })).toBeInTheDocument();

    // Pinching back in reaches the same zoom the gesture started from.
    fireEvent(window, touch("pointermove", 2, { x: 200, y: 100 }));
    expect(screen.getByRole("button", { name: "125%" })).toBeInTheDocument();

    fireEvent(window, touch("pointerup", 1, { x: 100, y: 100 }));
    fireEvent(window, touch("pointerup", 2, { x: 200, y: 100 }));
  });

  it("re-renders a page after a zoom change instead of reusing the cache", async () => {
    const { doc, user } = renderViewer();
    const before = vi.mocked(doc.renderPage).mock.calls.length;

    await user.click(screen.getByRole("button", { name: "拡大" }));

    expect(vi.mocked(doc.renderPage).mock.calls.length).toBeGreaterThan(before);
    const lastCall = vi.mocked(doc.renderPage).mock.calls.at(-1);
    expect(lastCall?.[1].scale).toBe(1.25);
  });

  describe("fit zoom (issue #68)", () => {
    beforeEach(() => {
      ControllableResizeObserver.instances = [];
      vi.stubGlobal("ResizeObserver", ControllableResizeObserver);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("shrinks to fit a viewport narrower than the spread", () => {
      renderViewer();

      // Single-page spread, natural width 100 (fakeDoc's page size); with
      // SPREAD_PADDING (24) on each side, a 100px viewport only has room for
      // (100 - 48) / 100 = 52% of it.
      resizeViewport(100);
      expect(screen.getByRole("button", { name: "52%" })).toBeInTheDocument();
    });

    it("caps at 100% once the viewport has room to spare", () => {
      renderViewer();

      resizeViewport(200);
      expect(screen.getByRole("button", { name: "100%" })).toBeInTheDocument();
    });

    it("re-fits automatically as the viewport changes, e.g. opening notes", () => {
      renderViewer();

      resizeViewport(200);
      expect(screen.getByRole("button", { name: "100%" })).toBeInTheDocument();

      resizeViewport(100);
      expect(screen.getByRole("button", { name: "52%" })).toBeInTheDocument();
    });

    it("switching to manual zoom stops tracking the viewport", async () => {
      const { user } = renderViewer();
      resizeViewport(100);
      expect(screen.getByRole("button", { name: "52%" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "拡大" }));
      // steppedZoom moves from the effective 52% to the next stop above it.
      expect(screen.getByRole("button", { name: "75%" })).toBeInTheDocument();

      resizeViewport(1000);
      expect(screen.getByRole("button", { name: "75%" })).toBeInTheDocument();
    });

    it("Cmd+0 hands control back to fit, not a fixed 100%", async () => {
      const { user } = renderViewer();
      resizeViewport(100);

      await user.click(screen.getByRole("button", { name: "拡大" }));
      expect(screen.getByRole("button", { name: "75%" })).toBeInTheDocument();

      // Meta (not Control): the Ctrl variant is already covered by the
      // pre-existing shortcut test above; this exercises the metaKey path.
      await user.keyboard("{Meta>}0{/Meta}");
      // Back to fit: resolves to the same 52% the viewport calls for, not 100%.
      expect(screen.getByRole("button", { name: "52%" })).toBeInTheDocument();
    });

    it("accounts for a two-page spread's fixed gap, not just its pages (issue #68 review)", () => {
      renderViewer(PAGE_COUNT, [], { viewMode: "spread" });

      // A 148px viewport leaves 100px available after SPREAD_PADDING (24 on
      // each side). Every two-page spread here is 100 + 100 wide with the
      // default 8px PAGE_GAP between its pages, so its own allowance is
      // (100 - 8) / 200 = 46%. The old approach — fitting against the
      // widest spread's *natural* width (100 + 100 + 8 = 208) instead of
      // solving each spread's own (available - gap) / pages — would have
      // landed on availableWidth / 208 ≈ 48% instead, letting the pages
      // overflow past the gap it never subtracted.
      resizeViewport(148);
      expect(screen.getByRole("button", { name: "46%" })).toBeInTheDocument();
    });

    describe("currentPage survives a panel's resize commit (issue #68 review)", () => {
      // Every spread here is a single page (default view mode), and each
      // spread box is exactly as wide as the viewport whenever the viewport
      // is wide enough to show a page at 100% (`spreadBoxWidth`) — true for
      // every width used below — so domIndex `i`'s slot always sits at
      // `i * boxWidth` and is `boxWidth` wide. That makes the scroll
      // positions below exact, not approximate.

      /**
       * Fires a `scroll` event landing exactly on domIndex `index`'s slot at
       * the given box width, and waits for the rAF-throttled handler.
       */
      async function settleAt(index: number, boxWidth: number) {
        const element = scroller();
        element.scrollLeft = index * boxWidth;
        fireEvent.scroll(element);
        await flushScroll();
      }

      /**
       * Settles the reader on domIndex 2 (page 3 of `PAGE_COUNT`) at an
       * 800px viewport and clears any pending programmatic scroll, so the
       * corrupting scroll event fired later in each test is unambiguously
       * the only thing that could move `currentPage`. `goToSpread`'s own
       * smooth-scroll target never actually moves `scrollLeft` in jsdom;
       * `settleAt` reports it arrived by hand instead.
       */
      async function settleOnThirdPage() {
        renderViewer(PAGE_COUNT);
        resizeViewport(800);
        const user = userEvent.setup();
        await user.keyboard("{ArrowRight}");
        await user.keyboard("{ArrowRight}");
        expect(screen.getByText(`3 / ${PAGE_COUNT}`)).toBeInTheDocument();

        await settleAt(2, 800);
        expect(screen.getByText(`3 / ${PAGE_COUNT}`)).toBeInTheDocument();
      }

      /**
       * Fires a `scroll` event at the slot for domIndex 3, using the layout
       * and viewport width still in effect *before* a panel's real resize
       * has been measured — standing in for the browser's own scroll-snap
       * reaction to `.scroller` narrowing the instant the panel's DOM
       * mutation commits, which reaches `handleScroll` before `viewportWidth`
       * has caught up with the new width. `boxWidth` must match whatever
       * width is currently in effect for this to land on a spread other than
       * the one the reader is actually on.
       */
      function fireMisalignedResnapScroll(boxWidth: number) {
        const element = scroller();
        element.scrollLeft = 3 * boxWidth;
        fireEvent.scroll(element);
      }

      it("is corrupted by a stray re-snap scroll when nothing guards the resize commit (control)", async () => {
        // This reproduces the bug on a sequence with nothing at all opening
        // or closing a panel, to confirm the scenario below actually
        // exercises the regression: with no pending target set,
        // `handleScroll` has nothing to reject the stray event with, and
        // takes it as the truth.
        await settleOnThirdPage();

        fireMisalignedResnapScroll(800);
        await flushScroll();

        expect(screen.getByText(`4 / ${PAGE_COUNT}`)).toBeInTheDocument();
      });

      it("stays on the same page when the notes panel opens, before the resize is measured", async () => {
        await settleOnThirdPage();

        // Opening the panel is what the fix must guard: its own commit
        // stamps `pendingDomIndexRef` synchronously (a layout effect), before
        // this hand-fired stand-in for the browser's re-snap event can be
        // observed.
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "メモ" }));

        fireMisalignedResnapScroll(800);
        await flushScroll();

        // Unlike the control test above, the guard set when the panel opened
        // must have rejected this scroll: still page 3, not 4.
        expect(screen.getByText(`3 / ${PAGE_COUNT}`)).toBeInTheDocument();

        // The real resize then lands (e.g. the notes panel's width applying,
        // reported through the ResizeObserver) and must settle cleanly on
        // the original page rather than leaving anything stuck.
        resizeViewport(700);
        expect(screen.getByText(`3 / ${PAGE_COUNT}`)).toBeInTheDocument();
      });

      it("stays on the same page when the notes panel closes, before the resize is measured", async () => {
        await settleOnThirdPage();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "メモ" }));
        resizeViewport(700);
        // Settle for real at the opened width, so the guard the close click
        // exercises below is its own — not leftover from the open above.
        await settleAt(2, 700);
        expect(screen.getByText(`3 / ${PAGE_COUNT}`)).toBeInTheDocument();

        // Closing goes through the same guarded commit as opening did.
        await user.click(screen.getByRole("button", { name: "メモ" }));

        fireMisalignedResnapScroll(700);
        await flushScroll();
        expect(screen.getByText(`3 / ${PAGE_COUNT}`)).toBeInTheDocument();

        resizeViewport(800);
        expect(screen.getByText(`3 / ${PAGE_COUNT}`)).toBeInTheDocument();
      });
    });

    describe("handleScroll ignores drift while viewportWidth hasn't caught up with the DOM (issue #68 review)", () => {
      /**
       * Reports `scroller.clientWidth` as `width` on the element instance
       * (overriding jsdom's own accessor, which always reports 0 — real
       * layout never happens there). Only an instance override is needed:
       * each test renders its own viewer, so nothing leaks across tests.
       */
      function stubClientWidth(width: number) {
        Object.defineProperty(scroller(), "clientWidth", {
          configurable: true,
          value: width,
        });
      }

      /** Fires a `scroll` event at `left` and lets the rAF handler run. */
      async function scrollTo(left: number) {
        const element = scroller();
        element.scrollLeft = left;
        fireEvent.scroll(element);
        await flushScroll();
      }

      it("ignores repeated drift events while clientWidth disagrees with viewportWidth", async () => {
        renderViewer(PAGE_COUNT);
        resizeViewport(800);

        // Settle on domIndex 0 for real (default `clientWidth`, 0 in jsdom,
        // leaves the invariant check below inactive) so the pending guard
        // from the initial resize is cleared before the drift below —
        // otherwise that guard alone, not the invariant this test is about,
        // would already block it.
        await scrollTo(0);
        expect(screen.getByText(`1 / ${PAGE_COUNT}`)).toBeInTheDocument();

        // `resizeViewport(800)` above is what set `viewportWidth` to 800; a
        // real client width 100px off that — as `.scroller` would carry
        // mid-resize, before the next `ResizeObserver` callback updates
        // `viewportWidth` — must keep `nearestItemIndex`'s viewportWidth
        // input (and thus its result) from being trusted, no matter how many
        // drift events arrive while it disagrees.
        stubClientWidth(700);

        // Three separate `scroll` events (separate rAF ticks), all landing
        // on domIndex 1's slot — standing in for WebKit's re-snap drifting
        // across several events rather than settling on the first one, which
        // is exactly what let it slip past a pending-only guard.
        await scrollTo(800);
        await scrollTo(800);
        await scrollTo(800);

        expect(screen.getByText(`1 / ${PAGE_COUNT}`)).toBeInTheDocument();
      });

      it("resumes updating currentPage once clientWidth agrees with viewportWidth again", async () => {
        renderViewer(PAGE_COUNT);
        resizeViewport(800);
        await scrollTo(0);
        expect(screen.getByText(`1 / ${PAGE_COUNT}`)).toBeInTheDocument();

        // Matches `viewportWidth` exactly: the DOM has caught up, so this is
        // indistinguishable from a real, settled browser.
        stubClientWidth(800);
        await scrollTo(800);

        expect(screen.getByText(`2 / ${PAGE_COUNT}`)).toBeInTheDocument();
      });
    });

    describe("handleScroll re-issues scrollTo when the engine re-snaps over a pending target (issue #68 review)", () => {
      // Real-device telemetry: a panel opening issues a reposition
      // `scrollTo` for the pending spread at the new client width, but
      // WebKit can re-snap the container from its *old* pixel offset against
      // the *new* box widths, landing on a different spread and overwriting
      // that `scrollTo` after the fact. The pending guard alone keeps
      // `currentPage` correct (the mismatched event never passes it), but
      // does nothing to pull the *view* back — nothing was re-issuing
      // `scrollTo` after the engine's own overwrite. These tests exercise
      // that recovery directly, once a pending target is already set.

      /** Fires a `scroll` event at `left` and lets the rAF handler run. */
      async function scrollTo(left: number) {
        const element = scroller();
        element.scrollLeft = left;
        fireEvent.scroll(element);
        await flushScroll();
      }

      // A failed assertion would skip an inline `mockRestore()`, leaking the
      // `Element.prototype.scrollTo` spy into later tests — restoring it in
      // `afterEach` runs either way. Deliberately narrower than
      // `vi.restoreAllMocks()`, which would also tear down spies other
      // describes set up once at collection time (the wheel-scrolling
      // block's `scrollBy` spy, for one) before their own tests ever run.
      let scrollToSpy: ReturnType<typeof vi.spyOn> | undefined;
      function spyOnScrollTo() {
        scrollToSpy = vi.spyOn(Element.prototype, "scrollTo");
        return scrollToSpy;
      }
      afterEach(() => {
        scrollToSpy?.mockRestore();
        scrollToSpy = undefined;
      });

      /**
       * Settles on page 2 (domIndex 1) and then re-stamps a pending target
       * there through the panel-open path (`notesOpen`'s stamp effect,
       * `behavior: "auto"`) rather than through a smooth `goToSpread` —
       * `pendingSelfHealRef` only enables the recovery these tests are about
       * for the former (issue #68 review). The `ArrowRight` used to get to
       * page 2 sets its own, smooth-flagged pending target first; settling
       * it for real (rather than leaving it hanging) keeps that from being
       * the pending target these tests end up exercising instead.
       */
      async function pendingViaPanelOpen() {
        renderViewer(PAGE_COUNT);
        resizeViewport(800);
        await scrollTo(0);
        expect(screen.getByText(`1 / ${PAGE_COUNT}`)).toBeInTheDocument();

        const user = userEvent.setup();
        await user.keyboard("{ArrowRight}");
        await scrollTo(1 * 800);
        expect(screen.getByText(`2 / ${PAGE_COUNT}`)).toBeInTheDocument();

        // Opening the notes panel re-stamps pending at domIndex 1 (where the
        // reader now actually is) through the `auto`/self-heal-eligible path.
        await user.click(screen.getByRole("button", { name: "メモ" }));
        return user;
      }

      it("re-issues scrollTo at the pending spread's offset and leaves currentPage alone", async () => {
        const scrollToSpy = spyOnScrollTo();
        await pendingViaPanelOpen();
        scrollToSpy.mockClear();

        // A scroll landing on domIndex 3's slot instead — standing in for
        // the engine's own re-snap overwriting the pending `scrollTo` above.
        await scrollTo(3 * 800);

        // currentPage must not have been dragged along to whatever spread
        // this stray position nominally points at.
        expect(screen.getByText(`2 / ${PAGE_COUNT}`)).toBeInTheDocument();
        // The view must have been fought back to the pending spread's own
        // offset (domIndex 1 at an 800px box width: 1 * 800 = 800), not left
        // wherever the engine's re-snap put it.
        expect(scrollToSpy).toHaveBeenCalledWith({
          left: 800,
          behavior: "auto",
        });
      });

      it("stops re-issuing scrollTo once the recovery cap is reached, without corrupting currentPage", async () => {
        const scrollToSpy = spyOnScrollTo();
        await pendingViaPanelOpen();
        scrollToSpy.mockClear();

        // A browser that kept re-snapping away from the pending spread on
        // every single event — the pathological case the cap exists for.
        // MAX_RESNAP_RECOVERY_ATTEMPTS is 8 as of this writing; this fires
        // more than that so the cap is what stops it, not running out of
        // events.
        for (let i = 0; i < 10; i += 1) {
          await scrollTo(3 * 800);
        }

        expect(scrollToSpy).toHaveBeenCalledTimes(8);
        // Giving up on re-issuing scrollTo must not also give up on the
        // pending guard: currentPage still must not have been corrupted.
        expect(screen.getByText(`2 / ${PAGE_COUNT}`)).toBeInTheDocument();
      });

      it("does not re-issue scrollTo for an in-progress smooth goToSpread scroll", async () => {
        const scrollToSpy = spyOnScrollTo();
        renderViewer(PAGE_COUNT);
        resizeViewport(800);
        await scrollTo(0);
        expect(screen.getByText(`1 / ${PAGE_COUNT}`)).toBeInTheDocument();

        // `ArrowRight` is a smooth `goToSpread`; its own pending target is
        // *not* self-heal-eligible (`pendingSelfHealRef` stays false), since
        // a real smooth scroll legitimately passes through other spreads —
        // each firing its own `scroll` event with `nearest !== pending` — on
        // its way to landing.
        const user = userEvent.setup();
        await user.keyboard("{ArrowRight}");
        expect(screen.getByText(`2 / ${PAGE_COUNT}`)).toBeInTheDocument();
        scrollToSpy.mockClear();

        // Stands in for an intermediate frame of that smooth animation,
        // still short of domIndex 1.
        await scrollTo(3 * 800);

        expect(scrollToSpy).not.toHaveBeenCalled();
        // The pending guard on its own still keeps currentPage from being
        // dragged along to this intermediate position.
        expect(screen.getByText(`2 / ${PAGE_COUNT}`)).toBeInTheDocument();
      });
    });
  });

  it("closes the document from the toolbar", async () => {
    const { onClose, user } = renderViewer();

    await user.click(screen.getByRole("button", { name: "← ライブラリ" }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  describe("render-cache prefetch (issue #12)", () => {
    /** Scrolls to `left`, letting the rAF-throttled handler and its idle
     * prefetch callback (a `setTimeout` fallback in jsdom) both run. */
    async function scrollTo(left: number) {
      const element = scroller();
      element.scrollLeft = left;
      fireEvent.scroll(element);
      await flushScroll();
    }

    it("warms pages beyond the visible range once idle, ahead of the scroll direction", async () => {
      const { doc } = renderViewer(200);

      // A first move establishes a scroll position to move forward from; a
      // second move, further along, is what reads as "forward".
      await scrollTo(3000);
      const visibleBeforePrefetch = renderedPages();
      vi.mocked(doc.renderPage).mockClear();

      await scrollTo(9000);

      await waitFor(() => {
        const pages = vi
          .mocked(doc.renderPage)
          .mock.calls.map((call) => call[0]);
        // The synchronous overscan render already covers what's on screen;
        // a page past all of that can only have come from the prefetch.
        expect(
          pages.some(
            (page) =>
              page > Math.max(...renderedPages(), ...visibleBeforePrefetch),
          ),
        ).toBe(true);
      });
    });

    it("does not touch the DOM — a prefetched page never appears as a rendered page label", async () => {
      const { doc } = renderViewer(200);
      await scrollTo(3000);
      vi.mocked(doc.renderPage).mockClear();

      await scrollTo(9000);
      // Both the "is there a call at all" and the "is one of them a
      // prefetch" checks live inside `waitFor`: the first `renderPage` call
      // to land after the scroll is usually the synchronous visible-range
      // render, and only the idle-scheduled prefetch call afterwards is what
      // this asserts on — checking once, as soon as any call exists, would
      // be flaky. `rendered` is read fresh on every poll too, since the
      // visible set the synchronous render targets keeps settling for a few
      // ticks after the scroll.
      await waitFor(() => {
        const rendered = new Set(renderedPages());
        const prefetchedOnly = vi
          .mocked(doc.renderPage)
          .mock.calls.map((call) => call[0])
          .filter((page) => !rendered.has(page));
        // At least one call was for a page prefetch alone warmed the cache
        // for — it rendered into an offscreen canvas, not one on screen.
        expect(prefetchedOnly.length).toBeGreaterThan(0);
      });
    });

    it("gives a prefetched canvas the same page__canvas class as an on-screen one", async () => {
      // A cache hit is re-attached to the DOM as-is (see PageCanvas), so a
      // prefetched canvas missing this class would paint inline instead of
      // `display: block` and throw off the page's layout once scrolled to.
      const { doc } = renderViewer(200);
      await scrollTo(3000);
      const rendered = new Set(renderedPages());
      vi.mocked(doc.renderPage).mockClear();

      await scrollTo(9000);
      await waitFor(() => {
        const prefetchCall = vi
          .mocked(doc.renderPage)
          .mock.calls.find((call) => !rendered.has(call[0]));
        expect(prefetchCall).toBeDefined();
        expect(prefetchCall?.[1].canvas.className).toBe("page__canvas");
      });
    });

    it("discards a prefetched canvas instead of caching it when it alone exceeds the pixel budget", async () => {
      const { doc } = renderViewer(200);
      // Simulate an oversized render (the extreme-zoom scenario this guards
      // against): every canvas handed to `renderPage` comes back far bigger
      // than the cache's entire default pixel budget on its own.
      vi.mocked(doc.renderPage).mockImplementation(
        async (_pageNumber, options) => {
          options.canvas.width = 20_000;
          options.canvas.height = 20_000; // 400,000,000px
        },
      );

      await scrollTo(3000);
      vi.mocked(doc.renderPage).mockClear();
      await scrollTo(9000);

      const prefetchedPage = await waitFor(() => {
        const rendered = new Set(renderedPages());
        const prefetchCall = vi
          .mocked(doc.renderPage)
          .mock.calls.find((call) => !rendered.has(call[0]));
        expect(prefetchCall).toBeDefined();
        // Discarded, not cached: the prefetch path must not lean on
        // PageRenderCache.set's "keep the one entry that alone exceeds the
        // budget" rule — that rule assumes the entry is the page on screen,
        // which an offscreen prefetch is not. Zeroing it here is the same
        // release the cache's own eviction uses for a canvas nobody needs.
        expect(prefetchCall?.[1].canvas.width).toBe(0);
        expect(prefetchCall?.[1].canvas.height).toBe(0);
        return prefetchCall![0];
      });

      // The zeroing alone is not proof the page was never cached — a broken
      // implementation that called `cache.set` *before* zeroing would leave
      // a zero-size canvas sitting in the cache: a "hit" on the next scroll
      // that paints nothing. Scrolling the discarded page into view and
      // seeing `renderPage` run for it again is the behavioural proof that
      // it was actually skipped, not cached blank.
      vi.mocked(doc.renderPage).mockClear();
      await scrollTo((prefetchedPage - 1) * spreadWidthPx());

      await waitFor(() => {
        expect(
          vi
            .mocked(doc.renderPage)
            .mock.calls.some((call) => call[0] === prefetchedPage),
        ).toBe(true);
      });
    });

    it("cancels a pending prefetch when the component unmounts", async () => {
      const { doc, unmount } = renderViewer(200);
      await scrollTo(3000);
      vi.mocked(doc.renderPage).mockClear();

      await scrollTo(9000);
      unmount();
      const countAtUnmount = vi.mocked(doc.renderPage).mock.calls.length;

      // Give any timer that survived the unmount a chance to fire; none
      // should, and the call count must not grow after teardown.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(vi.mocked(doc.renderPage).mock.calls.length).toBe(countAtUnmount);
    });

    it("cancels a pending prefetch when the document prop is replaced (no unmount)", async () => {
      // Same scenario as above, but the component itself stays mounted — only
      // its `doc` prop changes, the way App.tsx swaps documents on `openPath`.
      // The prefetch effect's own cleanup (not an unmount) is what must catch
      // this: without it, the old document's renderer would keep receiving
      // idle-scheduled prefetch calls for a document nobody can see any more.
      const docA = fakeDoc(200);
      const docB = fakeDoc(200);
      const onClose = vi.fn();
      const view = (doc: PdfDocumentHandle) => (
        <PdfViewer
          doc={doc}
          pageSizes={pageSizes(200)}
          filePath="/papers/paper.pdf"
          fileName="paper.pdf"
          onClose={onClose}
        />
      );
      const { rerender } = render(view(docA));

      await scrollTo(3000);
      vi.mocked(docA.renderPage).mockClear();
      await scrollTo(9000);

      rerender(view(docB));
      const countAtSwap = vi.mocked(docA.renderPage).mock.calls.length;

      // Give any timer that survived the swap a chance to fire; none should
      // land on the old document.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(vi.mocked(docA.renderPage).mock.calls.length).toBe(countAtSwap);
    });
  });

  describe("render priority (issue #35)", () => {
    /** Only the pages this scenario controls — a background prefetch may
     * also call `renderPage` for pages neither queued nor asserted on here,
     * and those calls must not be mistaken for part of the sequence below. */
    const TRACKED = [1, 2, 10, 11, 12];

    it("hands a newly visible spread's page to the renderer before an overscan spread's page that was already queued ahead of it", async () => {
      const doc = fakeDoc(20);
      const order: number[] = [];
      const gates = new Map<number, () => void>();
      // Every render is held open until this test resolves it by hand — the
      // fake stands in for pdf.js's worker being busy with something else,
      // the situation `RenderQueue` exists to arbitrate.
      vi.mocked(doc.renderPage).mockImplementation(
        (pageNumber: number) =>
          new Promise<void>((resolve) => {
            order.push(pageNumber);
            gates.set(pageNumber, resolve);
          }),
      );
      const tracked = () => order.filter((page) => TRACKED.includes(page));
      const resolvePage = (pageNumber: number) => {
        const resolve = gates.get(pageNumber);
        if (!resolve) {
          throw new Error(`renderPage(${pageNumber}) was never called`);
        }
        resolve();
      };

      render(
        <PdfViewer
          doc={doc}
          pageSizes={pageSizes(20)}
          filePath="/papers/paper.pdf"
          fileName="paper.pdf"
          onClose={vi.fn()}
        />,
      );

      // Page 1 (domIndex 0, visible) starts immediately — the queue was
      // idle. Page 2 (domIndex 1, overscan) queues behind it.
      await waitFor(() => expect(tracked()).toEqual([1]));
      resolvePage(1);
      // Page 2 now occupies the single slot, held open here to model a
      // render still in flight — exactly what a reader flipping pages
      // quickly leaves behind for the next spread to queue up against.
      await waitFor(() => expect(tracked()).toEqual([1, 2]));

      // A fast jump: spread index 10 becomes the strictly-visible one.
      // domIndex 9 (page 10) and 11 (page 12) are the new overscan
      // neighbours; domIndex 9's `PageCanvas` commits before domIndex 10's
      // (ascending DOM order), so page 10 is queued — behind page 2, still
      // running — *before page 11 (the actually-visible page) exists at all*.
      const element = scroller();
      element.scrollLeft = 1480; // 10 spreads × 148px (100px page + 2×24px padding)
      fireEvent.scroll(element);
      await flushScroll();
      // Scheduling alone does not call `renderPage` yet — only page 2's own
      // resolution, next, drains the queue far enough to reach it.
      expect(tracked()).toEqual([1, 2]);

      resolvePage(2);
      // Page 11 is what the reader is actually looking at now. Despite page
      // 10 having been queued first, priority must still put page 11 first.
      await waitFor(() => expect(tracked()).toEqual([1, 2, 11]));

      resolvePage(11);
      await waitFor(() => expect(tracked()).toEqual([1, 2, 11, 10]));

      resolvePage(10);
      await waitFor(() => expect(tracked()).toEqual([1, 2, 11, 10, 12]));

      resolvePage(12);
    });

    it("hands a prefetch target to the renderer only after the visible and overscan work ahead of it", async () => {
      const doc = fakeDoc(20);
      const order: number[] = [];
      const gates = new Map<number, () => void>();
      // Every render is held open until this test resolves it by hand, same
      // as above — the fake stands in for the worker being busy, which is
      // exactly the situation the prefetch effect must yield to.
      vi.mocked(doc.renderPage).mockImplementation(
        (pageNumber: number) =>
          new Promise<void>((resolve) => {
            order.push(pageNumber);
            gates.set(pageNumber, resolve);
          }),
      );
      const resolvePage = (pageNumber: number) => {
        const resolve = gates.get(pageNumber);
        if (!resolve) {
          throw new Error(`renderPage(${pageNumber}) was never called`);
        }
        resolve();
      };
      // Only used to detect, deterministically, the moment the prefetch
      // effect's idle callback (a `setTimeout` fallback in jsdom — see
      // `scheduleIdle`) has reached the queue — a fixed real-time wait would
      // either race a slow CI runner or pad every run with dead time.
      const scheduleSpy = vi.spyOn(RenderQueue.prototype, "schedule");

      render(
        <PdfViewer
          doc={doc}
          pageSizes={pageSizes(20)}
          filePath="/papers/paper.pdf"
          fileName="paper.pdf"
          onClose={vi.fn()}
        />,
      );

      // Page 1 (domIndex 0, visible) starts immediately; page 2 (domIndex 1,
      // overscan) queues behind it.
      await waitFor(() => expect(order).toEqual([1]));

      // Wait for page 3 — the one target beyond the initial overscan range
      // with `PREFETCH_COUNT` halved for a stationary reader
      // (`direction: "none"`) — to actually reach the queue at "prefetch"
      // priority.
      await waitFor(() =>
        expect(
          scheduleSpy.mock.calls.some((call) => call[0] === "prefetch"),
        ).toBe(true),
      );
      scheduleSpy.mockRestore();

      // Reaching the queue is not the same as reaching the renderer: page 1
      // is still the only call `doc.renderPage` has actually seen.
      expect(order).toEqual([1]);

      resolvePage(1);
      await waitFor(() => expect(order).toEqual([1, 2]));

      resolvePage(2);
      // Only once both the visible and overscan work ahead of it have
      // drained does the prefetch target reach the renderer — issue #35's
      // whole point is that a prefetch never gets there first.
      await waitFor(() => expect(order).toEqual([1, 2, 3]));

      resolvePage(3);
    });

    it("holds overscan spreads at prefetch priority while the range keeps moving, then promotes them once it settles", async () => {
      // This one spies on `RenderQueue.schedule` directly rather than
      // inferring priority from `renderPage` call *order* (as the other
      // tests in this file do): "overscan" and "prefetch" only ever differ
      // in dequeue order when something else is *also* pending at a
      // different tier to race against, and the only other source of a
      // "prefetch"-tier task is the background prefetch effect, whose own
      // `scheduleIdle` callback is inherently deferred — it always reaches
      // the queue a tick *after* the same range's synchronously-scheduled
      // overscan neighbours, and gets aborted-and-dropped outright by any
      // further range change before it even gets that far (same as any
      // other stale queued task). There is no way, using only real app
      // effects, to get a genuine prefetch task to arrive at the queue
      // ahead of an overscan-tier one it could be compared against — so the
      // priority actually passed to `schedule` has to be read directly.
      const doc = fakeDoc(20);
      // Never resolves: every render sits in (or behind) the queue for the
      // whole test, so the settle transition's re-schedule is still
      // observable — an already-cached page would short-circuit straight
      // past `RenderQueue` on its next mount and never call `schedule` again.
      vi.mocked(doc.renderPage).mockImplementation(
        () => new Promise<void>(() => {}),
      );
      const scheduleSpy = vi.spyOn(RenderQueue.prototype, "schedule");

      render(
        <PdfViewer
          doc={doc}
          pageSizes={pageSizes(20)}
          filePath="/papers/paper.pdf"
          fileName="paper.pdf"
          onClose={vi.fn()}
        />,
      );

      // Page 1 (visible) and page 2 (overscan, domIndex 1) are both
      // scheduled on mount. Nothing has "moved" yet, so page 2 gets full
      // "overscan" priority straight away — the debounce must never delay
      // the document's own opening overscan neighbour.
      await waitFor(() =>
        expect(
          scheduleSpy.mock.calls.some((call) => call[0] === "overscan"),
        ).toBe(true),
      );
      scheduleSpy.mockClear();

      // A fast jump: spread index 10 becomes strictly visible.
      const element = scroller();
      element.scrollLeft = 1480; // 10 spreads × 148px (100px page + 2×24px padding)
      fireEvent.scroll(element);
      await flushScroll();

      // domIndex 9 (page 10) and domIndex 11 (page 12) — the new overscan
      // neighbours — must be scheduled at "prefetch" while the debounce
      // holds, never at "overscan", even though domIndex 10 (page 11, the
      // new visible spread) is scheduled at "visible" as always.
      await waitFor(() =>
        expect(
          scheduleSpy.mock.calls.some((call) => call[0] === "visible"),
        ).toBe(true),
      );
      expect(
        scheduleSpy.mock.calls.some((call) => call[0] === "overscan"),
      ).toBe(false);

      scheduleSpy.mockClear();

      // Once the range has sat still for OVERSCAN_SETTLE_MS with no further
      // movement, the same two overscan spreads are re-scheduled at full
      // "overscan" priority — the debounce lifting on its own, not a scroll.
      await waitFor(
        () =>
          expect(
            scheduleSpy.mock.calls.some((call) => call[0] === "overscan"),
          ).toBe(true),
        { timeout: OVERSCAN_SETTLE_MS + 1000 },
      );

      scheduleSpy.mockRestore();
    });
  });

  describe("wheel scrolling", () => {
    // Fit zoom makes every spread box exactly as wide as the viewport
    // (issue #68), which leaves `scroll-snap-type: x mandatory` no free
    // range inside a box for a raw pixel `scrollBy` to move through — the
    // engine snaps straight back on every event. Wheel/trackpad paging turns
    // whole spreads instead (issue #68 / #71, `TURN_THRESHOLD`), so these
    // assert against the page indicator rather than a `scrollBy` call.

    it("turns the page after one classic wheel notch (deltaY 120)", () => {
      renderViewer();

      fireEvent.wheel(scroller(), { deltaY: 120, deltaX: 0 });

      expect(screen.getByText(`2 / ${PAGE_COUNT}`)).toBeInTheDocument();
    });

    it("still reads forward on a downward wheel once right-bound", async () => {
      const { user } = renderViewer();
      await user.click(screen.getByRole("button", { name: "左綴じ" }));

      fireEvent.wheel(scroller(), { deltaY: 120, deltaX: 0 });

      // "Down" always means "read on", regardless of binding: `goToSpread`
      // -> `toDomIndex` is what flips the physical scroll direction for a
      // right-bound book, so the wheel handler's own turn direction never
      // has to.
      expect(screen.getByText(`2 / ${PAGE_COUNT}`)).toBeInTheDocument();
    });

    it("does not turn the page before the threshold is reached", () => {
      renderViewer();

      fireEvent.wheel(scroller(), { deltaY: 60, deltaX: 0 });

      expect(screen.getByText(`1 / ${PAGE_COUNT}`)).toBeInTheDocument();
    });

    it("turns the page once several small deltas accumulate past the threshold", () => {
      renderViewer();

      fireEvent.wheel(scroller(), { deltaY: 60, deltaX: 0 });
      expect(screen.getByText(`1 / ${PAGE_COUNT}`)).toBeInTheDocument();

      fireEvent.wheel(scroller(), { deltaY: 60, deltaX: 0 });

      expect(screen.getByText(`2 / ${PAGE_COUNT}`)).toBeInTheDocument();
    });

    it("turns several pages from one outsized delta, e.g. a hard fling", () => {
      renderViewer(PAGE_COUNT);

      // 2.5 notches' worth in one event: two full turns (240 consumed),
      // leaving 60 short of a third.
      fireEvent.wheel(scroller(), { deltaY: 300, deltaX: 0 });

      expect(screen.getByText(`3 / ${PAGE_COUNT}`)).toBeInTheDocument();
    });

    it("resets the accumulator on a direction reversal", () => {
      renderViewer();

      // One notch and change forward: lands on page 2, with 80 left over.
      fireEvent.wheel(scroller(), { deltaY: 200, deltaX: 0 });
      expect(screen.getByText(`2 / ${PAGE_COUNT}`)).toBeInTheDocument();

      // Reverses direction; without a reset this would sum with the 80 left
      // over (-30 + 80 = 50, still short) rather than starting over at -30 —
      // either way short of the threshold here, so this alone only pins down
      // that reversing does not turn a page it should not yet.
      fireEvent.wheel(scroller(), { deltaY: -30, deltaX: 0 });
      expect(screen.getByText(`2 / ${PAGE_COUNT}`)).toBeInTheDocument();

      // Enough more in the same (reversed) direction to cross the threshold
      // from the reset accumulator (-30 + -100 = -130): had the leftover 80
      // instead carried over un-reset, -30 + 80 + -100 = -50 would still be
      // short, and this would still show page 2.
      fireEvent.wheel(scroller(), { deltaY: -100, deltaX: 0 });
      expect(screen.getByText(`1 / ${PAGE_COUNT}`)).toBeInTheDocument();
    });

    it("resets the accumulator after a pause longer than the reset timeout", () => {
      const now = vi.spyOn(performance, "now");
      now.mockReturnValue(0);
      renderViewer();

      fireEvent.wheel(scroller(), { deltaY: 100, deltaX: 0 });
      expect(screen.getByText(`1 / ${PAGE_COUNT}`)).toBeInTheDocument();

      // Longer than TURN_RESET_MS (300ms) since the event above.
      now.mockReturnValue(1000);
      fireEvent.wheel(scroller(), { deltaY: 100, deltaX: 0 });

      // Had the accumulator survived the pause, 100 + 100 would already have
      // crossed the threshold and turned a page.
      expect(screen.getByText(`1 / ${PAGE_COUNT}`)).toBeInTheDocument();

      now.mockRestore();
    });

    it("leaves a horizontal wheel to the browser", () => {
      renderViewer();

      fireEvent.wheel(scroller(), { deltaY: 0, deltaX: 120 });

      expect(screen.getByText(`1 / ${PAGE_COUNT}`)).toBeInTheDocument();
    });

    it("zooms instead of scrolling when the wheel carries ctrl", () => {
      renderViewer();

      fireEvent.wheel(scroller(), { deltaY: -100, ctrlKey: true });

      expect(screen.getByText(`1 / ${PAGE_COUNT}`)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "100%" })).toBeNull();
    });

    it("accumulates deltas from wheel events landing in the same commit", () => {
      renderViewer();

      // Two pinch ticks dispatched inside one `act()`, so React has no
      // chance to commit (and refresh `zoomRef`) between them — this is
      // what several wheel events arriving within a single frame look like.
      // Each must still compound onto the other's result, the same
      // guarantee the old `setZoom(current => ...)` functional update gave;
      // reading a `zoomRef` that was only refreshed once, after both, would
      // silently drop the first delta.
      act(() => {
        fireEvent.wheel(scroller(), { deltaY: -50, ctrlKey: true });
        fireEvent.wheel(scroller(), { deltaY: -50, ctrlKey: true });
      });

      const expected = Math.round(pinchZoom(pinchZoom(1, -50), -50) * 100);
      expect(
        screen.getByRole("button", { name: `${expected}%` }),
      ).toBeInTheDocument();
    });
  });

  it("lets the page indicator recover when an in-flight scroll is interrupted", async () => {
    const { user } = renderViewer();

    // Navigate away; jsdom performs no actual scrolling, so the viewer is still
    // sitting at offset 0 with a scroll to spread 2 outstanding.
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText(`2 / ${PAGE_COUNT}`)).toBeInTheDocument();

    // A horizontal wheel/trackpad pan grabs the scroller directly and
    // abandons the pending scroll, the same as a pointer-down does — unlike
    // a *vertical* wheel, which deliberately leaves an in-progress page turn
    // alone (issue #68 / #71: it may well be that turn's own pending target,
    // and the next tick of the same fling must not cancel it out from under
    // itself).
    fireEvent.wheel(scroller(), { deltaY: 0, deltaX: 10 });
    fireEvent.scroll(scroller());
    await flushScroll();

    // The indicator must follow the real position rather than stay latched.
    await waitFor(() => {
      expect(screen.getByText(`1 / ${PAGE_COUNT}`)).toBeInTheDocument();
    });
  });

  describe("table of contents sidebar", () => {
    const outline: OutlineNode[] = [
      { title: "序章", pageNumber: 1, children: [] },
      {
        title: "本論",
        pageNumber: 3,
        children: [{ title: "後半", pageNumber: 6, children: [] }],
      },
      { title: "付録", pageNumber: null, children: [] },
    ];

    async function openSidebar(
      pageCount = PAGE_COUNT,
      nodes = outline,
      paging: {
        initialPage?: number;
        onPageChange?: (page: number) => void;
      } = {},
    ) {
      const viewer = renderViewer(pageCount, nodes, {}, paging);
      await viewer.user.click(screen.getByRole("button", { name: "目次" }));
      return viewer;
    }

    it("stays closed until the toolbar button is pressed", () => {
      // Both outline-dependent notes settings (#46) are off here so this
      // stays a test of the sidebar's own laziness — with either on, the
      // outline is fetched as soon as the document opens (see the notes
      // panel describes below).
      const { doc } = renderViewer(PAGE_COUNT, outline, {
        notesOutlineInsert: false,
        notesOutlineFollow: false,
      });

      expect(screen.queryByRole("list", { name: "目次" })).toBeNull();
      expect(doc.getOutline).not.toHaveBeenCalled();
    });

    it("loads and shows the bookmark tree when opened", async () => {
      const { doc } = await openSidebar();

      expect(doc.getOutline).toHaveBeenCalledOnce();
      expect(
        (await screen.findAllByRole("listitem")).map((item) =>
          item.textContent?.replace(/[▾▸]/g, ""),
        ),
      ).toEqual(["序章1", "本論3", "後半6", "付録"]);
    });

    it("closes again on a second press", async () => {
      const { user } = await openSidebar();
      await screen.findByRole("list", { name: "目次" });

      await user.click(screen.getByRole("button", { name: "目次" }));

      expect(screen.queryByRole("list", { name: "目次" })).toBeNull();
    });

    it("jumps to the page a bookmark points at", async () => {
      const onPageChange = vi.fn();
      const { user } = await openSidebar(PAGE_COUNT, outline, {
        onPageChange,
      });
      await screen.findByRole("list", { name: "目次" });

      await user.click(screen.getByRole("button", { name: /後半/ }));

      expect(screen.getByText(`6 / ${PAGE_COUNT}`)).toBeInTheDocument();
      expect(onPageChange).toHaveBeenLastCalledWith(6);
    });

    it("offers no jump for a bookmark whose destination is unresolved", async () => {
      await openSidebar();
      await screen.findByRole("list", { name: "目次" });

      expect(screen.getByRole("button", { name: "付録" })).toBeDisabled();
    });

    it("hides and restores a bookmark's children", async () => {
      const { user } = await openSidebar();
      await screen.findByRole("list", { name: "目次" });

      await user.click(
        screen.getByRole("button", { name: "本論 を折りたたむ" }),
      );
      expect(screen.queryByRole("button", { name: /後半/ })).toBeNull();

      await user.click(screen.getByRole("button", { name: "本論 を展開する" }));
      expect(screen.getByRole("button", { name: /後半/ })).toBeInTheDocument();
    });

    it("highlights the section the reader is currently in", async () => {
      const { user } = await openSidebar();
      await screen.findByRole("list", { name: "目次" });

      const selected = () =>
        screen
          .getAllByRole("listitem")
          .find((item) => item.querySelector('[aria-current="true"]'))
          ?.textContent?.replace(/[▾▸]/g, "");

      expect(selected()).toBe("序章1");

      // Page 4 is inside 本論 (p3) but before 後半 (p6).
      await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
      expect(screen.getByText(`4 / ${PAGE_COUNT}`)).toBeInTheDocument();
      expect(selected()).toBe("本論3");

      await user.keyboard("{ArrowRight}{ArrowRight}");
      expect(selected()).toBe("後半6");
    });

    it("keeps arrow keys for the sidebar while it has focus", async () => {
      const { user } = await openSidebar();
      await screen.findByRole("list", { name: "目次" });

      screen.getByRole("button", { name: /序章/ }).focus();
      await user.keyboard("{ArrowRight}");

      // The page-turn shortcut must not fire; the reader is still on page 1.
      expect(screen.getByText(`1 / ${PAGE_COUNT}`)).toBeInTheDocument();
    });

    it("trims the surrounding whitespace off a bookmark title", async () => {
      await openSidebar(PAGE_COUNT, [
        { title: "  序章  ", pageNumber: 1, children: [] },
      ]);
      await screen.findByRole("list", { name: "目次" });

      expect(screen.getByRole("button", { name: "序章1" })).toHaveTextContent(
        /^序章1$/,
      );
    });

    it("shows a placeholder for a bookmark without a title", async () => {
      const { user } = await openSidebar(PAGE_COUNT, [
        {
          title: "",
          pageNumber: 2,
          children: [{ title: "節", pageNumber: 3, children: [] }],
        },
      ]);
      await screen.findByRole("list", { name: "目次" });

      await user.click(screen.getByRole("button", { name: "（無題）2" }));
      expect(screen.getByText(`2 / ${PAGE_COUNT}`)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "（無題） を折りたたむ" }),
      ).toBeInTheDocument();
    });

    it("falls back to page thumbnails when the document has no bookmarks", async () => {
      const onPageChange = vi.fn();
      const { user } = await openSidebar(PAGE_COUNT, [], { onPageChange });

      const thumbnail = await screen.findByRole("button", { name: "3ページ" });
      await user.click(thumbnail);

      expect(screen.getByText(`3 / ${PAGE_COUNT}`)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "3ページ" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(
        screen.getByRole("button", { name: "1ページ" }),
      ).not.toHaveAttribute("aria-current");
      expect(onPageChange).toHaveBeenLastCalledWith(3);
    });

    it("mounts only a few thumbnails of a long document", async () => {
      await openSidebar(300, []);
      await screen.findByRole("button", { name: "1ページ" });

      // Every page gets a clickable row, but only a virtualized window of them
      // is actually handed to the renderer.
      expect(
        screen.getAllByRole("button", { name: /^\d+ページ$/ }),
      ).toHaveLength(300);
      expect(
        document.querySelectorAll(".thumbnail .page:not(.page--placeholder)")
          .length,
      ).toBeLessThanOrEqual(8);
    });
  });

  describe("highlights", () => {
    async function openPanel(annotations?: Annotations) {
      if (annotations) mockSidecar(annotations);
      const viewer = renderViewer();
      await viewer.user.click(
        screen.getByRole("button", { name: "ハイライト" }),
      );
      return viewer;
    }

    it("loads the sidecar annotations for the opened file", async () => {
      renderViewer();

      await waitFor(() =>
        expect(loadAnnotations).toHaveBeenCalledWith("/papers/paper.pdf"),
      );
    });

    it("mounts a selectable text layer on rendered pages", async () => {
      const { doc } = renderViewer();

      await waitFor(() => expect(doc.renderTextLayer).toHaveBeenCalled());
      expect(document.querySelector(".textLayer")).not.toBeNull();
    });

    it("lists saved highlights in reading order with page numbers", async () => {
      await openPanel({
        ...emptyAnnotations(),
        highlights: [
          fakeHighlight({ id: "later", page: 5, text: "後のほう" }),
          fakeHighlight({ id: "earlier", page: 2, text: "先のほう" }),
        ],
      });

      const items = await screen.findAllByRole("listitem");
      expect(items[0]).toHaveTextContent("先のほう");
      expect(items[0]).toHaveTextContent("p.2");
      expect(items[1]).toHaveTextContent("後のほう");
    });

    it("shows an empty-state hint when there are no highlights", async () => {
      await openPanel();

      expect(
        await screen.findByText(/テキストを選択して色を選ぶ/),
      ).toBeInTheDocument();
    });

    it("draws highlight rects over the pages that carry them", async () => {
      await openPanel({
        ...emptyAnnotations(),
        highlights: [fakeHighlight({ page: 1 })],
      });

      await waitFor(() =>
        expect(document.querySelectorAll(".page__highlight")).toHaveLength(1),
      );
    });

    it("jumps to the highlight's page from the list", async () => {
      const { user } = await openPanel({
        ...emptyAnnotations(),
        highlights: [fakeHighlight({ page: 5, text: "後のほう" })],
      });

      await user.click(await screen.findByRole("button", { name: /後のほう/ }));

      expect(screen.getByText(`5 / ${PAGE_COUNT}`)).toBeInTheDocument();
    });

    it("deletes a highlight and persists the removal", async () => {
      const { user } = await openPanel({
        ...emptyAnnotations(),
        highlights: [fakeHighlight()],
      });
      await screen.findAllByRole("listitem");

      await user.click(screen.getByRole("button", { name: "削除" }));

      expect(screen.queryByRole("listitem")).toBeNull();
      await waitFor(() => expect(saveAnnotations).toHaveBeenCalled());
      expect(
        vi.mocked(saveAnnotations).mock.calls[0][1].highlights,
      ).toHaveLength(0);
    });

    it("copies the extracted text to the clipboard", async () => {
      // userEvent.setup() installs a working clipboard stub in jsdom.
      const { user } = await openPanel({
        ...emptyAnnotations(),
        highlights: [fakeHighlight({ text: "コピーされる本文" })],
      });
      await screen.findAllByRole("listitem");

      await user.click(screen.getByRole("button", { name: "コピー" }));

      expect(await navigator.clipboard.readText()).toBe("コピーされる本文");
    });

    it("appends the highlight to the notes panel as a quote", async () => {
      // mockSidecar resets the notes mock, so the note's content is set after
      // it and before the viewer mounts and loads it.
      mockSidecar({
        ...emptyAnnotations(),
        highlights: [fakeHighlight({ page: 3, text: "引用する本文" })],
      });
      vi.mocked(loadNotes).mockResolvedValue({
        content: "# 既存メモ",
        modifiedAtMs: 7,
      });
      const { user } = await openPanel();
      await screen.findAllByRole("listitem");

      await user.click(screen.getByRole("button", { name: "メモに挿入" }));

      // The panel opens with the quote in the editor…
      const editor = await screen.findByRole("textbox", {
        name: "メモ (markdown)",
      });
      expect(editor).toHaveValue("# 既存メモ\n\n> 引用する本文\n>\n> — p.3\n");
      // …and it is written out once the autosave debounce elapses.
      await waitFor(
        () =>
          expect(saveNotes).toHaveBeenCalledWith(
            "/papers/paper.pdf",
            "# 既存メモ\n\n> 引用する本文\n>\n> — p.3\n",
            7,
          ),
        { timeout: SAVE_DEBOUNCE_MS + 1000 },
      );
    });

    it("stops claiming to be loading once the load has failed", async () => {
      vi.mocked(loadAnnotations).mockRejectedValue(new Error("読めません"));
      const { user } = renderViewer();
      await user.click(screen.getByRole("button", { name: "ハイライト" }));

      expect(await screen.findByText("読めません")).toBeInTheDocument();
      expect(screen.queryByText("読み込み中…")).toBeNull();
    });

    it("still hit-tests a click when the selection lies outside the page", async () => {
      await openPanel({
        ...emptyAnnotations(),
        highlights: [fakeHighlight({ page: 1, text: "選択済みの本文" })],
      });
      const page = document.querySelector<HTMLElement>('.page[data-page="1"]');
      if (!page) throw new Error("page 1 is not rendered");
      page.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 100, height: 140 }) as DOMRect;

      // Text selected in the panel (outside any page) must not swallow the
      // click that follows on the page itself.
      const panelText = await screen.findByText("選択済みの本文");
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(panelText);
      selection?.removeAllRanges();
      selection?.addRange(range);

      // Inside the highlight's rect (x .1–.6, y .2–.22 of a 100x140 page).
      pointerGesture(page, { x: 20, y: 30 }, { x: 20, y: 30 });

      expect(
        screen.getByRole("toolbar", { name: "ハイライト操作" }),
      ).toBeInTheDocument();
    });

    it("still hit-tests a click when the selection holds nothing to extract", async () => {
      await openPanel({
        ...emptyAnnotations(),
        highlights: [fakeHighlight({ page: 1 })],
      });
      const page = document.querySelector<HTMLElement>('.page[data-page="1"]');
      if (!page) throw new Error("page 1 is not rendered");
      page.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 100, height: 140 }) as DOMRect;

      // A selection on the page itself, but one that extracts to nothing —
      // there is no highlight to create, so this stays a plain click.
      const blank = document.createElement("span");
      blank.textContent = "   ";
      page.append(blank);
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(blank);
      // jsdom implements no Range.getClientRects; a real browser would return
      // the (zero-area) rects of this whitespace run.
      Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
      selection?.removeAllRanges();
      selection?.addRange(range);

      pointerGesture(page, { x: 20, y: 30 }, { x: 20, y: 30 });

      expect(
        screen.getByRole("toolbar", { name: "ハイライト操作" }),
      ).toBeInTheDocument();
    });

    it("treats a drag across a highlight as a pan, not a click on it", async () => {
      await openPanel({
        ...emptyAnnotations(),
        highlights: [fakeHighlight({ page: 1 })],
      });
      const page = document.querySelector<HTMLElement>('.page[data-page="1"]');
      if (!page) throw new Error("page 1 is not rendered");
      page.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 100, height: 140 }) as DOMRect;

      // Released inside the highlight, but 60px from where the finger landed.
      pointerGesture(page, { x: 80, y: 30 }, { x: 20, y: 30 });

      expect(
        screen.queryByRole("toolbar", { name: "ハイライト操作" }),
      ).toBeNull();
    });

    it("saves only the part of a selection that lies on the page", async () => {
      const { user } = await openPanel({
        ...emptyAnnotations(),
        highlights: [fakeHighlight({ page: 5, text: "パネルの本文" })],
      });
      const page = document.querySelector<HTMLElement>(
        '.scroller .page[data-page="1"]',
      );
      if (!page) throw new Error("page 1 is not rendered");
      page.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 100, height: 140 }) as DOMRect;
      // Real selections live in the text layer; the page-number label sits
      // after it and must stay out of the extract.
      const textLayer = page.querySelector(".textLayer");
      if (!textLayer) throw new Error("page 1 has no text layer");
      const onPage = document.createElement("span");
      onPage.textContent = "ページ上の本文";
      textLayer.append(onPage);
      expect(page.querySelector(".page__label")?.textContent).toBe("1");

      // jsdom lays nothing out; every range reports the same single rect.
      Range.prototype.getClientRects = () =>
        [{ left: 10, top: 28, width: 50, height: 3 }] as unknown as DOMRectList;

      // Dragged from the page into the highlights panel: the release carries a
      // selection whose text runs well past the page it started on.
      const selection = window.getSelection();
      const range = document.createRange();
      range.setStart(onPage.firstChild as Node, 0);
      range.setEnd(
        (await screen.findByText("パネルの本文")).firstChild as Node,
        6,
      );
      selection?.removeAllRanges();
      selection?.addRange(range);
      expect(range.toString()).toContain("パネルの本文");

      pointerGesture(page, { x: 20, y: 30 }, { x: 20, y: 30 });
      await user.click(
        screen.getByRole("button", { name: "黄色でハイライト" }),
      );

      await waitFor(() => expect(saveAnnotations).toHaveBeenCalled());
      const saved = vi
        .mocked(saveAnnotations)
        .mock.calls.at(-1)?.[1].highlights;
      expect(saved?.at(-1)?.text).toBe("ページ上の本文");
    });

    it("keeps the page-number label out of the extracted text", async () => {
      const { user } = await openPanel();
      const page = document.querySelector<HTMLElement>(
        '.scroller .page[data-page="1"]',
      );
      if (!page) throw new Error("page 1 is not rendered");
      page.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 100, height: 140 }) as DOMRect;
      const textLayer = page.querySelector(".textLayer");
      const label = page.querySelector(".page__label");
      if (!textLayer || !label) throw new Error("page 1 is missing its parts");
      const onPage = document.createElement("span");
      onPage.textContent = "本文の終わり";
      textLayer.append(onPage);

      Range.prototype.getClientRects = () =>
        [{ left: 10, top: 28, width: 50, height: 3 }] as unknown as DOMRectList;

      // Dragged past the end of the text and onto the page number, which is
      // part of the viewer's chrome rather than of the document.
      const selection = window.getSelection();
      const range = document.createRange();
      range.setStart(onPage.firstChild as Node, 0);
      range.setEnd(label.firstChild as Node, 1);
      selection?.removeAllRanges();
      selection?.addRange(range);
      expect(range.toString()).toBe("本文の終わり1");

      pointerGesture(page, { x: 20, y: 30 }, { x: 20, y: 30 });
      await user.click(
        screen.getByRole("button", { name: "黄色でハイライト" }),
      );

      await waitFor(() => expect(saveAnnotations).toHaveBeenCalled());
      const saved = vi
        .mocked(saveAnnotations)
        .mock.calls.at(-1)?.[1].highlights;
      expect(saved?.at(-1)?.text).toBe("本文の終わり");
    });

    it("refuses to create a highlight before the annotations have loaded", async () => {
      vi.mocked(loadAnnotations).mockReturnValue(new Promise(() => {}));
      const { user } = renderViewer();
      const page = document.querySelector<HTMLElement>(
        '.scroller .page[data-page="1"]',
      );
      if (!page) throw new Error("page 1 is not rendered");
      page.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 100, height: 140 }) as DOMRect;
      const textLayer = page.querySelector(".textLayer");
      if (!textLayer) throw new Error("page 1 has no text layer");
      const text = document.createElement("span");
      text.textContent = "まだ保存できない本文";
      textLayer.append(text);
      Range.prototype.getClientRects = () =>
        [{ left: 10, top: 28, width: 50, height: 3 }] as unknown as DOMRectList;

      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(text);
      selection?.removeAllRanges();
      selection?.addRange(range);

      pointerGesture(page, { x: 20, y: 30 }, { x: 20, y: 30 });
      await user.click(
        screen.getByRole("button", { name: "黄色でハイライト" }),
      );

      expect(
        await screen.findByText(/注釈をまだ読み込めていない/),
      ).toBeInTheDocument();
      expect(saveAnnotations).not.toHaveBeenCalled();
    });

    it("does not mistake a selection inside a thumbnail for a page selection", async () => {
      mockSidecar({
        ...emptyAnnotations(),
        highlights: [fakeHighlight({ page: 1 })],
      });
      const { user } = renderViewer();
      await user.click(screen.getByRole("button", { name: "ハイライト" }));
      // No bookmarks, so the sidebar falls back to thumbnails — which are
      // PageCanvases carrying `data-page` just like the pages in the scroller.
      await user.click(screen.getByRole("button", { name: "目次" }));
      await screen.findByRole("button", { name: "2ページ" });
      const thumbnailPage = document.querySelector<HTMLElement>(
        ".thumbnails .page[data-page]",
      );
      if (!thumbnailPage) throw new Error("no thumbnail page is rendered");
      // jsdom lays nothing out; without a real box the selection would produce
      // no rects at all and the mix-up could not show itself.
      thumbnailPage.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 60, height: 84 }) as DOMRect;
      const page = document.querySelector<HTMLElement>(
        '.scroller .page[data-page="1"]',
      );
      if (!page) throw new Error("page 1 is not rendered");
      page.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 100, height: 140 }) as DOMRect;

      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(thumbnailPage);
      Range.prototype.getClientRects = () =>
        [{ left: 0, top: 0, width: 40, height: 10 }] as unknown as DOMRectList;
      selection?.removeAllRanges();
      selection?.addRange(range);

      pointerGesture(page, { x: 20, y: 30 }, { x: 20, y: 30 });

      // The click hit-tests the page instead of offering to highlight a
      // selection whose coordinates belong to a thumbnail.
      expect(
        screen.getByRole("toolbar", { name: "ハイライト操作" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("toolbar", { name: "ハイライトを作成" }),
      ).toBeNull();
    });

    it("forgets a gesture that was released away from the pages", async () => {
      await openPanel({
        ...emptyAnnotations(),
        highlights: [fakeHighlight({ page: 1 })],
      });
      const page = document.querySelector<HTMLElement>('.page[data-page="1"]');
      if (!page) throw new Error("page 1 is not rendered");
      page.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 100, height: 140 }) as DOMRect;

      // A drag that starts on the page and ends somewhere else entirely: the
      // scroller never sees the release.
      fireEvent(
        page,
        new MouseEvent("pointerdown", {
          bubbles: true,
          clientX: 400,
          clientY: 400,
        }),
      );
      fireEvent(window, new MouseEvent("pointerup", { clientX: 900 }));

      // The next click is its own gesture and must not be measured against
      // where that abandoned drag began.
      fireEvent(
        page,
        new MouseEvent("pointerup", {
          bubbles: true,
          clientX: 20,
          clientY: 30,
        }),
      );

      expect(
        screen.getByRole("toolbar", { name: "ハイライト操作" }),
      ).toBeInTheDocument();
    });

    it("does not read the fingers lifting off a pinch as a click on a highlight", async () => {
      await openPanel({
        ...emptyAnnotations(),
        highlights: [fakeHighlight({ page: 1 })],
      });
      const page = document.querySelector<HTMLElement>('.page[data-page="1"]');
      if (!page) throw new Error("page 1 is not rendered");
      page.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 100, height: 140 }) as DOMRect;

      const track = scroller();
      fireEvent(page, touch("pointerdown", 1, { x: 20, y: 30 }));
      fireEvent(track, touch("pointerdown", 2, { x: 40, y: 30 }));
      fireEvent(window, touch("pointermove", 2, { x: 60, y: 30 }));
      // Both fingers land back within CLICK_SLOP_PX of where finger 1
      // pressed — exactly what an ordinary click on the highlight looks
      // like, if the pinch that happened in between is ignored.
      fireEvent(page, touch("pointerup", 1, { x: 21, y: 30 }));
      fireEvent(window, touch("pointerup", 2, { x: 22, y: 30 }));

      expect(
        screen.queryByRole("toolbar", { name: "ハイライト操作" }),
      ).toBeNull();
    });

    it("closes the panel on a second press", async () => {
      const { user } = await openPanel();
      await screen.findByText(/テキストを選択して色を選ぶ/);

      await user.click(screen.getByRole("button", { name: "ハイライト" }));

      expect(screen.queryByText(/テキストを選択して色を選ぶ/)).toBeNull();
    });
  });

  describe("clips", () => {
    /** Turns on the rectangle mode and hands back page 1, sized 100x140. */
    async function startClipping() {
      const { doc, user } = renderViewer();
      await user.click(screen.getByRole("button", { name: "切り取り" }));
      const page = document.querySelector<HTMLElement>('.page[data-page="1"]');
      if (!page) throw new Error("page 1 is not rendered");
      page.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 100, height: 140 }) as DOMRect;
      return { doc, page, user };
    }

    /**
     * A drag over the page. Press and release are separate events because the
     * viewer follows the release on the window, not on the page it started on;
     * the whole gesture runs inside act so the cut it kicks off settles too.
     */
    async function drag(
      page: HTMLElement,
      from: { x: number; y: number },
      to: { x: number; y: number },
    ) {
      // Each of the first two events has to settle on its own: the window
      // listeners that follow the drag are mounted by an effect the press
      // schedules, and would not be there yet inside one act block.
      fireEvent(
        page,
        new MouseEvent("pointerdown", {
          bubbles: true,
          clientX: from.x,
          clientY: from.y,
        }),
      );
      fireEvent(
        window,
        new MouseEvent("pointermove", { clientX: to.x, clientY: to.y }),
      );
      await act(async () => {
        fireEvent(
          window,
          new MouseEvent("pointerup", { clientX: to.x, clientY: to.y }),
        );
      });
    }

    it("cuts the dragged region and writes it to the sidecar", async () => {
      const { doc, page } = await startClipping();

      await drag(page, { x: 10, y: 14 }, { x: 60, y: 84 });

      await waitFor(() => expect(saveClip).toHaveBeenCalledTimes(1));
      expect(doc.renderRegion).toHaveBeenCalledWith(1, {
        rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
        signal: expect.any(AbortSignal),
      });
      expect(vi.mocked(saveClip).mock.calls[0][0]).toBe("/papers/paper.pdf");
    });

    it("records the clip in annotations.json", async () => {
      const { page } = await startClipping();

      await drag(page, { x: 10, y: 14 }, { x: 60, y: 84 });

      await waitFor(() => expect(saveAnnotations).toHaveBeenCalled());
      const saved = vi.mocked(saveAnnotations).mock.calls.at(-1)?.[1];
      expect(saved?.clips).toEqual([
        {
          id: expect.any(String),
          page: 1,
          rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
          file: "clips/clip-0001.png",
          createdAt: expect.any(String),
        },
      ]);
    });

    it("inserts the clip into the note as a markdown image", async () => {
      const { page } = await startClipping();

      await drag(page, { x: 10, y: 14 }, { x: 60, y: 84 });

      const editor = await screen.findByLabelText("メモ (markdown)");
      await waitFor(() =>
        expect(editor).toHaveValue("![p.1 の図](clips/clip-0001.png)\n"),
      );
    });

    it("refuses a second drag until the cut under way has finished", async () => {
      const { doc, page } = await startClipping();
      // `saveClip` cannot be aborted, so a cut that has begun always finishes.
      // Starting another on top of it would strand the first PNG on disk.
      let releaseFirst: (() => void) | undefined;
      vi.mocked(doc.renderRegion)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseFirst = () =>
                resolve(new Blob([new Uint8Array([1, 2, 3])]));
            }),
        )
        .mockImplementation(async () => new Blob([new Uint8Array([4, 5, 6])]));

      await drag(page, { x: 10, y: 14 }, { x: 60, y: 84 });
      // The reader is told the first cut is still running.
      expect(screen.getByRole("status")).toHaveTextContent("切り取っています…");

      await drag(page, { x: 20, y: 28 }, { x: 70, y: 98 });
      expect(doc.renderRegion).toHaveBeenCalledTimes(1);

      await act(async () => {
        releaseFirst?.();
      });

      // Only the first drag's region was written, and it was not lost.
      await waitFor(() => expect(saveClip).toHaveBeenCalledTimes(1));
      const saved = vi.mocked(saveAnnotations).mock.calls.at(-1)?.[1];
      expect(saved?.clips).toHaveLength(1);
      expect(saved?.clips[0].rect).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    });

    it("ignores a drag too small to be a region", async () => {
      const { doc, page } = await startClipping();

      await drag(page, { x: 10, y: 14 }, { x: 10.5, y: 14.5 });

      expect(doc.renderRegion).not.toHaveBeenCalled();
      expect(saveClip).not.toHaveBeenCalled();
    });

    it("does not cut anything while the mode is off", async () => {
      const { doc } = renderViewer();
      const page = document.querySelector<HTMLElement>('.page[data-page="1"]');
      if (!page) throw new Error("page 1 is not rendered");
      page.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 100, height: 140 }) as DOMRect;

      await drag(page, { x: 10, y: 14 }, { x: 60, y: 84 });

      expect(doc.renderRegion).not.toHaveBeenCalled();
    });

    it("backs out of the drag first and the mode second on Escape", async () => {
      const { doc, page } = await startClipping();
      fireEvent(
        page,
        new MouseEvent("pointerdown", {
          bubbles: true,
          clientX: 10,
          clientY: 14,
        }),
      );
      fireEvent(
        window,
        new MouseEvent("pointermove", { clientX: 60, clientY: 84 }),
      );
      expect(document.querySelector(".clip-marquee")).not.toBeNull();

      fireEvent.keyDown(window, { key: "Escape" });
      expect(document.querySelector(".clip-marquee")).toBeNull();
      expect(screen.getByRole("button", { name: "切り取り" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );

      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.getByRole("button", { name: "切り取り" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      // The release that follows the cancelled drag cuts nothing.
      fireEvent(
        window,
        new MouseEvent("pointerup", { clientX: 60, clientY: 84 }),
      );
      expect(doc.renderRegion).not.toHaveBeenCalled();
    });

    it("reports a failed cut instead of leaving the reader waiting", async () => {
      vi.mocked(saveClip).mockRejectedValue(
        new Error("Sidecar io: 書けません"),
      );
      const { page } = await startClipping();

      await drag(page, { x: 10, y: 14 }, { x: 60, y: 84 });

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Sidecar io: 書けません",
      );
      expect(saveAnnotations).not.toHaveBeenCalled();
    });

    it("refuses to cut while the note cannot take the image", async () => {
      // Nothing in this build shows a clip other than the note, so cutting one
      // that cannot be inserted would strand it on disk.
      vi.mocked(loadNotes).mockRejectedValue(new Error("読めません"));
      const { doc, page } = await startClipping();

      await drag(page, { x: 10, y: 14 }, { x: 60, y: 84 });

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "メモをまだ読み込めていないため、切り取りできません",
      );
      expect(doc.renderRegion).not.toHaveBeenCalled();
      expect(saveClip).not.toHaveBeenCalled();
    });

    it("refuses to cut before the annotations have loaded", async () => {
      vi.mocked(loadAnnotations).mockRejectedValue(new Error("読めません"));
      const { doc, page } = await startClipping();

      await drag(page, { x: 10, y: 14 }, { x: 60, y: 84 });

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "注釈をまだ読み込めていないため、切り取りを保存できません",
      );
      expect(doc.renderRegion).not.toHaveBeenCalled();
    });
  });

  describe("notes panel", () => {
    async function openNotes(content = "") {
      vi.mocked(loadNotes).mockResolvedValue({ content, modifiedAtMs: 7 });
      const viewer = renderViewer();
      await viewer.user.click(screen.getByRole("button", { name: "メモ" }));
      return {
        ...viewer,
        editor: await screen.findByRole("textbox", {
          name: "メモ (markdown)",
        }),
      };
    }

    it("shows notes.md in the editor", async () => {
      const { editor } = await openNotes("# 読書メモ");

      await waitFor(() => expect(editor).toHaveValue("# 読書メモ"));
      expect(loadNotes).toHaveBeenCalledWith("/papers/paper.pdf");
    });

    it("autosaves what was typed once the typing pauses", async () => {
      const { user, editor } = await openNotes("");
      await waitFor(() => expect(editor).toBeEnabled());

      await user.type(editor, "ひとこと");

      expect(saveNotes).not.toHaveBeenCalled();
      await waitFor(
        () =>
          expect(saveNotes).toHaveBeenCalledWith(
            "/papers/paper.pdf",
            "ひとこと",
            7,
          ),
        { timeout: SAVE_DEBOUNCE_MS + 1000 },
      );
      // One write for the whole burst, not one per keystroke.
      expect(saveNotes).toHaveBeenCalledTimes(1);
    });

    it("renders the note as markdown in the preview", async () => {
      const { user } = await openNotes("## 結論\n\n> 引用\n>\n> — p.3");
      await screen.findByDisplayValue(/結論/);

      await user.click(screen.getByRole("button", { name: "プレビュー" }));

      expect(
        screen.getByRole("heading", { level: 2, name: "結論" }),
      ).toBeInTheDocument();
      expect(document.querySelector(".markdown blockquote")).not.toBeNull();
    });

    it("keeps arrow keys in the editor instead of turning the page", async () => {
      const { user, editor } = await openNotes("abc");
      await waitFor(() => expect(editor).toHaveValue("abc"));

      await user.click(editor);
      await user.keyboard("{ArrowLeft}{ArrowLeft}");

      expect(screen.getByText(`1 / ${PAGE_COUNT}`)).toBeInTheDocument();
    });

    it("stops refusing an insertion once the note has loaded", async () => {
      mockSidecar({
        ...emptyAnnotations(),
        highlights: [fakeHighlight({ page: 3, text: "引用する本文" })],
      });
      let finishLoad: (notes: {
        content: string;
        modifiedAtMs: null;
      }) => void = () => {};
      vi.mocked(loadNotes).mockReturnValue(
        new Promise((resolve) => {
          finishLoad = resolve;
        }),
      );
      const { user } = renderViewer();
      await user.click(screen.getByRole("button", { name: "ハイライト" }));
      await screen.findAllByRole("listitem");

      await user.click(screen.getByRole("button", { name: "メモに挿入" }));
      expect(
        screen.getByText(/メモをまだ読み込めていないため/),
      ).toBeInTheDocument();

      // The load lands: the complaint no longer applies and must clear itself,
      // without the reader having to try the insertion again.
      await act(async () => {
        finishLoad({ content: "", modifiedAtMs: null });
      });

      await waitFor(() =>
        expect(screen.queryByText(/メモをまだ読み込めていないため/)).toBeNull(),
      );
    });

    it("closes the panel on a second press", async () => {
      const { user, editor } = await openNotes();
      expect(editor).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "メモ" }));

      expect(
        screen.queryByRole("textbox", { name: "メモ (markdown)" }),
      ).toBeNull();
    });

    describe("章立て自動挿入・カーソル追従 (issue #46)", () => {
      const notesOutline: OutlineNode[] = [
        { title: "序章", pageNumber: 1, children: [] },
        {
          title: "本論",
          pageNumber: 3,
          children: [{ title: "後半", pageNumber: 6, children: [] }],
        },
        { title: "付録", pageNumber: null, children: [] },
      ];

      it("inserts the outline as markdown headings into an empty note", async () => {
        vi.mocked(loadNotes).mockResolvedValue({
          content: "",
          modifiedAtMs: 7,
        });
        const { user } = renderViewer(PAGE_COUNT, notesOutline);
        await user.click(screen.getByRole("button", { name: "メモ" }));
        const editor = await screen.findByRole("textbox", {
          name: "メモ (markdown)",
        });

        await waitFor(() =>
          expect(editor).toHaveValue("# 序章\n\n# 本論\n\n## 後半\n\n# 付録\n"),
        );
        // A default insertion is not the reader editing: it must not autosave.
        expect(saveNotes).not.toHaveBeenCalled();
      });

      it("leaves a note that already has content untouched", async () => {
        vi.mocked(loadNotes).mockResolvedValue({
          content: "既存のメモ",
          modifiedAtMs: 7,
        });
        const { user } = renderViewer(PAGE_COUNT, notesOutline);
        await user.click(screen.getByRole("button", { name: "メモ" }));
        const editor = await screen.findByRole("textbox", {
          name: "メモ (markdown)",
        });

        await waitFor(() => expect(editor).toHaveValue("既存のメモ"));
      });

      it("inserts nothing when the setting is off", async () => {
        vi.mocked(loadNotes).mockResolvedValue({
          content: "",
          modifiedAtMs: 7,
        });
        const { user } = renderViewer(PAGE_COUNT, notesOutline, {
          notesOutlineInsert: false,
        });
        await user.click(screen.getByRole("button", { name: "メモ" }));
        const editor = await screen.findByRole("textbox", {
          name: "メモ (markdown)",
        });

        await waitFor(() => expect(editor).toBeEnabled());
        expect(editor).toHaveValue("");
      });

      it("moves the notes cursor to the current section's heading as the reader turns pages", async () => {
        vi.mocked(loadNotes).mockResolvedValue({
          content: "",
          modifiedAtMs: 7,
        });
        const { user } = renderViewer(PAGE_COUNT, notesOutline);
        await user.click(screen.getByRole("button", { name: "メモ" }));
        const editor = (await screen.findByRole("textbox", {
          name: "メモ (markdown)",
        })) as HTMLTextAreaElement;
        await waitFor(() =>
          expect(editor).toHaveValue("# 序章\n\n# 本論\n\n## 後半\n\n# 付録\n"),
        );

        await user.click(screen.getByRole("button", { name: "目次" }));
        await user.click(screen.getByRole("button", { name: "本論3" }));

        await waitFor(() => {
          const expected = editor.value.indexOf("# 本論");
          expect(editor.selectionStart).toBe(expected);
        });
      });
      it("follows to a section whose title has a line break, matching how it was written as a heading", async () => {
        // A bookmark title straight from a PDF's outline dictionary can carry
        // a line break; `formatOutlineHeadings` collapses it to a space when
        // writing the heading, so the cursor-follow lookup must use the same
        // normalization or it will never find the line again.
        const wrapped: OutlineNode[] = [
          { title: "序章\n導入編", pageNumber: 1, children: [] },
        ];
        vi.mocked(loadNotes).mockResolvedValue({
          content: "",
          modifiedAtMs: 7,
        });
        const { user } = renderViewer(PAGE_COUNT, wrapped);
        await user.click(screen.getByRole("button", { name: "メモ" }));
        const editor = (await screen.findByRole("textbox", {
          name: "メモ (markdown)",
        })) as HTMLTextAreaElement;

        await waitFor(() => expect(editor).toHaveValue("# 序章 導入編\n"));
        await waitFor(() => expect(editor.selectionStart).toBe(0));
      });

      it("follows to a section with no title, matching the placeholder used in the heading", async () => {
        const blank: OutlineNode[] = [
          { title: "   ", pageNumber: 1, children: [] },
        ];
        vi.mocked(loadNotes).mockResolvedValue({
          content: "",
          modifiedAtMs: 7,
        });
        const { user } = renderViewer(PAGE_COUNT, blank);
        await user.click(screen.getByRole("button", { name: "メモ" }));
        const editor = (await screen.findByRole("textbox", {
          name: "メモ (markdown)",
        })) as HTMLTextAreaElement;

        await waitFor(() => expect(editor).toHaveValue("# （無題）\n"));
        await waitFor(() => expect(editor.selectionStart).toBe(0));
      });

      // Whether the follow effect actually leaves the caret alone while the
      // reader is mid-edit is covered directly in NotesPanel.test.tsx, where
      // the focus/blur state can be driven without going through page
      // navigation. Here it is enough that PdfViewer wires `followHeading`
      // through at all, which the test above already exercises.
    });
  });

  describe("translation", () => {
    /** Selects `selected` on page 1, with the rest of the line around it. */
    function selectOnPage(before: string, selected: string, after: string) {
      const viewer = renderViewer();
      const page = document.querySelector<HTMLElement>(
        '.scroller .page[data-page="1"]',
      );
      if (!page) throw new Error("page 1 is not rendered");
      page.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 100, height: 140 }) as DOMRect;
      const textLayer = page.querySelector(".textLayer");
      if (!textLayer) throw new Error("page 1 has no text layer");
      const spans = [before, selected, after].map((text) => {
        const span = document.createElement("span");
        span.textContent = text;
        textLayer.append(span);
        return span;
      });

      // jsdom lays nothing out; every range reports the same single rect.
      Range.prototype.getClientRects = () =>
        [{ left: 10, top: 28, width: 50, height: 3 }] as unknown as DOMRectList;

      const range = document.createRange();
      range.setStart(spans[1].firstChild as Node, 0);
      range.setEnd(spans[1].firstChild as Node, selected.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);

      pointerGesture(page, { x: 20, y: 30 }, { x: 20, y: 30 });
      return viewer;
    }

    function translated(text: string) {
      return {
        text,
        provider: "claude" as const,
        model: "claude-opus-5",
        targetLanguage: "ja",
      };
    }

    it("sends the selection with the page text around it", async () => {
      vi.mocked(translate).mockResolvedValue(
        translated("必要なのは注意だけ。"),
      );
      const { user } = selectOnPage(
        "In this work, ",
        "attention is all you need",
        ". We show that",
      );

      await user.click(screen.getByRole("button", { name: "翻訳" }));

      expect(
        await screen.findByText("必要なのは注意だけ。"),
      ).toBeInTheDocument();
      expect(translate).toHaveBeenCalledWith({
        text: "attention is all you need",
        contextBefore: "In this work, ",
        contextAfter: ". We show that",
      });
    });

    it("keeps the reader informed while the request is in flight", async () => {
      vi.mocked(translate).mockReturnValue(new Promise(() => {}));
      const { user } = selectOnPage("", "selected text", "");

      await user.click(screen.getByRole("button", { name: "翻訳" }));

      expect(screen.getByText("翻訳しています…")).toBeInTheDocument();
      // The popup it was started from is gone: the panel replaces it.
      expect(
        screen.queryByRole("toolbar", { name: "選択したテキスト" }),
      ).toBeNull();
    });

    it("puts the original and the translation into the note", async () => {
      vi.mocked(translate).mockResolvedValue(
        translated("必要なのは注意だけ。"),
      );
      const { user } = selectOnPage("", "Attention is all you need.", "");
      await user.click(screen.getByRole("button", { name: "翻訳" }));
      await screen.findByText("必要なのは注意だけ。");

      await user.click(screen.getByRole("button", { name: "メモに挿入" }));

      const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
        name: "メモ (markdown)",
      });
      await waitFor(() =>
        expect(editor.value).toContain("> Attention is all you need."),
      );
      expect(editor.value).toContain("> — p.1");
      expect(editor.value).toContain(
        "**訳（日本語）**\n\n必要なのは注意だけ。",
      );
    });

    it("explains a failure and runs the same request again on request", async () => {
      vi.mocked(translate)
        .mockRejectedValueOnce({ kind: "unavailable", status: 503 })
        .mockResolvedValueOnce(translated("再試行の訳"));
      const { user } = selectOnPage("", "selected text", "");

      await user.click(screen.getByRole("button", { name: "翻訳" }));
      expect(await screen.findByText(/HTTP 503/)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "再試行" }));

      expect(await screen.findByText("再試行の訳")).toBeInTheDocument();
      expect(vi.mocked(translate).mock.calls[1][0].text).toBe("selected text");
    });

    it("translates a saved highlight from its own popup", async () => {
      vi.mocked(translate).mockResolvedValue(translated("ハイライトの訳"));
      mockSidecar({
        ...emptyAnnotations(),
        highlights: [fakeHighlight({ page: 1, text: "保存済みの本文" })],
      });
      const { user } = renderViewer();
      const page = document.querySelector<HTMLElement>(
        '.scroller .page[data-page="1"]',
      );
      if (!page) throw new Error("page 1 is not rendered");
      page.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 100, height: 140 }) as DOMRect;
      await waitFor(() =>
        expect(document.querySelector(".page__highlight")).not.toBeNull(),
      );

      // Inside the highlight's rect (x .1–.6, y .2–.22 of a 100x140 page).
      pointerGesture(page, { x: 20, y: 30 }, { x: 20, y: 30 });
      await user.click(screen.getByRole("button", { name: "翻訳" }));

      expect(await screen.findByText("ハイライトの訳")).toBeInTheDocument();
      // A stored extract has no page around it any more: only the text goes.
      expect(translate).toHaveBeenCalledWith({
        text: "保存済みの本文",
        contextBefore: "",
        contextAfter: "",
      });
    });

    it("closes the panel when the reader is done with it", async () => {
      vi.mocked(translate).mockResolvedValue(
        translated("必要なのは注意だけ。"),
      );
      const { user } = selectOnPage("", "selected text", "");
      await user.click(screen.getByRole("button", { name: "翻訳" }));
      await screen.findByText("必要なのは注意だけ。");

      await user.click(screen.getByRole("button", { name: "翻訳を閉じる" }));

      expect(screen.queryByRole("dialog", { name: "翻訳" })).toBeNull();
    });
  });
});
