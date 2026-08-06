/**
 * Bottom padding that lets the notes editor scroll its very last line up to
 * where the reader can actually see it (issue #74).
 *
 * `scrollOffsetIntoView` (follow-scroll.ts) lands a followed heading one line
 * below the top edge, at `scrollTop = top - lineHeight`. The browser clamps
 * `scrollTop` to `scrollHeight - clientHeight`, and for a heading that falls
 * on (or near) the textarea's last line, that ceiling sits *below* the target
 * — the natural content simply runs out before the target scroll position
 * does. Measured on a real device: `scrollHeight` 2835, `clientHeight` 689,
 * ceiling 2146 — the assignment landed exactly on the ceiling and the
 * textarea never moved, silently, because the caret of an unfocused textarea
 * draws no visible cursor to notice the miss by.
 *
 * The fix is the one editors with "scroll past the end" support all use:
 * pad the scrollable area past its natural content so the ceiling always has
 * enough room above the true text. WebKit counts a textarea's own
 * `padding-bottom` towards `scrollHeight` (i.e. it is itself scrollable), so
 * growing it directly raises the ceiling without changing where any real
 * line of text sits.
 */

/**
 * How much `padding-bottom` (px) a textarea needs so `scrollTop` can reach
 * `top - lineHeight` even for a heading on its very last line.
 *
 * Derivation: let `content` be the textarea's unpadded content height. The
 * worst case is a heading on the last line, whose own `top` is about
 * `content - lineHeight`, so the target scroll position is about
 * `content - 2 * lineHeight`. The browser's own ceiling is
 * `scrollHeight - clientHeight`, and `scrollHeight` is
 * `content + paddingTop + paddingBottom` (no border on this element).
 * Requiring the ceiling to reach the target and solving for `paddingBottom`
 * cancels `content` out entirely — the padding needed does not depend on how
 * long the note is, only on the textarea's own visible height:
 *
 *     paddingBottom >= clientHeight - paddingTop - 2 * lineHeight
 *
 * Never returns less than `paddingTop`, so a short note (where the formula
 * above goes negative) still gets the panel's designed, symmetric padding
 * rather than none at all.
 */
export function scrollPastEndPadding(
  clientHeight: number,
  lineHeight: number,
  paddingTop: number,
): number {
  const safePaddingTop = Number.isFinite(paddingTop)
    ? Math.max(0, paddingTop)
    : 0;
  if (
    !Number.isFinite(clientHeight) ||
    !Number.isFinite(lineHeight) ||
    lineHeight <= 0
  ) {
    return safePaddingTop;
  }
  const needed = clientHeight - safePaddingTop - 2 * lineHeight;
  return Math.max(safePaddingTop, needed);
}
