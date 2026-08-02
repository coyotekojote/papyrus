import { describe, expect, it } from "vitest";
import { MAX_ZOOM, MIN_ZOOM } from "./zoom";
import { pinchZoomFromTouch, pointerDistance } from "./touch-pinch";

describe("pointerDistance", () => {
  it("measures the straight-line distance between two points", () => {
    expect(pointerDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it("is zero for coincident points", () => {
    expect(pointerDistance({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(0);
  });
});

describe("pinchZoomFromTouch", () => {
  it("leaves the zoom unchanged when the ratio is 1", () => {
    expect(pinchZoomFromTouch(1.5, 100, 100)).toBe(1.5);
  });

  it("zooms in as the fingers spread apart", () => {
    expect(pinchZoomFromTouch(1, 100, 200)).toBe(2);
  });

  it("zooms out as the fingers come together", () => {
    expect(pinchZoomFromTouch(2, 200, 100)).toBe(1);
  });

  it("clamps at the maximum zoom", () => {
    expect(pinchZoomFromTouch(MAX_ZOOM, 100, 1000)).toBe(MAX_ZOOM);
  });

  it("clamps at the minimum zoom", () => {
    expect(pinchZoomFromTouch(MIN_ZOOM, 100, 1)).toBe(MIN_ZOOM);
  });

  it("collapsing to a single point (currentDistance 0) hits the minimum zoom", () => {
    expect(pinchZoomFromTouch(1, 100, 0)).toBe(MIN_ZOOM);
  });

  it("a zero starting distance leaves the zoom where it started", () => {
    expect(pinchZoomFromTouch(1.5, 0, 200)).toBe(1.5);
  });

  it("a negative starting distance is treated the same as zero", () => {
    expect(pinchZoomFromTouch(1.5, -10, 200)).toBe(1.5);
  });

  it("a negative current distance is treated as zero, not a sign flip", () => {
    expect(pinchZoomFromTouch(1, 100, -50)).toBe(MIN_ZOOM);
  });

  it("a non-finite starting zoom falls back through clampZoom's default", () => {
    expect(pinchZoomFromTouch(Number.NaN, 100, 100)).toBe(1);
  });

  it("a non-finite current distance leaves the zoom where it started", () => {
    expect(pinchZoomFromTouch(1.5, 100, Number.NaN)).toBe(1.5);
    expect(pinchZoomFromTouch(1.5, 100, Number.POSITIVE_INFINITY)).toBe(1.5);
  });
});
