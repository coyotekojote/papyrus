import { describe, expect, it, vi } from "vitest";
import { resolveOutline, type DestinationLookup } from "./outline-resolve";

/** Pages 1..n are addressed by the reference `{ num: n * 10, gen: 0 }`. */
function lookup(overrides: Partial<DestinationLookup> = {}): DestinationLookup {
  return {
    getDestination: vi.fn(async (id: string) =>
      id === "chapter-2" ? [{ num: 20, gen: 0 }, { name: "Fit" }] : null,
    ),
    getPageIndex: vi.fn(async (ref) => ref.num / 10 - 1),
    ...overrides,
  };
}

describe("resolveOutline", () => {
  it("returns an empty tree for a document without bookmarks", async () => {
    expect(await resolveOutline([], lookup())).toEqual([]);
    expect(await resolveOutline(null, lookup())).toEqual([]);
    expect(await resolveOutline(undefined, lookup())).toEqual([]);
  });

  it("turns an explicit destination's page reference into a 1-based page", async () => {
    const outline = await resolveOutline(
      [{ title: "序章", dest: [{ num: 10, gen: 0 }, { name: "XYZ" }] }],
      lookup(),
    );

    expect(outline).toEqual([{ title: "序章", pageNumber: 1, children: [] }]);
  });

  it("looks a named destination up in the document", async () => {
    const doc = lookup();

    const outline = await resolveOutline(
      [{ title: "第2章", dest: "chapter-2" }],
      doc,
    );

    expect(doc.getDestination).toHaveBeenCalledWith("chapter-2");
    expect(outline[0].pageNumber).toBe(2);
  });

  it("accepts a destination that addresses the page by index", async () => {
    const outline = await resolveOutline(
      [{ title: "表紙", dest: [0] }],
      lookup(),
    );

    expect(outline[0].pageNumber).toBe(1);
  });

  it("resolves nested bookmarks at every depth", async () => {
    const outline = await resolveOutline(
      [
        {
          title: "本論",
          dest: [{ num: 30, gen: 0 }],
          items: [
            {
              title: "前半",
              dest: [{ num: 30, gen: 0 }],
              items: [{ title: "補足", dest: [{ num: 40, gen: 0 }] }],
            },
          ],
        },
      ],
      lookup(),
    );

    expect(outline).toEqual([
      {
        title: "本論",
        pageNumber: 3,
        children: [
          {
            title: "前半",
            pageNumber: 3,
            children: [{ title: "補足", pageNumber: 4, children: [] }],
          },
        ],
      },
    ]);
  });

  it("keeps a bookmark with no destination, with a null page", async () => {
    const outline = await resolveOutline(
      [{ title: "外部リンク", dest: null }, { title: "無し" }],
      lookup(),
    );

    expect(outline.map((node) => node.pageNumber)).toEqual([null, null]);
  });

  it("keeps a bookmark whose named destination is unknown", async () => {
    const outline = await resolveOutline(
      [{ title: "壊れたしおり", dest: "missing" }],
      lookup(),
    );

    expect(outline[0]).toEqual({
      title: "壊れたしおり",
      pageNumber: null,
      children: [],
    });
  });

  it("survives a lookup that throws, without losing the rest of the tree", async () => {
    const doc = lookup({
      getPageIndex: vi.fn(async () => {
        throw new Error("broken ref");
      }),
    });

    const outline = await resolveOutline(
      [
        { title: "壊れた", dest: [{ num: 10, gen: 0 }] },
        { title: "索引", dest: [4] },
      ],
      doc,
    );

    expect(outline.map((node) => [node.title, node.pageNumber])).toEqual([
      ["壊れた", null],
      ["索引", 5],
    ]);
  });

  it("rejects a negative or fractional page index rather than inventing a page", async () => {
    const outline = await resolveOutline(
      [
        { title: "負", dest: [-1] },
        { title: "小数", dest: [1.5] },
      ],
      lookup(),
    );

    expect(outline.map((node) => node.pageNumber)).toEqual([null, null]);
  });

  it("falls back to an empty title when the bookmark has none", async () => {
    const outline = await resolveOutline([{ dest: [0] }], lookup());

    expect(outline[0].title).toBe("");
  });
});
