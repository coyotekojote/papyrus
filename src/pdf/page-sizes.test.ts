import { describe, expect, it, vi } from "vitest";
import { FALLBACK_PAGE_SIZE, loadPageSizes } from "./page-sizes";
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
