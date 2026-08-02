import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import {
  RECENT_FILES_STORAGE_KEY,
  parseRecentFiles,
  type RecentFile,
} from "./files/recent";
import type { PdfDocumentHandle, PdfRenderer } from "./pdf";
import { defaultSettings } from "./settings/settings";

const openDialog = vi.hoisted(() => vi.fn());
const exists = vi.hoisted(() => vi.fn());
const readFile = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());
const loadDefaultRenderer = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog }));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists, readFile }));
// The settings (issue #9) are read at startup, over the same IPC as everything
// else the backend owns.
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
// Only the renderer is swapped for a fake one: `loadPageSizesProgressive`
// itself stays real, so the progressive-open test below exercises the actual
// chunking/background behaviour rather than a mock of it.
vi.mock("./pdf", async (importActual) => {
  const actual = await importActual<typeof import("./pdf")>();
  return { ...actual, loadDefaultRenderer };
});
// The real PdfViewer pulls in annotations/notes/translation, each backed by
// more Tauri IPC than this file mocks. A tiny stub that only surfaces the
// props App actually computes (`pageSizes`, `onClose`) keeps these tests
// about App's own responsibility — feeding the viewer a progressively
// growing pageSizes array — without re-mocking half the app to mount it.
vi.mock("./viewer/PdfViewer", () => ({
  PdfViewer: ({
    pageSizes,
    onClose,
  }: {
    pageSizes: readonly unknown[];
    onClose: () => void;
  }) => (
    <div role="region" aria-label="PDFページ">
      <span>page-sizes-count:{pageSizes.length}</span>
      <button type="button" onClick={onClose}>
        ← ライブラリ
      </button>
    </div>
  ),
}));

/**
 * A `PdfDocumentHandle` whose `getPageSize` calls are all observable, for
 * asserting on progressive-open behaviour (issue #12). Pages past
 * `delayAfter` resolve on a macrotask instead of immediately, so the
 * background continuation is still observably in flight right after the
 * viewer first appears — real page reads take nonzero time; this fake's
 * default (everything resolving on the same microtask) would otherwise let
 * the whole 40-page document finish before the test gets to look.
 */
function fakePdfDocument(
  pageCount: number,
  { delayAfter = 0 }: { delayAfter?: number } = {},
): {
  doc: PdfDocumentHandle;
  getPageSizeCalls: number[];
} {
  const getPageSizeCalls: number[] = [];
  const doc: PdfDocumentHandle = {
    pageCount,
    getPageSize: vi.fn((pageNumber: number) => {
      getPageSizeCalls.push(pageNumber);
      const size = { width: 600, height: 800 };
      return pageNumber > delayAfter
        ? new Promise<typeof size>((resolve) =>
            setTimeout(() => resolve(size), 5),
          )
        : Promise.resolve(size);
    }),
    renderPage: vi.fn(async () => {}),
    renderRegion: vi.fn(async () => new Blob()),
    renderTextLayer: vi.fn(async () => {}),
    getOutline: vi.fn(async () => []),
    destroy: vi.fn(async () => {}),
  };
  return { doc, getPageSizeCalls };
}

function seedRecentFiles(files: RecentFile[]) {
  window.localStorage.setItem(RECENT_FILES_STORAGE_KEY, JSON.stringify(files));
}

/**
 * Renders the app and lets the settings read at startup settle, so no state
 * update lands after the test has finished.
 */
async function renderApp() {
  await act(async () => {
    render(<App />);
  });
}

function storedRecentFiles(): RecentFile[] {
  return parseRecentFiles(
    window.localStorage.getItem(RECENT_FILES_STORAGE_KEY),
  );
}

describe("App start screen", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    invoke.mockImplementation((command: string) =>
      command === "api_key_status"
        ? Promise.resolve([])
        : Promise.resolve(defaultSettings()),
    );
  });

  describe("opening a document (issue #12 progressive page sizes)", () => {
    it("shows the viewer once the first chunk of page sizes is ready, and keeps reading the rest in the background", async () => {
      const user = userEvent.setup();
      seedRecentFiles([
        { path: "/Papers/large.pdf", name: "large.pdf", openedAt: 1 },
      ]);
      exists.mockResolvedValue(true);
      readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
      const { doc, getPageSizeCalls } = fakePdfDocument(40, { delayAfter: 32 });
      const renderer: PdfRenderer = {
        id: "fake",
        open: vi.fn(async () => doc),
      };
      loadDefaultRenderer.mockResolvedValue(renderer);

      await renderApp();
      await user.click(
        screen.getByRole("button", { name: "large.pdf を開く" }),
      );

      // openPath only awaits the first chunk (32 pages): the viewer must be
      // showing — with exactly those 32 sizes — before the other 8 pages
      // (delayed on purpose) have reported back.
      await waitFor(() => {
        expect(screen.getByText("page-sizes-count:32")).toBeInTheDocument();
      });

      // The background continuation keeps going after the viewer is already
      // up, reaching every page without the reader waiting on it.
      await waitFor(() => {
        expect(screen.getByText("page-sizes-count:40")).toBeInTheDocument();
      });
      expect(new Set(getPageSizeCalls).size).toBe(40);
    });

    it("aborts the background page-size load when the document is closed", async () => {
      const user = userEvent.setup();
      seedRecentFiles([
        { path: "/Papers/large.pdf", name: "large.pdf", openedAt: 1 },
      ]);
      exists.mockResolvedValue(true);
      readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
      // Every page (including the first chunk) resolves on a real timer, so
      // the chunk already kicked off in the background when the reader
      // closes the document is still genuinely in flight — not finished and
      // not yet even started on the chunk after it.
      const { doc, getPageSizeCalls } = fakePdfDocument(200);
      const renderer: PdfRenderer = {
        id: "fake",
        open: vi.fn(async () => doc),
      };
      loadDefaultRenderer.mockResolvedValue(renderer);

      await renderApp();
      await user.click(
        screen.getByRole("button", { name: "large.pdf を開く" }),
      );
      await waitFor(() => {
        expect(screen.getByText("page-sizes-count:32")).toBeInTheDocument();
      });

      await act(async () => {
        await user.click(screen.getByRole("button", { name: "← ライブラリ" }));
      });
      const countRightAfterClose = getPageSizeCalls.length;
      expect(countRightAfterClose).toBeLessThan(200);

      // Give the in-flight chunk's timers time to fire, then confirm the
      // abort kept the background loop from starting a further chunk.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(getPageSizeCalls).toHaveLength(countRightAfterClose);
    });
  });

  it("renders the Papyrus heading and tagline", async () => {
    await renderApp();

    expect(
      screen.getByRole("heading", { level: 1, name: "Papyrus" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("PDF viewer, built with Tauri + React."),
    ).toBeInTheDocument();
  });

  it("says the recent list is empty when nothing has been opened", async () => {
    await renderApp();

    expect(screen.getByText("まだありません。")).toBeInTheDocument();
  });

  it("lists the recent files stored from a previous session", async () => {
    seedRecentFiles([
      { path: "/Papers/attention.pdf", name: "attention.pdf", openedAt: 1 },
      { path: "/Papers/bert.pdf", name: "bert.pdf", openedAt: 2 },
    ]);

    await renderApp();

    expect(screen.getByText("attention.pdf")).toBeInTheDocument();
    expect(screen.getByText("bert.pdf")).toBeInTheDocument();
  });

  it("removes a recent file from the list and from storage", async () => {
    const user = userEvent.setup();
    seedRecentFiles([
      { path: "/Papers/attention.pdf", name: "attention.pdf", openedAt: 1 },
      { path: "/Papers/bert.pdf", name: "bert.pdf", openedAt: 2 },
    ]);

    await renderApp();
    await user.click(
      screen.getByRole("button", { name: "attention.pdf を一覧から削除" }),
    );

    expect(screen.queryByText("attention.pdf")).not.toBeInTheDocument();
    expect(storedRecentFiles().map((f) => f.path)).toEqual([
      "/Papers/bert.pdf",
    ]);
  });

  it("does nothing when the file picker is cancelled", async () => {
    const user = userEvent.setup();
    openDialog.mockResolvedValue(null);

    await renderApp();
    await user.click(screen.getByRole("button", { name: "PDFを開く" }));

    expect(readFile).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports a missing file and drops it from the recent list", async () => {
    const user = userEvent.setup();
    seedRecentFiles([
      { path: "/Papers/gone.pdf", name: "gone.pdf", openedAt: 1 },
    ]);
    exists.mockResolvedValue(false);

    await renderApp();
    await user.click(screen.getByRole("button", { name: "gone.pdf を開く" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "ファイルが見つかりません: /Papers/gone.pdf",
      );
    });
    expect(readFile).not.toHaveBeenCalled();
    expect(storedRecentFiles()).toEqual([]);
  });

  it("opens the settings from the start screen and closes them again", async () => {
    const user = userEvent.setup();

    await renderApp();
    await user.click(screen.getByRole("button", { name: "設定" }));

    const dialog = await screen.findByRole("dialog", { name: "設定" });
    expect(invoke).toHaveBeenCalledWith("load_settings", undefined);

    await user.click(screen.getByRole("button", { name: "設定を閉じる" }));
    expect(dialog).not.toBeInTheDocument();
  });
});
