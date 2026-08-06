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
 * The share of the window the panel may take while it is being dragged, on a
 * layout where it shares the row with the pages. The stored range (240–720px)
 * is about the note; this is about what is left for the page beside it, which
 * only the window can say. Matches the `60vw` guard in `.sidebar--notes`.
 */
export const NOTES_PANEL_MAX_VIEWPORT_RATIO = 0.6;

/**
 * The same share on a compact layout (issue #11), where the panel covers the
 * pages instead of sharing the row with them: there is no page beside it to
 * keep readable, only enough window left to close it by. Matches the `90vw`
 * guard in the compact `.sidebar--notes` rule.
 */
export const NOTES_PANEL_COMPACT_MAX_VIEWPORT_RATIO = 0.9;

/** How far one arrow key press on the handle moves the edge, in px. */
export const NOTES_PANEL_KEY_STEP = 16;

/** The window a resize is happening in, which decides the cap above. */
export interface NotesViewport {
  /** Window width in CSS px. */
  width: number;
  /** Whether the compact layout (issue #11) is in force. */
  isCompact: boolean;
}

/**
 * The widest the panel may be right now: the stored maximum, or the window's
 * share of it when that is narrower — but never below the minimum, or the
 * panel could not be dragged at all on a small window. A viewport width that
 * is not a usable number (an unmeasured window) leaves only the fixed range.
 *
 * The share has to agree with whichever CSS guard is in force, or a drag would
 * stop somewhere the layout would have kept going — or worse, the first drag
 * on a stored width the layout was happily showing would snap it narrower.
 */
export function maxNotesWidthFor(viewport: NotesViewport): number {
  if (!Number.isFinite(viewport.width) || viewport.width <= 0) {
    return NOTES_PANEL_MAX_WIDTH;
  }
  const ratio = viewport.isCompact
    ? NOTES_PANEL_COMPACT_MAX_VIEWPORT_RATIO
    : NOTES_PANEL_MAX_VIEWPORT_RATIO;
  return Math.max(
    NOTES_PANEL_MIN_WIDTH,
    Math.min(NOTES_PANEL_MAX_WIDTH, Math.round(viewport.width * ratio)),
  );
}

/** A width the panel can be shown *and* stored at, in this window. */
export function clampNotesWidth(
  width: number,
  viewport: NotesViewport,
): number {
  if (!Number.isFinite(width)) return NOTES_PANEL_MIN_WIDTH;
  return Math.min(clampNotesPanelWidth(width), maxNotesWidthFor(viewport));
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
  viewport: NotesViewport,
): number {
  return clampNotesWidth(panelRight - pointerX, viewport);
}
