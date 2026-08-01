import { describe, expect, it } from "vitest";
import {
  imageSrc,
  inlineText,
  linkHref,
  parseInline,
  parseMarkdown,
  type Block,
} from "./markdown";

function only(source: string): Block {
  const blocks = parseMarkdown(source);
  expect(blocks).toHaveLength(1);
  return blocks[0];
}

describe("parseMarkdown", () => {
  it("returns nothing for an empty or blank note", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n   \n\n")).toEqual([]);
  });

  it("parses headings with their level", () => {
    expect(only("### 読んだところ")).toEqual({
      kind: "heading",
      level: 3,
      children: [{ kind: "text", text: "読んだところ" }],
    });
    expect(only("###### h6").kind).toBe("heading");
    // Seven hashes is no longer a heading.
    expect(only("####### too deep").kind).toBe("paragraph");
    // A hash without a space is not a heading either.
    expect(only("#tag").kind).toBe("paragraph");
  });

  it("keeps a single newline inside a paragraph as a line break", () => {
    expect(only("一行目\n二行目")).toEqual({
      kind: "paragraph",
      children: [
        { kind: "text", text: "一行目" },
        { kind: "break" },
        { kind: "text", text: "二行目" },
      ],
    });
  });

  it("splits paragraphs on a blank line", () => {
    expect(parseMarkdown("前\n\n後").map((block) => block.kind)).toEqual([
      "paragraph",
      "paragraph",
    ]);
  });

  it("parses a bullet list", () => {
    expect(only("- one\n* two\n+ three")).toEqual({
      kind: "list",
      ordered: false,
      start: 1,
      items: [
        [{ kind: "text", text: "one" }],
        [{ kind: "text", text: "two" }],
        [{ kind: "text", text: "three" }],
      ],
    });
  });

  it("parses an ordered list and keeps its first number", () => {
    const block = only("3. three\n4. four");
    expect(block).toMatchObject({ kind: "list", ordered: true, start: 3 });
    expect(block.kind === "list" && block.items).toHaveLength(2);
  });

  it("flattens a shallowly nested item into the list above it", () => {
    const block = only("- one\n  - nested");
    expect(block).toMatchObject({ kind: "list", ordered: false });
    expect(block.kind === "list" && block.items.map(inlineText)).toEqual([
      "one",
      "nested",
    ]);
  });

  it("leaves a deeply indented item as literal text", () => {
    // Four spaces is not a list marker here, so the line is not swallowed.
    const blocks = parseMarkdown("- one\n    - too deep");
    expect(blocks.map((block) => block.kind)).toEqual(["list", "paragraph"]);
    expect(
      blocks[1].kind === "paragraph" && inlineText(blocks[1].children),
    ).toBe("- too deep");
  });

  it("ends a paragraph when a list starts without a blank line", () => {
    expect(parseMarkdown("メモ\n- one").map((block) => block.kind)).toEqual([
      "paragraph",
      "list",
    ]);
  });

  it("parses a blockquote, including the highlight extract format", () => {
    expect(only("> 引用された本文\n>\n> — p.12")).toEqual({
      kind: "quote",
      blocks: [
        {
          kind: "paragraph",
          children: [{ kind: "text", text: "引用された本文" }],
        },
        { kind: "paragraph", children: [{ kind: "text", text: "— p.12" }] },
      ],
    });
  });

  it("nests a quote inside a quote", () => {
    const block = only("> > 深い");
    expect(block).toMatchObject({
      kind: "quote",
      blocks: [{ kind: "quote" }],
    });
  });

  it("parses a fenced code block with its language", () => {
    expect(only("```ts\nconst a = 1;\n\nconst b = 2;\n```")).toEqual({
      kind: "codeBlock",
      lang: "ts",
      text: "const a = 1;\n\nconst b = 2;",
    });
  });

  it("runs an unterminated fence to the end of the note", () => {
    expect(only("```\n書きかけ")).toEqual({
      kind: "codeBlock",
      lang: null,
      text: "書きかけ",
    });
  });

  it("does not parse markdown inside a code block", () => {
    expect(only("```\n# not a heading\n```")).toMatchObject({
      text: "# not a heading",
    });
  });

  it("parses a horizontal rule but not a lone dash", () => {
    expect(only("---")).toEqual({ kind: "rule" });
    expect(only("- item").kind).toBe("list");
  });

  it("normalizes CRLF line endings", () => {
    const blocks = parseMarkdown("# 見出し\r\n\r\n本文");
    expect(blocks.map((block) => block.kind)).toEqual(["heading", "paragraph"]);
    // A stray \r would survive as part of the heading text.
    expect(blocks[0].kind === "heading" && inlineText(blocks[0].children)).toBe(
      "見出し",
    );
  });
});

describe("parseInline", () => {
  it("parses bold and italic", () => {
    expect(parseInline("**強い**と*斜め*")).toEqual([
      { kind: "strong", children: [{ kind: "text", text: "強い" }] },
      { kind: "text", text: "と" },
      { kind: "em", children: [{ kind: "text", text: "斜め" }] },
    ]);
  });

  it("parses markup nested inside bold", () => {
    expect(parseInline("**強い`コード`**")).toEqual([
      {
        kind: "strong",
        children: [
          { kind: "text", text: "強い" },
          { kind: "code", text: "コード" },
        ],
      },
    ]);
  });

  it("leaves an unclosed marker as literal text", () => {
    expect(parseInline("2 * 3 = 6")).toEqual([
      { kind: "text", text: "2 * 3 = 6" },
    ]);
  });

  it("parses a code span and strips its fence padding", () => {
    expect(parseInline("``a ` b``")).toEqual([{ kind: "code", text: "a ` b" }]);
    expect(parseInline("`` ` ``")).toEqual([{ kind: "code", text: "`" }]);
  });

  it("does not parse emphasis inside a code span", () => {
    expect(parseInline("`**raw**`")).toEqual([
      { kind: "code", text: "**raw**" },
    ]);
  });

  it("parses a link", () => {
    expect(parseInline("[論文](https://example.com/a.pdf)")).toEqual([
      {
        kind: "link",
        href: "https://example.com/a.pdf",
        children: [{ kind: "text", text: "論文" }],
      },
    ]);
  });

  it("drops the href of a scheme it will not open", () => {
    expect(parseInline("[危険](javascript:alert`1`)")).toMatchObject([
      { kind: "link", href: null },
    ]);
  });

  it("parses an image and keeps its alt text", () => {
    expect(parseInline("![図1](https://example.com/f.png)")).toEqual([
      { kind: "image", src: "https://example.com/f.png", alt: "図1" },
    ]);
  });

  it("keeps a sidecar-relative image as alt text only", () => {
    expect(parseInline("![図2](clips/clip-0001.png)")).toEqual([
      { kind: "image", src: null, alt: "図2" },
    ]);
  });

  it("honours backslash escapes", () => {
    expect(parseInline("\\*not italic\\*")).toEqual([
      { kind: "text", text: "*not italic*" },
    ]);
    // A backslash before an ordinary character stays literal.
    expect(parseInline("C:\\path")).toEqual([
      { kind: "text", text: "C:\\path" },
    ]);
  });
});

describe("linkHref / imageSrc", () => {
  it("accepts http, https and mailto links", () => {
    expect(linkHref("http://a.test")).toBe("http://a.test");
    expect(linkHref("HTTPS://a.test")).toBe("HTTPS://a.test");
    expect(linkHref("mailto:a@b.test")).toBe("mailto:a@b.test");
  });

  it("rejects everything else, whitespace tricks included", () => {
    expect(linkHref("javascript:alert(1)")).toBeNull();
    expect(linkHref("  JaVaScRiPt:alert(1)")).toBeNull();
    expect(linkHref("data:text/html,<script>")).toBeNull();
    expect(linkHref("./notes.md")).toBeNull();
  });

  it("accepts only fetchable image sources", () => {
    expect(imageSrc("https://a.test/f.png")).toBe("https://a.test/f.png");
    expect(imageSrc("data:image/png;base64,AAAA")).toBe(
      "data:image/png;base64,AAAA",
    );
    expect(imageSrc("data:text/html,<script>")).toBeNull();
    expect(imageSrc("clips/clip-0001.png")).toBeNull();
  });
});

describe("inlineText", () => {
  it("flattens a tree back to its text", () => {
    expect(inlineText(parseInline("**a** `b` [c](https://d.test)\ne"))).toBe(
      "a b c\ne",
    );
  });
});
