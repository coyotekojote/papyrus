import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A minimal stand-in for pdf.js's own module: just enough surface for
 * `PdfJsRenderer` (issue #12's page-proxy LRU cache) to run against without a
 * real worker, WASM decoders or a genuine PDF. Every `PDFPageProxy` handed
 * out is a distinct, spy-able object, so the cache's identity/eviction
 * behaviour is directly observable.
 */
const getPage = vi.hoisted(() =>
  vi.fn((pageNumber: number) => {
    const page = {
      pageNumber,
      cleanup: vi.fn(() => true),
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 100 * scale,
        height: 200 * scale,
      })),
    };
    return Promise.resolve(page);
  }),
);
const getDocument = vi.hoisted(() =>
  vi.fn((options: { numPages?: number } = {}) => ({
    promise: Promise.resolve({
      numPages: options.numPages ?? 100,
      getPage,
      getOutline: vi.fn(async () => []),
    }),
    destroy: vi.fn(async () => {}),
  })),
);

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  TextLayer: class {},
  getDocument,
}));
vi.mock("./pdf-worker?worker&url", () => ({ default: "worker-url" }));

const { PdfJsRenderer } = await import("./pdfjs-renderer");

/** Every `PDFPageProxy` `getPage` has handed out so far, in call order. */
function issuedPages() {
  return getPage.mock.results.map(
    (result) =>
      result.value as Promise<{
        pageNumber: number;
        cleanup: ReturnType<typeof vi.fn>;
      }>,
  );
}

describe("PdfJsRenderer page proxy cache", () => {
  beforeEach(() => {
    getPage.mockClear();
  });

  it("reuses the same page proxy for repeated reads of the same page", async () => {
    const doc = await new PdfJsRenderer().open(new Uint8Array());

    await doc.getPageSize(5);
    await doc.getPageSize(5);
    await doc.getPageSize(5);

    // One fetch backs all three reads: `getPage` for page 5 was only called
    // once, and every read used the pending/resolved promise already cached.
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(getPage).toHaveBeenCalledWith(5);
  });

  it("fetches a page again after it has been evicted past the cache capacity", async () => {
    const doc = await new PdfJsRenderer().open(new Uint8Array());

    await doc.getPageSize(1);
    // 64 more distinct pages pushes page 1 out of the LRU (capacity 64).
    for (let page = 2; page <= 65; page += 1) {
      await doc.getPageSize(page);
    }
    expect(getPage).toHaveBeenCalledTimes(65);

    const size = await doc.getPageSize(1);

    expect(size).toEqual({ width: 100, height: 200 });
    expect(getPage).toHaveBeenCalledTimes(66);
    expect(getPage.mock.calls.filter((call) => call[0] === 1)).toHaveLength(2);
  });

  it("does not evict a page still within the cache's capacity", async () => {
    const doc = await new PdfJsRenderer().open(new Uint8Array());

    await doc.getPageSize(1);
    // Only 63 more: page 1 is still the 64th-most-recent, within capacity.
    for (let page = 2; page <= 64; page += 1) {
      await doc.getPageSize(page);
    }
    await doc.getPageSize(1);

    expect(getPage.mock.calls.filter((call) => call[0] === 1)).toHaveLength(1);
  });

  it("calls cleanup on a page proxy once it is evicted from the cache", async () => {
    const doc = await new PdfJsRenderer().open(new Uint8Array());

    await doc.getPageSize(1);
    const [firstPage] = await Promise.all(issuedPages());
    for (let page = 2; page <= 65; page += 1) {
      await doc.getPageSize(page);
    }
    // The eviction schedules cleanup as a microtask continuation on the
    // page's own promise; let it run.
    await Promise.resolve();
    await Promise.resolve();

    expect(firstPage.cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not call cleanup on pages still in the cache", async () => {
    const doc = await new PdfJsRenderer().open(new Uint8Array());

    await doc.getPageSize(1);
    const [firstPage] = await Promise.all(issuedPages());
    for (let page = 2; page <= 10; page += 1) {
      await doc.getPageSize(page);
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(firstPage.cleanup).not.toHaveBeenCalled();
  });

  it("clears the whole page cache (and cleans up every page) on destroy", async () => {
    const doc = await new PdfJsRenderer().open(new Uint8Array());

    await doc.getPageSize(1);
    await doc.getPageSize(2);
    const pages = await Promise.all(issuedPages());

    await doc.destroy();
    await Promise.resolve();
    await Promise.resolve();

    for (const page of pages) {
      expect(page.cleanup).toHaveBeenCalledTimes(1);
    }
  });
});
