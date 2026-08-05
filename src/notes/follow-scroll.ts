/**
 * Scrolling a heading into view inside the notes editor (#46).
 *
 * A textarea exposes no per-line geometry, so the only way to know where a
 * character sits vertically is to lay the same text out again somewhere that
 * does. Estimating it instead — `scrollHeight / lineCount` for an average line
 * height — holds only while every logical line occupies exactly one visual
 * one, which the default outline insertion breaks immediately: its headings
 * carry a full section title and wrap two or three times in a panel-width box,
 * so the average comes out well above the real line height and the error
 * compounds the further down the note the target sits.
 */

/**
 * Styles that decide where the text breaks. Copied onto the mirror so it wraps
 * exactly where the textarea does — miss one and the measurement silently
 * drifts rather than failing.
 */
const WRAPPING_STYLES = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "letterSpacing",
  "lineHeight",
  "textIndent",
  "textTransform",
  "wordSpacing",
  "wordBreak",
  "overflowWrap",
  "tabSize",
] as const;

/**
 * Distance in pixels from the top of `textarea`'s text to the line `offset`
 * falls on, and the height of that line. Null when the browser reports no
 * layout at all — jsdom, or a textarea that is not displayed — which is the
 * signal to leave the scroll position alone rather than jump to the top.
 */
function measureLine(
  textarea: HTMLTextAreaElement,
  offset: number,
): { top: number; lineHeight: number } | null {
  const doc = textarea.ownerDocument;
  const view = doc.defaultView;
  if (!view) return null;

  const computed = view.getComputedStyle(textarea);
  // `clientWidth` covers the padding box; the text wraps inside the content
  // box, so the padding comes off. The mirror is then given no padding or
  // border of its own — carrying them over as well would narrow its content
  // box by the border and wrap the text a little earlier than the textarea
  // does, and would offset every measurement by the padding on top.
  const width =
    textarea.clientWidth -
    (Number.parseFloat(computed.paddingLeft) || 0) -
    (Number.parseFloat(computed.paddingRight) || 0);
  if (width <= 0) return null;

  const mirror = doc.createElement("div");
  for (const name of WRAPPING_STYLES) {
    mirror.style[name] = computed[name];
  }
  // The textarea's own wrapping behaviour, which `white-space` on the element
  // does not necessarily report.
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  // Laid out at the same content width, but free to grow downwards and kept
  // out of the way — `visibility` rather than `display: none`, which would
  // give every measurement zero.
  mirror.style.boxSizing = "content-box";
  mirror.style.padding = "0";
  mirror.style.border = "0";
  mirror.style.width = `${width}px`;
  mirror.style.height = "auto";
  mirror.style.position = "absolute";
  mirror.style.top = "0";
  mirror.style.left = "0";
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.overflow = "hidden";

  // A zero-width marker at the target: its box is on the line the character
  // at `offset` starts, which is what has to come into view.
  const marker = doc.createElement("span");
  marker.textContent = "​";
  mirror.textContent = textarea.value.slice(0, offset);
  mirror.append(marker);

  doc.body.append(mirror);
  try {
    // How tall the marker's own inline box is — the glyph area, not the line
    // box the `line-height` spaces out.
    const inlineHeight = marker.offsetHeight;
    const lineHeight =
      Number.parseFloat(computed.lineHeight) ||
      inlineHeight ||
      Number.parseFloat(computed.fontSize) * 1.2 ||
      0;
    if (lineHeight === 0) return null;
    // `offsetTop` is the top of that inline box, which `line-height` centres
    // inside the line box — so it sits half the leading below where the line
    // actually starts. Without taking that back off, every jump lands a
    // fraction of a line low, which at this file's 1.7 line-height is a
    // visible half-line.
    const halfLeading = Math.max(0, (lineHeight - inlineHeight) / 2);
    // The mirror has no padding of its own, so what is left is the distance
    // from the start of the text, which is exactly what `scrollTop` counts
    // from.
    const top = marker.offsetTop - halfLeading;
    return { top: Math.max(0, top), lineHeight };
  } finally {
    mirror.remove();
  }
}

/**
 * Scrolls `textarea` so the line containing `offset` is visible, one line down
 * from the top edge so the heading does not sit flush against it.
 *
 * Does nothing when the position cannot be measured, which leaves the reader
 * looking at wherever they already were — better than scrolling somewhere
 * arbitrary.
 */
export function scrollOffsetIntoView(
  textarea: HTMLTextAreaElement,
  offset: number,
): void {
  const measured = measureLine(textarea, offset);
  if (!measured) return;
  textarea.scrollTop = Math.max(0, measured.top - measured.lineHeight);
}
