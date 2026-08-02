import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewScale } from "../pdf/canvas-scale";
import type { PdfDocumentHandle } from "../pdf";
import { clearStart, markStart } from "../perf/marks";
import { PageCanvas } from "./PageCanvas";
import { PageRenderCache } from "./page-cache";
import { RenderQueue } from "./render-queue";

vi.mock("../perf/marks", async (importActual) => {
  const actual = await importActual<typeof import("../perf/marks")>();
  return {
    ...actual,
    markStart: vi.fn(actual.markStart),
    markEnd: vi.fn(actual.markEnd),
    clearStart: vi.fn(actual.clearStart),
  };
});

/** A page size large enough that its full render exceeds the preview's pixel
 * budget (`PREVIEW_MAX_PIXELS`), so `previewScale` returns a real scale
 * rather than `null` — the two-stage path only ever runs for a page this
 * large (or larger). */
const LARGE_WIDTH = 3000;
const LARGE_HEIGHT = 3000;
/** `fakeDoc`'s usual page size (matches `PdfViewer.test.tsx`'s fixture): far
 * under the preview budget, so `previewScale` returns `null` here — this
 * shape must stay on the single-stage path. */
const SMALL_WIDTH = 100;
const SMALL_HEIGHT = 140;

function fakeDoc(): PdfDocumentHandle {
  return {
    pageCount: 1,
    getPageSize: vi.fn(async () => ({ width: 100, height: 140 })),
    renderPage: vi.fn(async () => {}),
    renderRegion: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])])),
    renderTextLayer: vi.fn(async () => {}),
    getOutline: vi.fn(async () => []),
    destroy: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  // Pin this explicitly rather than trust jsdom's default — the two-stage
  // decision (`previewScale`) depends on it, so a test asserting on which
  // path ran must not be at the mercy of jsdom's own default.
  Object.defineProperty(window, "devicePixelRatio", {
    value: 1,
    configurable: true,
  });
  vi.mocked(markStart).mockClear();
  vi.mocked(clearStart).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function surfaceHost(container: HTMLElement): HTMLElement {
  const host = container.querySelector(".page__surface");
  if (!host) throw new Error("page__surface is not rendered");
  return host as HTMLElement;
}

describe("PageCanvas", () => {
  it("renders a low-resolution preview ahead of the full-resolution render, then swaps it in", async () => {
    const doc = fakeDoc();
    const cache = new PageRenderCache();
    const queue = new RenderQueue();
    const scale = 2;
    const expectedPreviewScale = previewScale(
      scale,
      LARGE_WIDTH,
      LARGE_HEIGHT,
      1,
    );
    expect(expectedPreviewScale).not.toBeNull();

    render(
      <PageCanvas
        doc={doc}
        cache={cache}
        pageNumber={1}
        scale={scale}
        width={LARGE_WIDTH}
        height={LARGE_HEIGHT}
        queue={queue}
        priority="visible"
      />,
    );

    await waitFor(() =>
      expect(vi.mocked(doc.renderPage).mock.calls.length).toBe(2),
    );

    const calls = vi.mocked(doc.renderPage).mock.calls;
    // The preview (ranked above "visible" in the queue) always dequeues —
    // and therefore starts — first.
    expect(calls[0][0]).toBe(1);
    expect(calls[0][1].scale).toBe(expectedPreviewScale);
    expect(calls[1][0]).toBe(1);
    expect(calls[1][1].scale).toBe(scale);
  });

  it("caches only the full-resolution render, never the preview", async () => {
    const doc = fakeDoc();
    const cache = new PageRenderCache();
    const queue = new RenderQueue();
    const setSpy = vi.spyOn(cache, "set");
    const scale = 2;

    render(
      <PageCanvas
        doc={doc}
        cache={cache}
        pageNumber={1}
        scale={scale}
        width={LARGE_WIDTH}
        height={LARGE_HEIGHT}
        queue={queue}
        priority="visible"
      />,
    );

    await waitFor(() =>
      expect(vi.mocked(doc.renderPage).mock.calls.length).toBe(2),
    );
    await waitFor(() => expect(setSpy).toHaveBeenCalledTimes(1));

    // Only the full scale was ever handed to `set` — no entry for the
    // preview's (smaller) scale exists at all.
    expect(setSpy).toHaveBeenCalledWith(1, scale, expect.anything());
    expect(cache.get(1, scale)).toBeDefined();
    const pScale = previewScale(scale, LARGE_WIDTH, LARGE_HEIGHT, 1);
    if (pScale !== null) {
      expect(cache.get(1, pScale)).toBeUndefined();
    }
  });

  it("clears the preview's perf mark instead of leaving it unmeasured when the preview render fails", async () => {
    const doc = fakeDoc();
    let call = 0;
    vi.mocked(doc.renderPage).mockImplementation(async () => {
      call += 1;
      // The preview is always the first call to reach the renderer (it
      // outranks the full render in the queue) — failing it, specifically,
      // is what this test needs; the full render below must still succeed
      // so nothing here depends on the (unrelated) full-render error path.
      if (call === 1) throw new Error("preview render failed");
    });
    const cache = new PageRenderCache();
    const queue = new RenderQueue();

    render(
      <PageCanvas
        doc={doc}
        cache={cache}
        pageNumber={1}
        scale={2}
        width={LARGE_WIDTH}
        height={LARGE_HEIGHT}
        queue={queue}
        priority="visible"
      />,
    );

    await waitFor(() =>
      expect(vi.mocked(clearStart)).toHaveBeenCalledWith(
        "viewer:preview-shown:1",
      ),
    );
    // The full render's own mark was never touched by the preview's failure.
    expect(vi.mocked(clearStart)).not.toHaveBeenCalledWith(
      "viewer:full-shown:1",
    );
  });

  it("clears the preview's perf mark and does not crash when the renderer throws synchronously", async () => {
    // A plain (non-`async`) function, unlike the other tests' `fakeDoc` and
    // its `async () => {}` mocks: throwing from inside one of those produces
    // a *rejected promise*, which already reaches `.catch` without this
    // fix. Only a genuinely synchronous throw — before any promise is ever
    // returned — exercises the `Promise.resolve().then(...)` wrapper this
    // regression test guards.
    const doc = fakeDoc();
    let call = 0;
    vi.mocked(doc.renderPage).mockImplementation((): Promise<void> => {
      call += 1;
      if (call === 1) {
        throw new Error("preview renderer threw synchronously");
      }
      return Promise.resolve();
    });
    const cache = new PageRenderCache();
    const queue = new RenderQueue();

    expect(() =>
      render(
        <PageCanvas
          doc={doc}
          cache={cache}
          pageNumber={1}
          scale={2}
          width={LARGE_WIDTH}
          height={LARGE_HEIGHT}
          queue={queue}
          priority="visible"
        />,
      ),
    ).not.toThrow();

    await waitFor(() =>
      expect(vi.mocked(clearStart)).toHaveBeenCalledWith(
        "viewer:preview-shown:1",
      ),
    );
  });

  it("replaces the mounted canvas with the full-resolution one once it completes", async () => {
    const doc = fakeDoc();
    const fullCanvas = { current: null as HTMLCanvasElement | null };
    let call = 0;
    vi.mocked(doc.renderPage).mockImplementation(async (_page, options) => {
      call += 1;
      if (call === 2) fullCanvas.current = options.canvas;
    });
    const cache = new PageRenderCache();
    const queue = new RenderQueue();

    const { container } = render(
      <PageCanvas
        doc={doc}
        cache={cache}
        pageNumber={1}
        scale={2}
        width={LARGE_WIDTH}
        height={LARGE_HEIGHT}
        queue={queue}
        priority="visible"
      />,
    );

    await waitFor(() => expect(fullCanvas.current).not.toBeNull());
    await waitFor(() => {
      const host = surfaceHost(container);
      expect(host.children).toHaveLength(1);
      expect(host.firstElementChild).toBe(fullCanvas.current);
    });
  });

  it("skips the preview stage for a page whose full render already fits the preview budget", async () => {
    const doc = fakeDoc();
    const cache = new PageRenderCache();
    const queue = new RenderQueue();
    expect(previewScale(1, SMALL_WIDTH, SMALL_HEIGHT, 1)).toBeNull();

    render(
      <PageCanvas
        doc={doc}
        cache={cache}
        pageNumber={1}
        scale={1}
        width={SMALL_WIDTH}
        height={SMALL_HEIGHT}
        queue={queue}
        priority="visible"
      />,
    );

    await waitFor(() => expect(doc.renderPage).toHaveBeenCalledTimes(1));
    expect(vi.mocked(doc.renderPage).mock.calls[0][1].scale).toBe(1);

    // Give any (wrongly) scheduled second render a chance to show up.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(doc.renderPage).toHaveBeenCalledTimes(1);
  });

  it("stays single-stage for a non-visible priority even on a large page", async () => {
    const doc = fakeDoc();
    const cache = new PageRenderCache();
    const queue = new RenderQueue();
    const scale = 2;

    render(
      <PageCanvas
        doc={doc}
        cache={cache}
        pageNumber={1}
        scale={scale}
        width={LARGE_WIDTH}
        height={LARGE_HEIGHT}
        queue={queue}
        priority="overscan"
      />,
    );

    await waitFor(() => expect(doc.renderPage).toHaveBeenCalledTimes(1));
    expect(vi.mocked(doc.renderPage).mock.calls[0][1].scale).toBe(scale);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(doc.renderPage).toHaveBeenCalledTimes(1);
  });

  it("does not throw when unmounted mid-render", async () => {
    const doc = fakeDoc();
    // Never resolves — models the render still being in flight at unmount.
    vi.mocked(doc.renderPage).mockImplementation(() => new Promise(() => {}));
    const cache = new PageRenderCache();
    const queue = new RenderQueue();

    const { unmount } = render(
      <PageCanvas
        doc={doc}
        cache={cache}
        pageNumber={1}
        scale={2}
        width={LARGE_WIDTH}
        height={LARGE_HEIGHT}
        queue={queue}
        priority="visible"
      />,
    );

    await waitFor(() => expect(doc.renderPage).toHaveBeenCalled());
    expect(() => unmount()).not.toThrow();
  });
});
