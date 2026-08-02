import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markEnd, markStart } from "./marks";

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
    markStart("open");
    const duration = markEnd("open", true);

    expect(duration).toBeGreaterThanOrEqual(0);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy.mock.calls[0][0]).toContain("open");
  });

  it("stays silent and returns undefined outside dev", () => {
    markStart("render");
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
    markStart("cleanup");
    markEnd("cleanup", true);

    expect(performance.getEntriesByName("cleanup:start", "mark")).toHaveLength(
      0,
    );
    expect(performance.getEntriesByName("cleanup", "measure")).toHaveLength(0);
  });

  it("leaves the start mark in place when called outside dev", () => {
    markStart("kept");
    markEnd("kept", false);

    expect(performance.getEntriesByName("kept:start", "mark")).toHaveLength(1);
  });

  it("does not confuse marks with the same base name across calls", () => {
    markStart("page-size");
    markStart("page-size");
    const duration = markEnd("page-size", true);

    expect(duration).toBeGreaterThanOrEqual(0);
  });
});
