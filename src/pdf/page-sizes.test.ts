import { describe, expect, it, vi } from "vitest";
import {
  FALLBACK_PAGE_SIZE,
  loadPageSizes,
  loadPageSizesProgressive,
} from "./page-sizes";
import type { PageSize } from "./types";

function fakeDoc(sizes: Array<PageSize | Error>) {
  return {
    pageCount: sizes.length,
    getPageSize: vi.fn(async (pageNumber: number) => {
      const entry = sizes[pageNumber - 1];
      if (entry instanceof Error) throw entry;
      return entry;
    }),
  };
}

describe("loadPageSizes", () => {
  it("returns an empty array for a document with no pages", async () => {
    await expect(loadPageSizes(fakeDoc([]))).resolves.toEqual([]);
  });

  it("returns the sizes in page order", async () => {
    const doc = fakeDoc([
      { width: 100, height: 200 },
      { width: 300, height: 400 },
      { width: 500, height: 600 },
    ]);

    await expect(loadPageSizes(doc, { chunkSize: 2 })).resolves.toEqual([
      { width: 100, height: 200 },
      { width: 300, height: 400 },
      { width: 500, height: 600 },
    ]);
  });

  it("substitutes the fallback size for pages that fail", async () => {
    const doc = fakeDoc([
      { width: 100, height: 200 },
      new Error("broken page"),
    ]);

    await expect(loadPageSizes(doc)).resolves.toEqual([
      { width: 100, height: 200 },
      FALLBACK_PAGE_SIZE,
    ]);
  });

  it("reports progress after every chunk", async () => {
    const doc = fakeDoc([
      { width: 1, height: 1 },
      { width: 2, height: 2 },
      { width: 3, height: 3 },
    ]);
    const lengths: number[] = [];

    await loadPageSizes(doc, {
      chunkSize: 2,
      onProgress: (sizes) => lengths.push(sizes.length),
    });

    expect(lengths).toEqual([2, 3]);
  });

  it("stops early and returns what it has when aborted", async () => {
    const doc = fakeDoc([
      { width: 1, height: 1 },
      { width: 2, height: 2 },
      { width: 3, height: 3 },
      { width: 4, height: 4 },
    ]);
    const controller = new AbortController();

    const sizes = await loadPageSizes(doc, {
      chunkSize: 2,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });

    expect(sizes).toHaveLength(2);
    expect(doc.getPageSize).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid chunk size", async () => {
    await expect(loadPageSizes(fakeDoc([]), { chunkSize: 0 })).rejects.toThrow(
      RangeError,
    );
  });
});

describe("loadPageSizesProgressive", () => {
  it("returns an empty initial array and an already-resolved done for a document with no pages", async () => {
    const doc = fakeDoc([]);

    const { initial, done } = await loadPageSizesProgressive(doc);

    expect(initial).toEqual([]);
    await expect(done).resolves.toEqual([]);
    expect(doc.getPageSize).not.toHaveBeenCalled();
  });

  it("resolves with only the first chunk, then finishes the rest in the background", async () => {
    const doc = fakeDoc([
      { width: 1, height: 1 },
      { width: 2, height: 2 },
      { width: 3, height: 3 },
      { width: 4, height: 4 },
      { width: 5, height: 5 },
    ]);

    const { initial, done } = await loadPageSizesProgressive(doc, {
      firstChunk: 2,
      chunkSize: 2,
    });

    expect(initial).toEqual([
      { width: 1, height: 1 },
      { width: 2, height: 2 },
    ]);

    await expect(done).resolves.toEqual([
      { width: 1, height: 1 },
      { width: 2, height: 2 },
      { width: 3, height: 3 },
      { width: 4, height: 4 },
      { width: 5, height: 5 },
    ]);
  });

  it("does not mutate the initial snapshot once the background continuation grows the sizes it collected", async () => {
    const doc = fakeDoc([
      { width: 1, height: 1 },
      { width: 2, height: 2 },
      { width: 3, height: 3 },
    ]);

    const { initial, done } = await loadPageSizesProgressive(doc, {
      firstChunk: 1,
      chunkSize: 1,
    });
    await done;

    expect(initial).toEqual([{ width: 1, height: 1 }]);
  });

  it("returns everything as initial when firstChunk covers the whole document", async () => {
    const doc = fakeDoc([
      { width: 1, height: 1 },
      { width: 2, height: 2 },
    ]);

    const { initial, done } = await loadPageSizesProgressive(doc, {
      firstChunk: 10,
    });

    expect(initial).toEqual([
      { width: 1, height: 1 },
      { width: 2, height: 2 },
    ]);
    await expect(done).resolves.toEqual(initial);
  });

  it("propagates onProgress for the first chunk and every background batch", async () => {
    const doc = fakeDoc([
      { width: 1, height: 1 },
      { width: 2, height: 2 },
      { width: 3, height: 3 },
      { width: 4, height: 4 },
    ]);
    const lengths: number[] = [];

    const { done } = await loadPageSizesProgressive(doc, {
      firstChunk: 1,
      chunkSize: 1,
      onProgress: (sizes) => lengths.push(sizes.length),
    });
    await done;

    expect(lengths).toEqual([1, 2, 3, 4]);
  });

  it("substitutes the fallback size for a page that fails, in the initial chunk or the background", async () => {
    const doc = fakeDoc([
      new Error("broken page 1"),
      { width: 2, height: 2 },
      new Error("broken page 3"),
    ]);

    const { initial, done } = await loadPageSizesProgressive(doc, {
      firstChunk: 1,
    });

    expect(initial).toEqual([FALLBACK_PAGE_SIZE]);
    await expect(done).resolves.toEqual([
      FALLBACK_PAGE_SIZE,
      { width: 2, height: 2 },
      FALLBACK_PAGE_SIZE,
    ]);
  });

  it("stops the background continuation when aborted, leaving initial untouched", async () => {
    const doc = fakeDoc([
      { width: 1, height: 1 },
      { width: 2, height: 2 },
      { width: 3, height: 3 },
    ]);
    const controller = new AbortController();

    const { initial, done } = await loadPageSizesProgressive(doc, {
      firstChunk: 1,
      chunkSize: 1,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });

    expect(initial).toEqual([{ width: 1, height: 1 }]);
    await expect(done).resolves.toEqual([{ width: 1, height: 1 }]);
    // Only the initial page: the abort fired from onProgress before the
    // background loop could fetch page 2.
    expect(doc.getPageSize).toHaveBeenCalledTimes(1);
  });

  it("resolves immediately with what it has when already aborted before the first chunk", async () => {
    const doc = fakeDoc([{ width: 1, height: 1 }]);
    const controller = new AbortController();
    controller.abort();

    const { initial, done } = await loadPageSizesProgressive(doc, {
      signal: controller.signal,
    });

    expect(initial).toEqual([]);
    await expect(done).resolves.toEqual([]);
    expect(doc.getPageSize).not.toHaveBeenCalled();
  });

  it("rejects an invalid firstChunk", async () => {
    await expect(
      loadPageSizesProgressive(fakeDoc([]), { firstChunk: 0 }),
    ).rejects.toThrow(RangeError);
  });

  it("rejects an invalid chunk size", async () => {
    await expect(
      loadPageSizesProgressive(fakeDoc([]), { chunkSize: -1 }),
    ).rejects.toThrow(RangeError);
  });
});
