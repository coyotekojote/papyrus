/**
 * A small markdown parser for the notes preview (issue #7).
 *
 * Notes are plain markdown files other tools have to be able to read, so the
 * preview only has to cover what someone actually writes while reading a
 * paper: headings, lists, quotes (the highlight extracts land as those), code,
 * emphasis and links. It produces a tree the React view walks — never an HTML
 * string — so a note can never inject markup into the app.
 *
 * Deliberately not supported: tables, reference links, raw HTML. They stay as
 * literal text rather than being silently swallowed. Nested lists are the one
 * exception: an item indented up to three spaces is flattened into the list
 * above it, which reads better than a stray `- ` mid-note. Deeper indentation
 * is not a list marker at all and does stay literal.
 */

export type Inline =
  | { kind: "text"; text: string }
  /** A single newline inside a paragraph, kept as a visible line break. */
  | { kind: "break" }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  /** href is null when the URL scheme is not one we are willing to open. */
  | { kind: "link"; href: string | null; children: Inline[] }
  /** src is null when the image cannot be shown; the alt text stands in. */
  | { kind: "image"; src: string | null; alt: string };

export type Block =
  | { kind: "heading"; level: number; children: Inline[] }
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "list"; ordered: boolean; start: number; items: Inline[][] }
  | { kind: "codeBlock"; lang: string | null; text: string }
  | { kind: "rule" };

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^ {0,3}(?:```|~~~)\s*(\S*)\s*$/;
const FENCE_END = /^ {0,3}(?:```|~~~)\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const BULLET = /^ {0,3}[-*+]\s+(.*)$/;
const ORDERED = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/;
const BLANK = /^\s*$/;

/** True for lines that end a paragraph by starting a block of their own. */
function startsBlock(line: string): boolean {
  return (
    HEADING.test(line) ||
    RULE.test(line) ||
    FENCE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line)
  );
}

export function parseMarkdown(source: string): Block[] {
  // \r\n would otherwise leave a stray \r at the end of every line.
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (BLANK.test(line)) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE_END.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      // An unterminated fence runs to the end of the note — that is what the
      // writer sees while still typing the block.
      index += 1;
      blocks.push({
        kind: "codeBlock",
        lang: fence[1] === "" ? null : fence[1],
        text: body.join("\n"),
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        children: parseInline(heading[2]),
      });
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index])) {
        inner.push(lines[index].replace(QUOTE, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", blocks: parseMarkdown(inner.join("\n")) });
      continue;
    }

    const list = parseList(lines, index);
    if (list) {
      blocks.push(list.block);
      index = list.next;
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      !BLANK.test(lines[index]) &&
      !startsBlock(lines[index])
    ) {
      // Only the trailing whitespace goes: a line's indentation is the one
      // thing left of an unsupported construct (an indented code block, say)
      // once it falls through to a paragraph, so it is kept verbatim.
      paragraph.push(lines[index].trimEnd());
      index += 1;
    }
    blocks.push({
      kind: "paragraph",
      children: parseInline(paragraph.join("\n")),
    });
  }

  return blocks;
}

/** Consecutive items of the same kind; the first number sets `start`. */
function parseList(
  lines: readonly string[],
  from: number,
): { block: Block; next: number } | null {
  const first = ORDERED.exec(lines[from]);
  const ordered = first !== null;
  if (!ordered && !BULLET.test(lines[from])) return null;

  const items: Inline[][] = [];
  let index = from;
  while (index < lines.length) {
    const match = ordered
      ? ORDERED.exec(lines[index])
      : BULLET.exec(lines[index]);
    if (!match) break;
    items.push(parseInline(ordered ? match[2] : match[1]));
    index += 1;
  }

  return {
    block: {
      kind: "list",
      ordered,
      start: ordered ? Number(first[1]) : 1,
      items,
    },
    next: index,
  };
}

const ESCAPABLE = "\\`*_[]()#+-.!>~";
const CODE_SPAN = /^(`+)([\s\S]+?)\1(?!`)/;
const STRONG = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/;
const EM = /^([*_])(?=\S)([\s\S]*?\S)\1/;
const LINK = /^\[([^\]]*)\]\(\s*([^()\s]*)\s*\)/;

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  let index = 0;

  const flush = () => {
    if (buffer !== "") {
      out.push({ kind: "text", text: buffer });
      buffer = "";
    }
  };

  while (index < source.length) {
    const char = source[index];
    const rest = source.slice(index);

    if (char === "\\" && ESCAPABLE.includes(source[index + 1] ?? "")) {
      buffer += source[index + 1];
      index += 2;
      continue;
    }

    if (char === "\n") {
      flush();
      out.push({ kind: "break" });
      index += 1;
      continue;
    }

    if (char === "`") {
      const code = CODE_SPAN.exec(rest);
      if (code) {
        flush();
        // One padding space on each side is the fence, not content: `` ` ``.
        out.push({ kind: "code", text: code[2].replace(/^ (.*) $/s, "$1") });
        index += code[0].length;
        continue;
      }
    }

    if (char === "!") {
      const image = LINK.exec(rest.slice(1));
      if (image) {
        flush();
        out.push({ kind: "image", src: imageSrc(image[2]), alt: image[1] });
        index += image[0].length + 1;
        continue;
      }
    }

    if (char === "[") {
      const link = LINK.exec(rest);
      if (link) {
        flush();
        out.push({
          kind: "link",
          href: linkHref(link[2]),
          children: parseInline(link[1]),
        });
        index += link[0].length;
        continue;
      }
    }

    if (char === "*" || char === "_") {
      const strong = STRONG.exec(rest);
      if (strong) {
        flush();
        out.push({ kind: "strong", children: parseInline(strong[2]) });
        index += strong[0].length;
        continue;
      }
      const em = EM.exec(rest);
      if (em) {
        flush();
        out.push({ kind: "em", children: parseInline(em[2]) });
        index += em[0].length;
        continue;
      }
    }

    buffer += char;
    index += 1;
  }

  flush();
  return out;
}

/**
 * Only schemes worth opening from a note. Anything else — `javascript:` above
 * all — is dropped and the link renders as plain text.
 */
export function linkHref(url: string): string | null {
  const trimmed = url.trim();
  return /^(https?:|mailto:)/i.test(trimmed) ? trimmed : null;
}

/**
 * Images have to be fetchable by the WebView. Sidecar-relative clips
 * (`clips/clip-0001.png`) are not, until issue #8 resolves them to asset URLs —
 * until then they show their alt text instead of a broken image.
 */
export function imageSrc(url: string): string | null {
  const trimmed = url.trim();
  return /^(https?:|data:image\/)/i.test(trimmed) ? trimmed : null;
}

/** Plain text of a tree, for tests and for the panel's empty-state check. */
export function inlineText(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case "text":
        case "code":
          return node.text;
        case "break":
          return "\n";
        case "image":
          return node.alt;
        default:
          return inlineText(node.children);
      }
    })
    .join("");
}
