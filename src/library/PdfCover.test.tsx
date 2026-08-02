import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RECENT_FILES } from "../files/recent";
import { PdfCover } from "./PdfCover";

const readPdfFile = vi.hoisted(() => vi.fn());
const loadDefaultRenderer = vi.hoisted(() => vi.fn());

vi.mock("../files/open", () => ({ readPdfFile }));
// Only the renderer is faked: the cover cache is a real `LruCache`, so the
// eviction this file asserts on is the one the component actually gets.
vi.mock("../pdf", async (importActual) => {
  const actual = await importActual<typeof import("../pdf")>();
  return { ...actual, loadDefaultRenderer };
});

function fakeDoc(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    pageCount: 1,
    getPageSize: vi.fn().mockResolvedValue({ width: 100, height: 140 }),
    renderPage: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  readPdfFile.mockReset();
  loadDefaultRenderer.mockReset();
  // jsdom has no real canvas backend; without this every render logs a noisy
  // "not implemented" error even though the component handles the call fine.
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/png;base64,stub",
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PdfCover", () => {
  it("renders the first page as an image once the render resolves", async () => {
    readPdfFile.mockResolvedValue(new Uint8Array([1]));
    const doc = fakeDoc();
    loadDefaultRenderer.mockResolvedValue({ open: async () => doc });

    render(<PdfCover path="/a/report-ready.pdf" name="report.pdf" />);

    await waitFor(() => {
      expect(document.querySelector("img.cover__image")).not.toBeNull();
    });
    expect(doc.renderPage).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ scale: expect.any(Number) }),
    );
    expect(doc.destroy).toHaveBeenCalled();
  });

  it("falls back to a placeholder with the file's initial when the file cannot be read", async () => {
    readPdfFile.mockRejectedValue(new Error("missing"));

    render(<PdfCover path="/a/report-missing.pdf" name="report.pdf" />);

    // Waited on the placeholder rather than on the image being absent: the
    // image is absent on the first render too, so that would pass before the
    // read has even been attempted.
    await waitFor(() => {
      expect(screen.getByText("R")).toBeInTheDocument();
    });
    expect(document.querySelector("img.cover__image")).toBeNull();
  });

  it("destroys the document even when rendering the page fails", async () => {
    readPdfFile.mockResolvedValue(new Uint8Array([1]));
    const doc = fakeDoc({
      renderPage: vi.fn().mockRejectedValue(new Error("render failed")),
    });
    loadDefaultRenderer.mockResolvedValue({ open: async () => doc });

    render(<PdfCover path="/a/report-render-fails.pdf" name="report.pdf" />);

    await waitFor(() => {
      expect(doc.destroy).toHaveBeenCalled();
    });
  });

  it("opens one document at a time when several covers mount together", async () => {
    const reads: string[] = [];
    let releaseFirstRead = () => {};
    const firstRead = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    readPdfFile.mockImplementation(async (path: string) => {
      reads.push(path);
      if (reads.length === 1) await firstRead;
      return new Uint8Array([1]);
    });
    loadDefaultRenderer.mockResolvedValue({ open: async () => fakeDoc() });

    render(
      <>
        <PdfCover path="/a/queued-one.pdf" name="one.pdf" />
        <PdfCover path="/a/queued-two.pdf" name="two.pdf" />
      </>,
    );

    await waitFor(() => expect(reads).toEqual(["/a/queued-one.pdf"]));
    releaseFirstRead();
    await waitFor(() =>
      expect(reads).toEqual(["/a/queued-one.pdf", "/a/queued-two.pdf"]),
    );
  });

  it("re-reads a cover only once it has been pushed out of the cache", async () => {
    readPdfFile.mockResolvedValue(new Uint8Array([1]));
    loadDefaultRenderer.mockResolvedValue({ open: async () => fakeDoc() });

    const readsOf = (path: string) =>
      readPdfFile.mock.calls.filter(([read]) => read === path).length;

    /** Mounts a cover, waits for it to paint, then takes it back down. */
    const paint = async (path: string) => {
      const view = render(<PdfCover path={path} name="doc.pdf" />);
      await waitFor(() =>
        expect(document.querySelector("img.cover__image")).not.toBeNull(),
      );
      view.unmount();
    };

    await paint("/lru/first.pdf");
    expect(readsOf("/lru/first.pdf")).toBe(1);

    // Still cached, so showing it again costs no read at all.
    await paint("/lru/first.pdf");
    expect(readsOf("/lru/first.pdf")).toBe(1);

    // A full library's worth of other covers is enough to push it out.
    for (let index = 0; index < MAX_RECENT_FILES; index += 1) {
      await paint(`/lru/filler-${index}.pdf`);
    }

    await paint("/lru/first.pdf");
    expect(readsOf("/lru/first.pdf")).toBe(2);
  });
});
