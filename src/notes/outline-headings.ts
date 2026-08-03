/**
 * Turns a PDF's bookmark tree into markdown headings for the notes panel
 * (issue #46), and finds where in a note's text a given heading landed so the
 * editor's cursor can follow the reader from page to page.
 */

import type { OutlineNode } from "../pdf";
import { HEADING } from "./markdown";

/** Markdown only goes to `######`; deeper bookmarks flatten onto level 6. */
const MAX_HEADING_LEVEL = 6;

/**
 * The heading text a bookmark's title becomes: internal whitespace (line
 * breaks included) collapsed to single spaces, trimmed, and the same
 * placeholder {@link OutlineSidebar} shows for a blank title. Used both when
 * writing the heading ({@link formatOutlineHeadings}) and when looking for it
 * again to follow the reader's cursor — the two must agree, or a title with a
 * line break or no text at all would never be found.
 */
export function outlineHeadingTitle(title: string): string {
  const trimmed = title.replace(/\s+/g, " ").trim();
  return trimmed === "" ? "（無題）" : trimmed;
}

/**
 * Renders the outline as markdown headings in document order (DFS), one
 * blank line between entries. Empty input yields `""` so the caller can skip
 * inserting anything.
 */
export function formatOutlineHeadings(nodes: readonly OutlineNode[]): string {
  const lines: string[] = [];

  const walk = (items: readonly OutlineNode[], depth: number) => {
    for (const node of items) {
      const level = Math.min(depth + 1, MAX_HEADING_LEVEL);
      lines.push(`${"#".repeat(level)} ${outlineHeadingTitle(node.title)}`);
      walk(node.children, depth + 1);
    }
  };

  walk(nodes, 0);
  return lines.length === 0 ? "" : `${lines.join("\n\n")}\n`;
}

/**
 * The offset of the first heading line in `content` whose text matches
 * `title` (both compared trimmed), or null when there is no such line —
 * either the note never had one or the reader edited it away.
 */
export function findHeadingOffset(
  content: string,
  title: string,
): number | null {
  const target = title.trim();
  const lines = content.split("\n");
  let offset = 0;

  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading && heading[2] === target) return offset;
    offset += line.length + 1;
  }

  return null;
}
