import {
  clampNotesPanelWidth,
  NOTES_PANEL_MAX_WIDTH,
  NOTES_PANEL_MIN_WIDTH,
} from "../settings/settings";

/**
 * Turning a drag on the notes panel's edge into a width (issue #76).
 *
 * The arithmetic lives here rather than in the component so the awkward cases
 * — a pointer dragged past either end, a window narrower than the width that
 * was saved on a wider one — can be tested without a pointer at all.
 */

/**
 * The share of the window the panel may take while it is being dragged. The
 * stored range (240–720px) is about the note; this is about what is left for
 * the page beside it, which only the window can say. Matches the `60vw` guard
 * in `.sidebar--notes`, so the drag stops where the layout would have stopped
 * it anyway rather than running on with nothing moving.
 */
export const NOTES_PANEL_MAX_VIEWPORT_RATIO = 0.6;

/** How far one arrow key press on the handle moves the edge, in px. */
export const NOTES_PANEL_KEY_STEP = 16;

/**
 * The widest the panel may be right now: the stored maximum, or the window's
 * share of it when that is narrower — but never below the minimum, or the
 * panel could not be dragged at all on a small window. A viewport width that
 * is not a usable number (an unmeasured window) leaves only the fixed range.
 */
export function maxNotesWidthFor(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return NOTES_PANEL_MAX_WIDTH;
  }
  return Math.max(
    NOTES_PANEL_MIN_WIDTH,
    Math.min(
      NOTES_PANEL_MAX_WIDTH,
      Math.round(viewportWidth * NOTES_PANEL_MAX_VIEWPORT_RATIO),
    ),
  );
}

/** A width the panel can be shown *and* stored at, on this window. */
export function clampNotesWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(width)) return NOTES_PANEL_MIN_WIDTH;
  return Math.min(clampNotesPanelWidth(width), maxNotesWidthFor(viewportWidth));
}

/**
 * The width the panel should take for a pointer at `pointerX`, given where its
 * right edge is. The panel is anchored to that edge, so it grows as the
 * pointer moves left — including past the window, which simply pins it to the
 * widest the window allows.
 */
export function notesWidthFromPointer(
  pointerX: number,
  panelRight: number,
  viewportWidth: number,
): number {
  return clampNotesWidth(panelRight - pointerX, viewportWidth);
}
