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
  saveNotes,
  type Annotations,
  type Highlight,
} from "../files/sidecar";
import type { OutlineNode, PageSize, PdfDocumentHandle } from "../pdf";
import { PdfViewer } from "./PdfViewer";

vi.mock("../files/sidecar", async (importActual) => {
  const actual = await importActual<typeof import("../files/sidecar")>();
  return {
    ...actual,
    loadAnnotations: vi.fn(),
    saveAnnotations: vi.fn(),
    loadNotes: vi.fn(),
    saveNotes: vi.fn(),
  };
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
}

beforeEach(() => {
  vi.mocked(loadAnnotations).mockReset();
  vi.mocked(saveAnnotations).mockReset();
  vi.mocked(loadNotes).mockReset();
  vi.mocked(saveNotes).mockReset();
  mockSidecar();
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

/** Lets the rAF-throttled scroll handler run. */
async function flushScroll() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

function renderViewer(pageCount = PAGE_COUNT, outline: OutlineNode[] = []) {
  const doc = fakeDoc(pageCount, outline);
  const onClose = vi.fn();
  render(
    <PdfViewer
      doc={doc}
      pageSizes={pageSizes(pageCount)}
      filePath="/papers/paper.pdf"
      fileName="paper.pdf"
      onClose={onClose}
    />,
  );
  return { doc, onClose, user: userEvent.setup() };
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

  it("renders the pages it shows via the injected renderer", () => {
    const { doc } = renderViewer();

    expect(doc.renderPage).toHaveBeenCalled();
    expect(vi.mocked(doc.renderPage).mock.calls[0][0]).toBe(1);
  });

  it("advances with the right arrow in a left-bound book", async () => {
    const { user } = renderViewer();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByText(`2 / ${PAGE_COUNT}`)).toBeInTheDocument();

    await user.keyboard("{ArrowLeft}");
    expect(screen.getByText(`1 / ${PAGE_COUNT}`)).toBeInTheDocument();
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

  it("re-renders a page after a zoom change instead of reusing the cache", async () => {
    const { doc, user } = renderViewer();
    const before = vi.mocked(doc.renderPage).mock.calls.length;

    await user.click(screen.getByRole("button", { name: "拡大" }));

    expect(vi.mocked(doc.renderPage).mock.calls.length).toBeGreaterThan(before);
    const lastCall = vi.mocked(doc.renderPage).mock.calls.at(-1);
    expect(lastCall?.[1].scale).toBe(1.25);
  });

  it("closes the document from the toolbar", async () => {
    const { onClose, user } = renderViewer();

    await user.click(screen.getByRole("button", { name: "← ライブラリ" }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  describe("wheel scrolling", () => {
    const scrollBy = vi.spyOn(Element.prototype, "scrollBy");

    afterEach(() => scrollBy.mockClear());

    it("scrolls forward on a downward wheel in a left-bound book", () => {
      renderViewer();

      fireEvent.wheel(scroller(), { deltaY: 120, deltaX: 0 });

      expect(scrollBy).toHaveBeenCalledWith({ left: 120, behavior: "auto" });
    });

    it("still reads forward on a downward wheel once right-bound", async () => {
      const { user } = renderViewer();
      await user.click(screen.getByRole("button", { name: "左綴じ" }));
      scrollBy.mockClear();

      fireEvent.wheel(scroller(), { deltaY: 120, deltaX: 0 });

      // Right-bound spreads are laid out reversed, so reading on means moving
      // towards a smaller scroll offset.
      expect(scrollBy).toHaveBeenCalledWith({ left: -120, behavior: "auto" });
    });

    it("leaves a horizontal wheel to the browser", () => {
      renderViewer();

      fireEvent.wheel(scroller(), { deltaY: 0, deltaX: 120 });

      expect(scrollBy).not.toHaveBeenCalled();
    });

    it("zooms instead of scrolling when the wheel carries ctrl", () => {
      renderViewer();

      fireEvent.wheel(scroller(), { deltaY: -100, ctrlKey: true });

      expect(scrollBy).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "100%" })).toBeNull();
    });
  });

  it("lets the page indicator recover when a smooth scroll is interrupted", async () => {
    const { user } = renderViewer();

    // Navigate away; jsdom performs no actual scrolling, so the viewer is still
    // sitting at offset 0 with a scroll to spread 2 outstanding.
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText(`2 / ${PAGE_COUNT}`)).toBeInTheDocument();

    // The user grabs the wheel mid-flight, abandoning that scroll.
    fireEvent.wheel(scroller(), { deltaY: 10, deltaX: 0 });
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

    async function openSidebar(pageCount = PAGE_COUNT, nodes = outline) {
      const viewer = renderViewer(pageCount, nodes);
      await viewer.user.click(screen.getByRole("button", { name: "目次" }));
      return viewer;
    }

    it("stays closed until the toolbar button is pressed", () => {
      const { doc } = renderViewer(PAGE_COUNT, outline);

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
      const { user } = await openSidebar();
      await screen.findByRole("list", { name: "目次" });

      await user.click(screen.getByRole("button", { name: /後半/ }));

      expect(screen.getByText(`6 / ${PAGE_COUNT}`)).toBeInTheDocument();
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

      expect(screen.getByRole("button", { name: "序章 1" })).toHaveTextContent(
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

      await user.click(screen.getByRole("button", { name: "（無題） 2" }));
      expect(screen.getByText(`2 / ${PAGE_COUNT}`)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "（無題） を折りたたむ" }),
      ).toBeInTheDocument();
    });

    it("falls back to page thumbnails when the document has no bookmarks", async () => {
      const { user } = await openSidebar(PAGE_COUNT, []);

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

    it("appends the highlight to notes.md as a quote", async () => {
      const { user } = await openPanel({
        ...emptyAnnotations(),
        highlights: [fakeHighlight({ page: 3, text: "引用する本文" })],
      });
      vi.mocked(loadNotes).mockResolvedValue({
        content: "# 既存メモ",
        modifiedAtMs: 7,
      });
      await screen.findAllByRole("listitem");

      await user.click(screen.getByRole("button", { name: "メモに挿入" }));

      await waitFor(() =>
        expect(saveNotes).toHaveBeenCalledWith(
          "/papers/paper.pdf",
          "# 既存メモ\n\n> 引用する本文\n>\n> — p.3\n",
          7,
        ),
      );
    });

    it("closes the panel on a second press", async () => {
      const { user } = await openPanel();
      await screen.findByText(/テキストを選択して色を選ぶ/);

      await user.click(screen.getByRole("button", { name: "ハイライト" }));

      expect(screen.queryByText(/テキストを選択して色を選ぶ/)).toBeNull();
    });
  });
});
