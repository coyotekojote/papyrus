import { describe, expect, it } from "vitest";
import type { Annotations, Highlight } from "../files/sidecar";
import { emptyAnnotations } from "../files/sidecar";
import {
  HIGHLIGHT_COLORS,
  addHighlight,
  appendQuote,
  formatHighlightQuote,
  highlightAtPoint,
  highlightColorCss,
  highlightsOnPage,
  makeHighlight,
  normalizeSelectionRects,
  removeHighlight,
  sortHighlights,
} from "./highlights";

const PAGE = { left: 100, top: 50, width: 500, height: 1000 };

function highlight(overrides: Partial<Highlight> = {}): Highlight {
  return {
    id: "h1",
    page: 1,
    rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.02 }],
    color: "yellow",
    text: "抜粋",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("normalizeSelectionRects", () => {
  it("normalizes a rect against the page box", () => {
    const rects = normalizeSelectionRects(
      [{ left: 150, top: 250, width: 250, height: 20 }],
      PAGE,
    );

    expect(rects).toEqual([{ x: 0.1, y: 0.2, w: 0.5, h: 0.02 }]);
  });

  it("clips rects that overflow the page", () => {
    const rects = normalizeSelectionRects(
      [{ left: 0, top: 1000, width: 1000, height: 200 }],
      PAGE,
    );

    expect(rects).toEqual([{ x: 0, y: 0.95, w: 1, h: 0.05 }]);
  });

  it("drops rects that lie entirely outside the page", () => {
    expect(
      normalizeSelectionRects(
        [{ left: 700, top: 250, width: 50, height: 20 }],
        PAGE,
      ),
    ).toEqual([]);
  });

  it("drops sub-pixel noise rects", () => {
    expect(
      normalizeSelectionRects(
        [{ left: 150, top: 250, width: 0.2, height: 20 }],
        PAGE,
      ),
    ).toEqual([]);
  });

  it("merges overlapping fragments on the same text line", () => {
    const rects = normalizeSelectionRects(
      [
        { left: 150, top: 250, width: 100, height: 20 },
        { left: 240, top: 251, width: 100, height: 20 },
      ],
      PAGE,
    );

    expect(rects).toHaveLength(1);
    expect(rects[0].x).toBeCloseTo(0.1, 4);
    expect(rects[0].w).toBeCloseTo(0.38, 4);
  });

  it("keeps separate text lines as separate rects", () => {
    const rects = normalizeSelectionRects(
      [
        { left: 150, top: 250, width: 200, height: 20 },
        { left: 150, top: 280, width: 100, height: 20 },
      ],
      PAGE,
    );

    expect(rects).toHaveLength(2);
  });

  it("keeps a column gutter apart even on the same line", () => {
    const rects = normalizeSelectionRects(
      [
        { left: 150, top: 250, width: 100, height: 20 },
        { left: 400, top: 250, width: 100, height: 20 },
      ],
      PAGE,
    );

    expect(rects).toHaveLength(2);
  });

  it("returns nothing for a degenerate page box", () => {
    expect(
      normalizeSelectionRects(
        [{ left: 150, top: 250, width: 100, height: 20 }],
        { left: 0, top: 0, width: 0, height: 0 },
      ),
    ).toEqual([]);
  });
});

describe("highlight mutations", () => {
  it("adds and removes a highlight immutably", () => {
    const base = emptyAnnotations();
    const withOne = addHighlight(base, highlight());

    expect(withOne.highlights).toHaveLength(1);
    expect(base.highlights).toHaveLength(0);

    const removed = removeHighlight(withOne, "h1");
    expect(removed.highlights).toHaveLength(0);
    expect(withOne.highlights).toHaveLength(1);
  });

  it("removing an unknown id leaves the rest alone", () => {
    const annotations: Annotations = {
      ...emptyAnnotations(),
      highlights: [highlight()],
    };

    expect(removeHighlight(annotations, "nope").highlights).toHaveLength(1);
  });

  it("builds a highlight with an ISO timestamp and the given fields", () => {
    const made = makeHighlight({
      page: 3,
      rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.02 }],
      color: "green",
      text: "本文",
      createdAt: new Date("2026-08-01T12:34:56Z"),
      id: "fixed",
    });

    expect(made).toEqual({
      id: "fixed",
      page: 3,
      rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.02 }],
      color: "green",
      text: "本文",
      createdAt: "2026-08-01T12:34:56.000Z",
    });
  });
});

describe("queries", () => {
  const highlights = [
    highlight({
      id: "a",
      page: 2,
      rects: [{ x: 0.5, y: 0.5, w: 0.2, h: 0.02 }],
    }),
    highlight({
      id: "b",
      page: 1,
      rects: [{ x: 0.1, y: 0.8, w: 0.2, h: 0.02 }],
    }),
    highlight({
      id: "c",
      page: 1,
      rects: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.02 }],
    }),
  ];

  it("filters highlights by page", () => {
    expect(highlightsOnPage(highlights, 1).map((h) => h.id)).toEqual([
      "b",
      "c",
    ]);
    expect(highlightsOnPage(highlights, 3)).toEqual([]);
  });

  it("sorts by page, then top-to-bottom", () => {
    expect(sortHighlights(highlights).map((h) => h.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });

  it("hit-tests a point inside a highlight rect", () => {
    expect(highlightAtPoint(highlights, 1, { x: 0.2, y: 0.81 })?.id).toBe("b");
  });

  it("includes rect edges in the hit area", () => {
    expect(highlightAtPoint(highlights, 1, { x: 0.1, y: 0.1 })?.id).toBe("c");
    expect(highlightAtPoint(highlights, 1, { x: 0.3, y: 0.12 })?.id).toBe("c");
  });

  it("misses points outside every rect, and the wrong page", () => {
    expect(highlightAtPoint(highlights, 1, { x: 0.9, y: 0.9 })).toBeNull();
    expect(highlightAtPoint(highlights, 3, { x: 0.2, y: 0.81 })).toBeNull();
  });

  it("prefers the newest highlight when rects overlap", () => {
    const overlapping = [highlight({ id: "old" }), highlight({ id: "new" })];

    expect(highlightAtPoint(overlapping, 1, { x: 0.2, y: 0.21 })?.id).toBe(
      "new",
    );
  });
});

describe("colors", () => {
  it("maps known color ids to their css value", () => {
    for (const color of HIGHLIGHT_COLORS) {
      expect(highlightColorCss(color.id)).toBe(color.css);
    }
  });

  it("falls back to the first color for unknown ids", () => {
    expect(highlightColorCss("mauve")).toBe(HIGHLIGHT_COLORS[0].css);
  });
});

describe("notes quotes", () => {
  it("formats a highlight as a markdown quote with its page", () => {
    expect(formatHighlightQuote(highlight({ text: "一行目\n二行目" }))).toBe(
      "> 一行目\n> 二行目\n>\n> — p.1",
    );
  });

  it("quotes empty lines without trailing spaces", () => {
    expect(formatHighlightQuote(highlight({ text: "上\n\n下" }))).toBe(
      "> 上\n>\n> 下\n>\n> — p.1",
    );
  });

  it("starts empty notes with the quote alone", () => {
    expect(appendQuote("", "> 引用\n>\n> — p.1")).toBe("> 引用\n>\n> — p.1\n");
  });

  it("separates the quote from existing notes with one blank line", () => {
    expect(appendQuote("# メモ\n本文\n\n", "> 引用")).toBe(
      "# メモ\n本文\n\n> 引用\n",
    );
  });
});
