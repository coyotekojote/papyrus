import type { Annotations, Clip, NormalizedRect } from "../files/sidecar";
import { clampUnit, round, type RectLike } from "./normalize";

/**
 * Pure logic for figure clips (issue #8): turning a drag over a page into a
 * normalized rect, mutating the annotations document, and formatting a clip as
 * a markdown image for notes.md.
 */

/**
 * A drag narrower or shorter than this share of the page is not a region —
 * it is a click that moved a little, or a stray gesture. Cutting one would
 * produce a few-pixel image and, worse, a note entry nobody asked for.
 */
export const MIN_CLIP_SIZE = 0.01;

/** A pointer position in client (viewport) coordinates. */
export interface DragPoint {
  x: number;
  y: number;
}

/**
 * The rect two ends of a drag describe, in page-normalized coordinates —
 * or null when the drag is too small to be a region.
 *
 * Dragging in any direction works: the corners are sorted, so a selection
 * pulled up and to the left means the same thing as one pulled down and to
 * the right. Anything outside the page is cut off at its edge, which is what
 * a drag that runs past the paper should cover.
 */
export function normalizeDragRect(
  start: DragPoint,
  end: DragPoint,
  pageRect: RectLike,
): NormalizedRect | null {
  if (pageRect.width <= 0 || pageRect.height <= 0) return null;

  const xs = [start.x, end.x].map((x) =>
    clampUnit((x - pageRect.left) / pageRect.width),
  );
  const ys = [start.y, end.y].map((y) =>
    clampUnit((y - pageRect.top) / pageRect.height),
  );
  const rect = {
    x: round(Math.min(...xs)),
    y: round(Math.min(...ys)),
    w: round(Math.abs(xs[1] - xs[0])),
    h: round(Math.abs(ys[1] - ys[0])),
  };
  if (rect.w < MIN_CLIP_SIZE || rect.h < MIN_CLIP_SIZE) return null;
  return rect;
}

/** Absolute placement of the selection rectangle, in CSS pixels. */
export interface MarqueeBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where to draw the selection rectangle while the drag is in progress,
 * relative to `origin` — the positioned ancestor it is mounted in, the same
 * one the popups use.
 *
 * Clipped to the page, so a drag that runs past the paper shows exactly the
 * region it will actually cut rather than a rectangle over the toolbar.
 */
export function marqueeBox(
  start: DragPoint,
  end: DragPoint,
  pageRect: RectLike,
  origin: DragPoint,
): MarqueeBox {
  const clamp = (value: number, low: number, size: number) =>
    Math.min(low + size, Math.max(low, value));
  const xs = [start.x, end.x].map((x) =>
    clamp(x, pageRect.left, pageRect.width),
  );
  const ys = [start.y, end.y].map((y) =>
    clamp(y, pageRect.top, pageRect.height),
  );
  return {
    left: Math.min(...xs) - origin.x,
    top: Math.min(...ys) - origin.y,
    width: Math.abs(xs[1] - xs[0]),
    height: Math.abs(ys[1] - ys[0]),
  };
}

export interface MakeClipInput {
  page: number;
  rect: NormalizedRect;
  /** Path relative to the sidecar folder, as `save_clip` handed it back. */
  file: string;
  /** Injected so callers (and tests) control the clock. */
  createdAt: Date;
  id?: string;
}

export function makeClip({
  page,
  rect,
  file,
  createdAt,
  id,
}: MakeClipInput): Clip {
  return {
    id: id ?? crypto.randomUUID(),
    page,
    rect,
    file,
    createdAt: createdAt.toISOString(),
  };
}

export function addClip(annotations: Annotations, clip: Clip): Annotations {
  return { ...annotations, clips: [...annotations.clips, clip] };
}

/**
 * Markdown image for notes.md. The path stays relative to the sidecar folder
 * so the note keeps working when the folder is synced to another device — or
 * opened in Obsidian, which resolves it the same way.
 */
export function formatClipImage(clip: Clip): string {
  return `![p.${clip.page} の図](${clip.file})`;
}
