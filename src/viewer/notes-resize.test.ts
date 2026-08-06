import { describe, expect, it } from "vitest";
import {
  NOTES_PANEL_MAX_WIDTH,
  NOTES_PANEL_MIN_WIDTH,
} from "../settings/settings";
import {
  clampNotesWidth,
  maxNotesWidthFor,
  notesWidthFromPointer,
  NOTES_PANEL_COMPACT_MAX_VIEWPORT_RATIO,
  NOTES_PANEL_MAX_VIEWPORT_RATIO,
  type NotesViewport,
} from "./notes-resize";

/** A window wide enough that only the stored range limits the drag. */
const WIDE: NotesViewport = { width: 1600, isCompact: false };

/** The same window, laid out with the panel sharing the row with the pages. */
function roomy(width: number): NotesViewport {
  return { width, isCompact: false };
}

/** A compact window (issue #11): the panel covers the pages instead. */
function compact(width: number): NotesViewport {
  return { width, isCompact: true };
}

describe("maxNotesWidthFor", () => {
  it("allows the stored maximum on a window with room for it", () => {
    expect(maxNotesWidthFor(WIDE)).toBe(NOTES_PANEL_MAX_WIDTH);
  });

  it("keeps the window's share for the page on a narrower one", () => {
    // 60% of 1000 is 600, which is under the stored 720.
    expect(maxNotesWidthFor(roomy(1000))).toBe(
      1000 * NOTES_PANEL_MAX_VIEWPORT_RATIO,
    );
  });

  it("allows the compact layout's larger share, which covers the pages", () => {
    // The compact panel overlays the pages, so the `90vw` guard there is what
    // the drag has to agree with — stopping at 60vw would snap a stored width
    // the layout was happily showing down to something narrower.
    expect(maxNotesWidthFor(compact(600))).toBe(
      600 * NOTES_PANEL_COMPACT_MAX_VIEWPORT_RATIO,
    );
    expect(maxNotesWidthFor(compact(600))).toBeGreaterThan(
      maxNotesWidthFor(roomy(600)),
    );
  });

  it("never drops below the minimum, so the panel stays draggable", () => {
    // 60% of 300 is 180 — narrower than a note can be written in. The panel
    // covers more of a window this small rather than becoming unusable.
    expect(maxNotesWidthFor(roomy(300))).toBe(NOTES_PANEL_MIN_WIDTH);
    // 90% of 260 is 234, just under the minimum, and the same applies.
    expect(maxNotesWidthFor(compact(260))).toBe(NOTES_PANEL_MIN_WIDTH);
  });

  it("falls back to the stored maximum for a window it cannot measure", () => {
    for (const width of [0, -100, NaN, Infinity]) {
      expect(maxNotesWidthFor(roomy(width))).toBe(NOTES_PANEL_MAX_WIDTH);
      expect(maxNotesWidthFor(compact(width))).toBe(NOTES_PANEL_MAX_WIDTH);
    }
  });
});

describe("clampNotesWidth", () => {
  it("leaves a width both limits allow alone", () => {
    expect(clampNotesWidth(480, WIDE)).toBe(480);
    expect(clampNotesWidth(NOTES_PANEL_MIN_WIDTH, WIDE)).toBe(
      NOTES_PANEL_MIN_WIDTH,
    );
    expect(clampNotesWidth(NOTES_PANEL_MAX_WIDTH, WIDE)).toBe(
      NOTES_PANEL_MAX_WIDTH,
    );
  });

  it("clamps to whichever limit is tighter", () => {
    expect(clampNotesWidth(2000, WIDE)).toBe(NOTES_PANEL_MAX_WIDTH);
    // The window is the tighter one here: 60% of 1000.
    expect(clampNotesWidth(2000, roomy(1000))).toBe(600);
    expect(clampNotesWidth(10, WIDE)).toBe(NOTES_PANEL_MIN_WIDTH);
    expect(clampNotesWidth(-50, WIDE)).toBe(NOTES_PANEL_MIN_WIDTH);
  });

  it("keeps a stored width the compact layout can show, instead of shrinking it", () => {
    // A 500px panel on a 600px compact window: `min(90vw, 500px)` shows it in
    // full, so touching the handle must not be what makes it jump to 360.
    expect(clampNotesWidth(500, compact(600))).toBe(500);
    expect(clampNotesWidth(540, compact(600))).toBe(540);
    // Past 90vw it is capped, as the CSS would have capped it.
    expect(clampNotesWidth(580, compact(600))).toBe(540);
    // The same width on the same window sharing the row with the pages.
    expect(clampNotesWidth(500, roomy(600))).toBe(360);
  });

  it("rounds to whole pixels", () => {
    expect(clampNotesWidth(480.4, WIDE)).toBe(480);
    expect(clampNotesWidth(480.5, WIDE)).toBe(481);
  });

  it("falls back to the minimum for a width that is not a number", () => {
    expect(clampNotesWidth(NaN, WIDE)).toBe(NOTES_PANEL_MIN_WIDTH);
  });
});

describe("notesWidthFromPointer", () => {
  it("measures from the panel's right edge, which the drag cannot move", () => {
    expect(notesWidthFromPointer(1200, 1600, WIDE)).toBe(400);
    expect(notesWidthFromPointer(1100, 1600, WIDE)).toBe(500);
  });

  it("pins the panel at its widest for a pointer dragged past the left end", () => {
    expect(notesWidthFromPointer(0, 1600, WIDE)).toBe(NOTES_PANEL_MAX_WIDTH);
    // Off the window entirely — a capture keeps the drag alive out there.
    expect(notesWidthFromPointer(-500, 1600, WIDE)).toBe(NOTES_PANEL_MAX_WIDTH);
  });

  it("pins the panel at its narrowest for a pointer at or past the right edge", () => {
    expect(notesWidthFromPointer(1600, 1600, WIDE)).toBe(NOTES_PANEL_MIN_WIDTH);
    expect(notesWidthFromPointer(1900, 1600, WIDE)).toBe(NOTES_PANEL_MIN_WIDTH);
  });

  it("stops where the window's share of the width runs out", () => {
    // A 1000px window: dragging to x=100 asks for 900, capped at 600.
    expect(notesWidthFromPointer(100, 1000, roomy(1000))).toBe(600);
    // The same drag on a compact 600px window reaches 90% of it.
    expect(notesWidthFromPointer(0, 600, compact(600))).toBe(540);
  });
});
