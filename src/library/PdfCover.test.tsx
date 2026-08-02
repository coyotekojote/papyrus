import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PdfCover } from "./PdfCover";

const readPdfFile = vi.hoisted(() => vi.fn());
const loadDefaultRenderer = vi.hoisted(() => vi.fn());

vi.mock("../files/open", () => ({ readPdfFile }));
vi.mock("../pdf", () => ({ loadDefaultRenderer }));

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

    await waitFor(() => {
      expect(document.querySelector("img.cover__image")).toBeNull();
    });
    expect(screen.getByText("R")).toBeInTheDocument();
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
});
