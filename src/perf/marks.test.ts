import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStart, markEnd, markStart } from "./marks";

describe("marks", () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    performance.clearMarks();
    performance.clearMeasures();
  });

  afterEach(() => {
    debugSpy.mockRestore();
  });

  it("logs a measured duration in dev", () => {
    markStart("open", true);
    const duration = markEnd("open", true);

    expect(duration).toBeGreaterThanOrEqual(0);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy.mock.calls[0][0]).toContain("open");
  });

  it("stays silent and returns undefined outside dev", () => {
    markStart("render", true);
    const duration = markEnd("render", false);

    expect(duration).toBeUndefined();
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("returns undefined when markEnd is called without a matching markStart", () => {
    const duration = markEnd("never-started", true);

    expect(duration).toBeUndefined();
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("clears its marks after a dev measurement so they do not accumulate", () => {
    markStart("cleanup", true);
    markEnd("cleanup", true);

    expect(performance.getEntriesByName("cleanup:start", "mark")).toHaveLength(
      0,
    );
    expect(performance.getEntriesByName("cleanup", "measure")).toHaveLength(0);
  });

  it("leaves the start mark in place when markEnd is called outside dev", () => {
    markStart("kept", true);
    markEnd("kept", false);

    expect(performance.getEntriesByName("kept:start", "mark")).toHaveLength(1);
  });

  it("does not confuse marks with the same base name across calls", () => {
    markStart("page-size", true);
    markStart("page-size", true);
    const duration = markEnd("page-size", true);

    expect(duration).toBeGreaterThanOrEqual(0);
  });

  it("does not create a start mark outside dev", () => {
    markStart("prod-open", false);

    expect(
      performance.getEntriesByName("prod-open:start", "mark"),
    ).toHaveLength(0);
    // With no start mark to find, a later dev markEnd cannot measure it —
    // production skipping markStart is what keeps a mark from piling up
    // forever once nothing in prod ever calls markEnd to clear it either.
    expect(markEnd("prod-open", true)).toBeUndefined();
  });

  describe("clearStart", () => {
    it("discards an abandoned start mark without measuring or logging it", () => {
      markStart("aborted-render", true);
      clearStart("aborted-render", true);

      expect(
        performance.getEntriesByName("aborted-render:start", "mark"),
      ).toHaveLength(0);
      expect(debugSpy).not.toHaveBeenCalled();
      // Nothing left to measure: a markEnd for the same name afterwards
      // finds no start mark and reports it the same as one that never ran.
      expect(markEnd("aborted-render", true)).toBeUndefined();
    });

    it("does nothing when there is no matching start mark", () => {
      expect(() => clearStart("never-started", true)).not.toThrow();
    });

    it("is a no-op outside dev, leaving the start mark in place", () => {
      markStart("kept-on-clear", true);
      clearStart("kept-on-clear", false);

      expect(
        performance.getEntriesByName("kept-on-clear:start", "mark"),
      ).toHaveLength(1);
    });
  });
});
