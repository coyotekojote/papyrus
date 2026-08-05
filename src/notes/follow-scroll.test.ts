import { afterEach, describe, expect, it } from "vitest";
import { scrollOffsetIntoView } from "./follow-scroll";

/**
 * jsdom lays nothing out, so the geometry the measurement reads back is
 * stubbed here: `clientWidth` on the textarea (its presence is what says the
 * box is displayed at all) and the marker span's `offsetTop`/`offsetHeight`
 * (where the target line landed, and how tall a line is). The arithmetic
 * between those and the resulting `scrollTop` is the part worth pinning —
 * whether a real browser wraps the text where the mirror does is not
 * something jsdom can answer either way.
 */
const patched: (() => void)[] = [];

function stub(
  prototype: object,
  property: string,
  get: (this: HTMLElement) => number,
) {
  const original = Object.getOwnPropertyDescriptor(prototype, property);
  Object.defineProperty(prototype, property, { configurable: true, get });
  patched.push(() => {
    if (original) Object.defineProperty(prototype, property, original);
    else Reflect.deleteProperty(prototype, property);
  });
}

/** A textarea wide enough to be considered laid out, with the given padding. */
function editor(value: string, paddingTop = "0px") {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.paddingTop = paddingTop;
  document.body.append(textarea);
  patched.push(() => textarea.remove());
  return textarea;
}

/** Pretends the marker span landed `top` pixels down, on a `height`px line. */
function layout({
  width = 400,
  top = 0,
  height = 20,
}: { width?: number; top?: number; height?: number } = {}) {
  stub(HTMLTextAreaElement.prototype, "clientWidth", () => width);
  stub(HTMLSpanElement.prototype, "offsetTop", () => top);
  stub(HTMLSpanElement.prototype, "offsetHeight", () => height);
}

/**
 * The width the measurement laid its mirror out at. Captured by watching what
 * gets appended to the body, since the element is removed again before
 * `scrollOffsetIntoView` returns.
 */
let lastMirrorWidth: string | null = null;
const widthOfLastMirror = () => lastMirrorWidth;

function watchMirror() {
  const original = document.body.append.bind(document.body);
  const spy: typeof document.body.append = (...nodes) => {
    for (const node of nodes) {
      if (node instanceof HTMLDivElement) lastMirrorWidth = node.style.width;
    }
    original(...nodes);
  };
  document.body.append = spy;
  patched.push(() => {
    document.body.append = original;
  });
}

afterEach(() => {
  lastMirrorWidth = null;
  while (patched.length > 0) patched.pop()?.();
});

describe("scrollOffsetIntoView", () => {
  it("scrolls to the measured line, one line above it", () => {
    layout({ top: 300, height: 20 });
    const textarea = editor("見出し\n本文");

    scrollOffsetIntoView(textarea, 4);

    expect(textarea.scrollTop).toBe(280);
  });

  it("does not let the editor's padding shift the target", () => {
    // The mirror is given no padding of its own, so `offsetTop` is already
    // measured from the start of the text — the same place `scrollTop` counts
    // from. Adding the editor's padding on top would push every jump down by
    // it.
    layout({ top: 300, height: 20 });
    const textarea = editor("見出し\n本文", "12px");

    scrollOffsetIntoView(textarea, 4);

    expect(textarea.scrollTop).toBe(280);
  });

  it("measures at the editor's content width, not its padding box", () => {
    // The text wraps inside the content box; measuring at the wider padding
    // box would wrap later than the editor does and report the target too
    // high up.
    layout({ width: 400 });
    watchMirror();
    const textarea = editor("見出し\n本文", "0px");
    textarea.style.paddingLeft = "10px";
    textarea.style.paddingRight = "6px";

    scrollOffsetIntoView(textarea, 4);

    const mirrorWidth = widthOfLastMirror();
    expect(mirrorWidth).toBe("384px");
  });

  it("lands on the line's top, not part way down it", () => {
    // `line-height` spaces the line box out around the glyphs, so the marker's
    // own box starts half that leading below where the line does. Counting
    // from the marker alone would drop every jump by that much — half a line
    // at the editor's own 1.7 line-height.
    layout({ top: 300, height: 20 });
    const textarea = editor("見出し\n本文");
    textarea.style.lineHeight = "30px";

    scrollOffsetIntoView(textarea, 4);

    // 300 - (30 - 20) / 2 = 295 for the line's top, then a line of context.
    expect(textarea.scrollTop).toBe(265);
  });

  it("clamps to the top rather than scrolling to a negative offset", () => {
    layout({ top: 5, height: 20 });
    const textarea = editor("見出し");

    scrollOffsetIntoView(textarea, 0);

    expect(textarea.scrollTop).toBe(0);
  });

  it("leaves the scroll position alone when nothing can be measured", () => {
    // Width 0 is an editor that is not displayed — a hidden panel, or jsdom
    // with no layout at all. Scrolling to a guessed position would throw away
    // wherever the reader actually was.
    layout({ width: 0, top: 300 });
    const textarea = editor("見出し\n本文");
    textarea.scrollTop = 120;

    scrollOffsetIntoView(textarea, 4);

    expect(textarea.scrollTop).toBe(120);
  });

  it("does not leave the element it measured with in the document", () => {
    layout({ top: 300 });
    const textarea = editor("見出し\n本文");
    const before = document.body.childElementCount;

    scrollOffsetIntoView(textarea, 4);

    expect(document.body.childElementCount).toBe(before);
  });
});
