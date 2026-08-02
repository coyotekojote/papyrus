import { describe, expect, it } from "vitest";
import { CONTEXT_CHARS, NO_CONTEXT, surroundingText } from "./context";

/** A stand-in for pdf.js's text layer: one positioned span per line. */
function textLayer(...lines: string[]): HTMLElement {
  const layer = document.createElement("div");
  layer.className = "textLayer";
  for (const line of lines) {
    const span = document.createElement("span");
    span.textContent = line;
    layer.append(span);
  }
  document.body.append(layer);
  return layer;
}

/** Selects `text` inside the `index`-th span of the layer. */
function selectWithin(layer: HTMLElement, index: number, text: string): Range {
  const node = layer.children[index].firstChild as Text;
  const start = node.data.indexOf(text);
  if (start < 0) throw new Error(`${text} is not in span ${index}`);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + text.length);
  return range;
}

describe("surroundingText", () => {
  it("takes the page's own text from either side of the selection", () => {
    const layer = textLayer("The Transformer is ", "attention", " based.");

    const context = surroundingText(selectWithin(layer, 1, "attention"), layer);

    expect(context).toEqual({
      before: "The Transformer is ",
      after: " based.",
    });
  });

  it("splits a span the selection sits in the middle of", () => {
    const layer = textLayer("before SELECTED after");

    const context = surroundingText(selectWithin(layer, 0, "SELECTED"), layer);

    expect(context).toEqual({ before: "before ", after: " after" });
  });

  it("keeps the part of the context nearest the selection", () => {
    const layer = textLayer(
      `${"x".repeat(CONTEXT_CHARS)}near-before `,
      "selected",
      ` near-after${"y".repeat(CONTEXT_CHARS)}`,
    );

    const context = surroundingText(selectWithin(layer, 1, "selected"), layer);

    expect(context.before).toHaveLength(CONTEXT_CHARS);
    expect(context.before.endsWith("near-before ")).toBe(true);
    expect(context.after).toHaveLength(CONTEXT_CHARS);
    expect(context.after.startsWith(" near-after")).toBe(true);
  });

  it("honours a caller's own limit", () => {
    const layer = textLayer("abcdefghij", "selected", "klmnopqrst");

    const context = surroundingText(
      selectWithin(layer, 1, "selected"),
      layer,
      4,
    );

    expect(context).toEqual({ before: "ghij", after: "klmn" });
  });

  it("gives an empty side when there is nothing on it", () => {
    const layer = textLayer("selected only");

    const context = surroundingText(
      selectWithin(layer, 0, "selected only"),
      layer,
    );

    expect(context).toEqual(NO_CONTEXT);
  });

  it("gives no context for a selection outside the container", () => {
    const layer = textLayer("page text");
    const elsewhere = textLayer("another page");

    // A selection that ran off this page: normalizing it against this layer
    // would put text the reader never selected into the prompt.
    expect(
      surroundingText(selectWithin(elsewhere, 0, "another"), layer),
    ).toEqual(NO_CONTEXT);
  });
});
