import type { Annotations, Highlight, NormalizedRect } from "../files/sidecar";
import { clampUnit, round, type RectLike } from "./normalize";

/**
 * Pure logic for text highlights (issue #6): turning a DOM selection into
 * normalized page rects, mutating the annotations document, hit-testing
 * clicks, and formatting a highlight as a markdown quote for notes.md.
 */

export interface HighlightColor {
  id: string;
  label: string;
  /** Solid swatch color; the on-page rect is faded by the CSS opacity. */
  css: string;
}

export const HIGHLIGHT_COLORS: readonly HighlightColor[] = [
  { id: "yellow", label: "黄色", css: "#facc15" },
  { id: "green", label: "緑", css: "#4ade80" },
  { id: "blue", label: "青", css: "#60a5fa" },
  { id: "pink", label: "ピンク", css: "#f472b6" },
];

/** Colors from another device (or a future palette) still need to render. */
export function highlightColorCss(colorId: string): string {
  const known = HIGHLIGHT_COLORS.find((color) => color.id === colorId);
  return known?.css ?? HIGHLIGHT_COLORS[0].css;
}

/** Rects thinner/shorter than this (normalized) are selection noise. */
const MIN_RECT_SIZE = 0.001;
/** Rects whose vertical overlap exceeds this share of the smaller height sit on one line. */
const SAME_LINE_OVERLAP = 0.5;
/** Horizontal gaps wider than this (normalized) split a line, e.g. column gutters. */
const MERGE_GAP = 0.01;

/**
 * Converts selection client rects into page-normalized rects: clips them to
 * the page, drops the sub-pixel noise a DOM selection produces, and merges
 * fragments that sit on the same text line (keeping genuine gaps, such as a
 * two-column gutter, apart).
 */
export function normalizeSelectionRects(
  clientRects: readonly RectLike[],
  pageRect: RectLike,
): NormalizedRect[] {
  if (pageRect.width <= 0 || pageRect.height <= 0) return [];

  const normalized: NormalizedRect[] = [];
  for (const rect of clientRects) {
    const x = clampUnit((rect.left - pageRect.left) / pageRect.width);
    const y = clampUnit((rect.top - pageRect.top) / pageRect.height);
    const right = clampUnit(
      (rect.left + rect.width - pageRect.left) / pageRect.width,
    );
    const bottom = clampUnit(
      (rect.top + rect.height - pageRect.top) / pageRect.height,
    );
    const w = right - x;
    const h = bottom - y;
    if (w >= MIN_RECT_SIZE && h >= MIN_RECT_SIZE) {
      normalized.push({ x, y, w, h });
    }
  }
  return mergeLineRects(normalized);
}

function verticalOverlap(a: NormalizedRect, b: NormalizedRect): number {
  const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlap / Math.min(a.h, b.h);
}

function union(a: NormalizedRect, b: NormalizedRect): NormalizedRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

function mergeLineRects(rects: NormalizedRect[]): NormalizedRect[] {
  // Group rects into text lines by vertical overlap…
  const sorted = [...rects].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
  const lines: NormalizedRect[][] = [];
  for (const rect of sorted) {
    const line = lines.find((candidates) =>
      candidates.some(
        (other) => verticalOverlap(rect, other) >= SAME_LINE_OVERLAP,
      ),
    );
    if (line) line.push(rect);
    else lines.push([rect]);
  }

  // …then merge each line's overlapping or nearly-touching fragments.
  const merged: NormalizedRect[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x);
    let current = line[0];
    for (const rect of line.slice(1)) {
      if (rect.x <= current.x + current.w + MERGE_GAP) {
        current = union(current, rect);
      } else {
        merged.push(current);
        current = rect;
      }
    }
    merged.push(current);
  }
  return merged.map((rect) => ({
    x: round(rect.x),
    y: round(rect.y),
    w: round(rect.w),
    h: round(rect.h),
  }));
}

export interface MakeHighlightInput {
  page: number;
  rects: NormalizedRect[];
  color: string;
  text: string;
  /** Injected so callers (and tests) control the clock. */
  createdAt: Date;
  id?: string;
}

export function makeHighlight({
  page,
  rects,
  color,
  text,
  createdAt,
  id,
}: MakeHighlightInput): Highlight {
  return {
    id: id ?? crypto.randomUUID(),
    page,
    rects,
    color,
    text,
    createdAt: createdAt.toISOString(),
  };
}

export function addHighlight(
  annotations: Annotations,
  highlight: Highlight,
): Annotations {
  return { ...annotations, highlights: [...annotations.highlights, highlight] };
}

export function removeHighlight(
  annotations: Annotations,
  id: string,
): Annotations {
  return {
    ...annotations,
    highlights: annotations.highlights.filter((h) => h.id !== id),
  };
}

export function highlightsOnPage(
  highlights: readonly Highlight[],
  page: number,
): Highlight[] {
  return highlights.filter((highlight) => highlight.page === page);
}

/** Reading order: by page, then top-to-bottom, then left-to-right. */
export function sortHighlights(highlights: readonly Highlight[]): Highlight[] {
  const top = (h: Highlight) => h.rects[0]?.y ?? 0;
  const left = (h: Highlight) => h.rects[0]?.x ?? 0;
  return [...highlights].sort(
    (a, b) => a.page - b.page || top(a) - top(b) || left(a) - left(b),
  );
}

export interface NormalizedPoint {
  x: number;
  y: number;
}

/**
 * The highlight under a click, newest first so the one drawn on top wins.
 * Returns null when the point hits none.
 */
export function highlightAtPoint(
  highlights: readonly Highlight[],
  page: number,
  point: NormalizedPoint,
): Highlight | null {
  // Walked back to front: the newest highlight is the one drawn on top.
  for (let index = highlights.length - 1; index >= 0; index -= 1) {
    const highlight = highlights[index];
    if (highlight.page !== page) continue;
    const hit = highlight.rects.some(
      (rect) =>
        point.x >= rect.x &&
        point.x <= rect.x + rect.w &&
        point.y >= rect.y &&
        point.y <= rect.y + rect.h,
    );
    if (hit) return highlight;
  }
  return null;
}

/**
 * Markdown blockquote for notes.md, readable by Obsidian and friends. Shared
 * with the translation note (issue #10), so an extract cites its page the same
 * way whichever action put it there.
 */
export function formatQuote(text: string, page: number): string {
  const quoted = text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
  return `${quoted}\n>\n> — p.${page}`;
}

export function formatHighlightQuote(highlight: Highlight): string {
  return formatQuote(highlight.text, highlight.page);
}
