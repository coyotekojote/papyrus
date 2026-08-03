import { describe, expect, it } from "vitest";
import type { OutlineNode } from "../pdf";
import {
  findHeadingOffset,
  formatOutlineHeadings,
  outlineHeadingTitle,
} from "./outline-headings";

function node(overrides: Partial<OutlineNode> = {}): OutlineNode {
  return { title: "章", pageNumber: 1, children: [], ...overrides };
}

describe("formatOutlineHeadings", () => {
  it("returns an empty string for an empty outline", () => {
    expect(formatOutlineHeadings([])).toBe("");
  });

  it("renders top-level bookmarks as level-1 headings", () => {
    expect(
      formatOutlineHeadings([
        node({ title: "はじめに" }),
        node({ title: "まとめ" }),
      ]),
    ).toBe("# はじめに\n\n# まとめ\n");
  });

  it("deepens the heading level with nesting, DFS order", () => {
    const outline: OutlineNode[] = [
      node({
        title: "第1章",
        children: [
          node({ title: "1.1節" }),
          node({ title: "1.2節", children: [node({ title: "1.2.1項" })] }),
        ],
      }),
      node({ title: "第2章" }),
    ];

    expect(formatOutlineHeadings(outline)).toBe(
      "# 第1章\n\n## 1.1節\n\n## 1.2節\n\n### 1.2.1項\n\n# 第2章\n",
    );
  });

  it("caps the heading level at 6 for deeper nesting", () => {
    let outline: OutlineNode[] = [node({ title: "深さ7" })];
    for (let depth = 0; depth < 7; depth += 1) {
      outline = [node({ title: `深さ${6 - depth}`, children: outline })];
    }

    const lines = formatOutlineHeadings(outline).split("\n\n");
    expect(lines.at(-1)).toBe("###### 深さ7\n");
  });

  it("shows the OutlineSidebar placeholder for a blank title", () => {
    expect(formatOutlineHeadings([node({ title: "   " })])).toBe(
      "# （無題）\n",
    );
  });

  it("collapses newlines inside a title into spaces", () => {
    expect(formatOutlineHeadings([node({ title: "第1章\n導入編" })])).toBe(
      "# 第1章 導入編\n",
    );
  });
});

describe("outlineHeadingTitle", () => {
  it("collapses internal whitespace, including line breaks, to single spaces", () => {
    expect(outlineHeadingTitle("第1章\n導入編")).toBe("第1章 導入編");
    expect(outlineHeadingTitle("第1章   導入編")).toBe("第1章 導入編");
  });

  it("trims the ends", () => {
    expect(outlineHeadingTitle("  第1章  ")).toBe("第1章");
  });

  it("replaces a blank title with the OutlineSidebar placeholder", () => {
    expect(outlineHeadingTitle("   ")).toBe("（無題）");
    expect(outlineHeadingTitle("")).toBe("（無題）");
  });

  it("agrees with what formatOutlineHeadings writes, so the two can never drift", () => {
    for (const title of ["第1章\n導入編", "  空白だらけ  ", "", "\n\n"]) {
      const heading = formatOutlineHeadings([
        { title, pageNumber: 1, children: [] },
      ]);
      expect(heading).toBe(`# ${outlineHeadingTitle(title)}\n`);
    }
  });
});

describe("findHeadingOffset", () => {
  it("finds the offset of the first matching heading line", () => {
    const content = "前書き\n\n# 第1章\n\n本文\n\n## 1.1節\n";
    expect(findHeadingOffset(content, "第1章")).toBe(
      content.indexOf("# 第1章"),
    );
    expect(findHeadingOffset(content, "1.1節")).toBe(
      content.indexOf("## 1.1節"),
    );
  });

  it("matches the title trimmed on both sides", () => {
    const content = "# 第1章\n";
    expect(findHeadingOffset(content, "  第1章  ")).toBe(0);
  });

  it("returns null when no heading matches", () => {
    const content = "# 第1章\n\n本文\n";
    expect(findHeadingOffset(content, "第2章")).toBeNull();
  });

  it("returns null when the heading was edited into plain text", () => {
    const content = "第1章（見出しではなくなった）\n";
    expect(
      findHeadingOffset(content, "第1章（見出しではなくなった）"),
    ).toBeNull();
  });

  it("returns the first match when the same heading text repeats", () => {
    const content = "# 章\n\n本文\n\n# 章\n";
    expect(findHeadingOffset(content, "章")).toBe(0);
  });
});
