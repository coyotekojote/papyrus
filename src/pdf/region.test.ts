import { describe, expect, it } from "vitest";
import { clampRegion } from "./region";

describe("clampRegion", () => {
  it("leaves a rect that is already inside the page alone", () => {
    expect(clampRegion({ x: 0.125, y: 0.25, w: 0.5, h: 0.25 })).toEqual({
      x: 0.125,
      y: 0.25,
      w: 0.5,
      h: 0.25,
    });
  });

  it("normalizes a rect dragged up and to the left", () => {
    expect(clampRegion({ x: 0.75, y: 0.5, w: -0.25, h: -0.25 })).toEqual({
      x: 0.5,
      y: 0.25,
      w: 0.25,
      h: 0.25,
    });
  });

  it("cuts the part that hangs off the page", () => {
    expect(clampRegion({ x: -0.25, y: 0.5, w: 0.5, h: 0.75 })).toEqual({
      x: 0,
      y: 0.5,
      w: 0.25,
      h: 0.5,
    });
  });

  it("collapses a rect that is entirely off the page", () => {
    expect(clampRegion({ x: 1.5, y: 2, w: 0.5, h: 0.5 })).toEqual({
      x: 1,
      y: 1,
      w: 0,
      h: 0,
    });
  });

  it("collapses a rect with no extent", () => {
    expect(clampRegion({ x: 0.5, y: 0.5, w: 0, h: 0 })).toEqual({
      x: 0.5,
      y: 0.5,
      w: 0,
      h: 0,
    });
  });

  it("collapses a NaN axis instead of passing it through to the canvas", () => {
    expect(clampRegion({ x: Number.NaN, y: 0.25, w: 0.5, h: 0.5 })).toEqual({
      x: 0,
      y: 0.25,
      w: 0,
      h: 0.5,
    });
    expect(clampRegion({ x: 0.25, y: 0.25, w: 0.5, h: Number.NaN })).toEqual({
      x: 0.25,
      y: 0,
      w: 0.5,
      h: 0,
    });
  });

  it("clamps an infinite extent to the page edge", () => {
    expect(
      clampRegion({
        x: 0.25,
        y: 0.25,
        w: Number.POSITIVE_INFINITY,
        h: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({ x: 0.25, y: 0.25, w: 0.75, h: 0.75 });
  });
});
