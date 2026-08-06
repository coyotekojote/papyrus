import { describe, expect, it } from "vitest";
import {
  NOTES_PANEL_MAX_WIDTH,
  NOTES_PANEL_MIN_WIDTH,
} from "../settings/settings";
import {
  clampNotesWidth,
  maxNotesWidthFor,
  notesWidthFromPointer,
  NOTES_PANEL_MAX_VIEWPORT_RATIO,
} from "./notes-resize";

/** A window wide enough that only the stored range limits the drag. */
const WIDE_WINDOW = 1600;

describe("maxNotesWidthFor", () => {
  it("allows the stored maximum on a window with room for it", () => {
    expect(maxNotesWidthFor(WIDE_WINDOW)).toBe(NOTES_PANEL_MAX_WIDTH);
  });

  it("keeps the window's share for the page on a narrower one", () => {
    // 60% of 1000 is 600, which is under the stored 720.
    expect(maxNotesWidthFor(1000)).toBe(1000 * NOTES_PANEL_MAX_VIEWPORT_RATIO);
  });

  it("never drops below the minimum, so the panel stays draggable", () => {
    // 60% of 300 is 180 — narrower than a note can be written in. The panel
    // covers more of a window this small rather than becoming unusable.
    expect(maxNotesWidthFor(300)).toBe(NOTES_PANEL_MIN_WIDTH);
  });

  it("falls back to the stored maximum for a window it cannot measure", () => {
    for (const width of [0, -100, NaN, Infinity]) {
      expect(maxNotesWidthFor(width)).toBe(NOTES_PANEL_MAX_WIDTH);
    }
  });
});

describe("clampNotesWidth", () => {
  it("leaves a width both limits allow alone", () => {
    expect(clampNotesWidth(480, WIDE_WINDOW)).toBe(480);
    expect(clampNotesWidth(NOTES_PANEL_MIN_WIDTH, WIDE_WINDOW)).toBe(
      NOTES_PANEL_MIN_WIDTH,
    );
    expect(clampNotesWidth(NOTES_PANEL_MAX_WIDTH, WIDE_WINDOW)).toBe(
      NOTES_PANEL_MAX_WIDTH,
    );
  });

  it("clamps to whichever limit is tighter", () => {
    expect(clampNotesWidth(2000, WIDE_WINDOW)).toBe(NOTES_PANEL_MAX_WIDTH);
    // The window is the tighter one here: 60% of 1000.
    expect(clampNotesWidth(2000, 1000)).toBe(600);
    expect(clampNotesWidth(10, WIDE_WINDOW)).toBe(NOTES_PANEL_MIN_WIDTH);
    expect(clampNotesWidth(-50, WIDE_WINDOW)).toBe(NOTES_PANEL_MIN_WIDTH);
  });

  it("rounds to whole pixels", () => {
    expect(clampNotesWidth(480.4, WIDE_WINDOW)).toBe(480);
    expect(clampNotesWidth(480.5, WIDE_WINDOW)).toBe(481);
  });

  it("falls back to the minimum for a width that is not a number", () => {
    expect(clampNotesWidth(NaN, WIDE_WINDOW)).toBe(NOTES_PANEL_MIN_WIDTH);
  });
});

describe("notesWidthFromPointer", () => {
  it("measures from the panel's right edge, which the drag cannot move", () => {
    expect(notesWidthFromPointer(1200, 1600, WIDE_WINDOW)).toBe(400);
    expect(notesWidthFromPointer(1100, 1600, WIDE_WINDOW)).toBe(500);
  });

  it("pins the panel at its widest for a pointer dragged past the left end", () => {
    expect(notesWidthFromPointer(0, 1600, WIDE_WINDOW)).toBe(
      NOTES_PANEL_MAX_WIDTH,
    );
    // Off the window entirely — a capture keeps the drag alive out there.
    expect(notesWidthFromPointer(-500, 1600, WIDE_WINDOW)).toBe(
      NOTES_PANEL_MAX_WIDTH,
    );
  });

  it("pins the panel at its narrowest for a pointer at or past the right edge", () => {
    expect(notesWidthFromPointer(1600, 1600, WIDE_WINDOW)).toBe(
      NOTES_PANEL_MIN_WIDTH,
    );
    expect(notesWidthFromPointer(1900, 1600, WIDE_WINDOW)).toBe(
      NOTES_PANEL_MIN_WIDTH,
    );
  });

  it("stops where the window's share of the width runs out", () => {
    // A 1000px window: dragging to x=100 asks for 900, capped at 600.
    expect(notesWidthFromPointer(100, 1000, 1000)).toBe(600);
  });
});
