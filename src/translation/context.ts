/**
 * The text around a selection, which is what makes an LLM translation of a
 * fragment read correctly (issue #10): a lone clause has no way to say which
 * sense of a word applies, or what "it" refers to.
 *
 * Taken from the page's own text layer rather than from the PDF, so it is
 * exactly the text the reader is looking at.
 */

/** Characters taken from each side. The backend trims further if it wants to. */
export const CONTEXT_CHARS = 400;

export interface SelectionContext {
  before: string;
  after: string;
}

export const NO_CONTEXT: SelectionContext = { before: "", after: "" };

/** The last `limit` characters — the ones nearest the selection. */
function tail(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(text.length - limit);
}

function head(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit);
}

/**
 * The text of `container` on either side of `range`.
 *
 * Both sides are read as ranges rather than by string offsets: the text layer
 * is a pile of positioned spans, and finding an offset inside it would mean
 * walking the same nodes the DOM already walks. A range that starts or ends
 * outside the container yields no context rather than throwing — the caller
 * should still get its translation, just without the hint.
 */
export function surroundingText(
  range: Range,
  container: Node,
  limit: number = CONTEXT_CHARS,
): SelectionContext {
  if (
    !container.contains(range.startContainer) ||
    !container.contains(range.endContainer)
  ) {
    return NO_CONTEXT;
  }
  try {
    const before = range.cloneRange();
    before.selectNodeContents(container);
    before.setEnd(range.startContainer, range.startOffset);

    const after = range.cloneRange();
    after.selectNodeContents(container);
    after.setStart(range.endContainer, range.endOffset);

    return {
      before: tail(before.toString(), limit),
      after: head(after.toString(), limit),
    };
  } catch {
    // Offsets that no longer address the node they came from, most likely
    // because the page re-rendered under the selection.
    return NO_CONTEXT;
  }
}
