import { describe, expect, it } from "vitest";
import { emptyAnnotations, type Clip } from "../files/sidecar";
import {
  addClip,
  formatClipImage,
  makeClip,
  marqueeBox,
  normalizeDragRect,
} from "./clips";

/** A page 400x800 CSS pixels, 100 in from the left and 50 down. */
const PAGE = { left: 100, top: 50, width: 400, height: 800 };

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: "clip-1",
    page: 5,
    rect: { x: 0.25, y: 0.125, w: 0.25, h: 0.25 },
    file: "clips/clip-0001.png",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("normalizeDragRect", () => {
  it("normalizes a drag against the page it was made on", () => {
    expect(
      normalizeDragRect({ x: 200, y: 150 }, { x: 300, y: 350 }, PAGE),
    ).toEqual({ x: 0.25, y: 0.125, w: 0.25, h: 0.25 });
  });

  it("gives the same rect when dragged the other way", () => {
    expect(
      normalizeDragRect({ x: 300, y: 350 }, { x: 200, y: 150 }, PAGE),
    ).toEqual({ x: 0.25, y: 0.125, w: 0.25, h: 0.25 });
  });

  it("cuts a drag that runs off the page at its edges", () => {
    expect(
      normalizeDragRect({ x: -200, y: -400 }, { x: 900, y: 1600 }, PAGE),
    ).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("refuses a drag too small to be a region", () => {
    // 2px of 400 and 2px of 800: a click that moved, not a selection.
    expect(
      normalizeDragRect({ x: 200, y: 150 }, { x: 202, y: 152 }, PAGE),
    ).toBeNull();
    // Wide enough, but flat.
    expect(
      normalizeDragRect({ x: 200, y: 150 }, { x: 350, y: 153 }, PAGE),
    ).toBeNull();
  });

  it("refuses a page with no area", () => {
    expect(
      normalizeDragRect(
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { left: 0, top: 0, width: 0, height: 800 },
      ),
    ).toBeNull();
  });

  it("rounds to four decimals so annotations.json stays readable", () => {
    expect(
      normalizeDragRect(
        { x: 0, y: 0 },
        { x: 1, y: 2 },
        { left: 0, top: 0, width: 3, height: 3 },
      ),
    ).toEqual({ x: 0, y: 0, w: 0.3333, h: 0.6667 });
  });
});

describe("marqueeBox", () => {
  /** The body element the marquee is mounted in, 40px down from the viewport. */
  const ORIGIN = { x: 0, y: 40 };

  it("places the rectangle relative to the mount point", () => {
    expect(
      marqueeBox({ x: 200, y: 150 }, { x: 300, y: 350 }, PAGE, ORIGIN),
    ).toEqual({ left: 200, top: 110, width: 100, height: 200 });
  });

  it("draws the same rectangle when dragged the other way", () => {
    expect(
      marqueeBox({ x: 300, y: 350 }, { x: 200, y: 150 }, PAGE, ORIGIN),
    ).toEqual({ left: 200, top: 110, width: 100, height: 200 });
  });

  it("stops at the page edges", () => {
    expect(
      marqueeBox({ x: -50, y: -50 }, { x: 900, y: 1600 }, PAGE, ORIGIN),
    ).toEqual({ left: 100, top: 10, width: 400, height: 800 });
  });
});

describe("makeClip", () => {
  it("stores the creation time as an ISO string", () => {
    const created = makeClip({
      page: 5,
      rect: { x: 0.25, y: 0.125, w: 0.25, h: 0.25 },
      file: "clips/clip-0001.png",
      createdAt: new Date("2026-08-01T00:00:00Z"),
      id: "clip-1",
    });

    expect(created).toEqual(clip());
  });

  it("generates an id when none is given", () => {
    const created = makeClip({
      page: 1,
      rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
      file: "clips/clip-0002.png",
      createdAt: new Date("2026-08-01T00:00:00Z"),
    });

    expect(created.id).not.toBe("");
    expect(typeof created.id).toBe("string");
  });
});

describe("addClip", () => {
  it("appends without touching the highlights", () => {
    const before = emptyAnnotations();
    const after = addClip(before, clip());

    expect(after.clips).toEqual([clip()]);
    expect(after.highlights).toEqual([]);
    // The annotations hook replays mutations onto reloaded documents, so a
    // mutation that edited its input in place would corrupt the replay.
    expect(before.clips).toEqual([]);
  });

  it("keeps the clips already in the document", () => {
    const first = clip();
    const second = clip({ id: "clip-2", file: "clips/clip-0002.png" });

    expect(addClip(addClip(emptyAnnotations(), first), second).clips).toEqual([
      first,
      second,
    ]);
  });
});

describe("formatClipImage", () => {
  it("writes a sidecar-relative image with the page in its alt text", () => {
    expect(formatClipImage(clip())).toBe("![p.5 の図](clips/clip-0001.png)");
  });
});
