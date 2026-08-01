import { describe, expect, it } from "vitest";
import {
  applyZoomCommand,
  clampZoom,
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  pinchZoom,
  steppedZoom,
  zoomCommandForKey,
} from "./zoom";

describe("clampZoom", () => {
  it("keeps a value inside the range", () => {
    expect(clampZoom(1.5)).toBe(1.5);
  });

  it("clamps to the bounds", () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(100)).toBe(MAX_ZOOM);
  });

  it("falls back to the default for a non-finite value", () => {
    expect(clampZoom(Number.NaN)).toBe(DEFAULT_ZOOM);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(DEFAULT_ZOOM);
  });
});

describe("steppedZoom", () => {
  it("moves to the next stop up", () => {
    expect(steppedZoom(1, 1)).toBe(1.25);
    expect(steppedZoom(2, 1)).toBe(2.5);
  });

  it("moves to the next stop down", () => {
    expect(steppedZoom(1, -1)).toBe(0.75);
    expect(steppedZoom(2.5, -1)).toBe(2);
  });

  it("snaps a value between stops onto the neighbouring stop", () => {
    expect(steppedZoom(1.1, 1)).toBe(1.25);
    expect(steppedZoom(1.1, -1)).toBe(1);
  });

  it("stays put at the bounds", () => {
    expect(steppedZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(steppedZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });
});

describe("pinchZoom", () => {
  it("zooms in when the pinch delta is negative", () => {
    expect(pinchZoom(1, -50)).toBeGreaterThan(1);
  });

  it("zooms out when the pinch delta is positive", () => {
    expect(pinchZoom(1, 50)).toBeLessThan(1);
  });

  it("is symmetric: pinching back returns to the starting zoom", () => {
    expect(pinchZoom(pinchZoom(1, -40), 40)).toBeCloseTo(1, 10);
  });

  it("never leaves the allowed range", () => {
    expect(pinchZoom(MAX_ZOOM, -10000)).toBe(MAX_ZOOM);
    expect(pinchZoom(MIN_ZOOM, 10000)).toBe(MIN_ZOOM);
  });

  it("ignores a non-finite delta", () => {
    expect(pinchZoom(1.5, Number.NaN)).toBe(1.5);
  });
});

describe("zoomCommandForKey", () => {
  it("maps Cmd/Ctrl with +, - and 0", () => {
    expect(zoomCommandForKey({ key: "=", metaKey: true, ctrlKey: false })).toBe(
      "in",
    );
    expect(zoomCommandForKey({ key: "+", metaKey: false, ctrlKey: true })).toBe(
      "in",
    );
    expect(zoomCommandForKey({ key: "-", metaKey: true, ctrlKey: false })).toBe(
      "out",
    );
    expect(zoomCommandForKey({ key: "0", metaKey: true, ctrlKey: false })).toBe(
      "reset",
    );
  });

  it("ignores the same keys without a modifier", () => {
    expect(
      zoomCommandForKey({ key: "=", metaKey: false, ctrlKey: false }),
    ).toBeNull();
    expect(
      zoomCommandForKey({ key: "0", metaKey: false, ctrlKey: false }),
    ).toBeNull();
  });

  it("ignores other keys and Alt-modified combinations", () => {
    expect(
      zoomCommandForKey({ key: "a", metaKey: true, ctrlKey: false }),
    ).toBeNull();
    expect(
      zoomCommandForKey({
        key: "=",
        metaKey: true,
        ctrlKey: false,
        altKey: true,
      }),
    ).toBeNull();
  });
});

describe("applyZoomCommand", () => {
  it("steps up and down", () => {
    expect(applyZoomCommand(1, "in")).toBe(1.25);
    expect(applyZoomCommand(1, "out")).toBe(0.75);
  });

  it("resets to the default zoom from any level", () => {
    expect(applyZoomCommand(3, "reset")).toBe(DEFAULT_ZOOM);
    expect(applyZoomCommand(0.25, "reset")).toBe(DEFAULT_ZOOM);
  });
});
