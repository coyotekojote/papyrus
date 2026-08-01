import { describe, expect, it } from "vitest";
import type { OutlineNode } from "../pdf";
import { activeOutlineId, flattenOutline, visibleActiveId } from "./outline";

function node(
  title: string,
  pageNumber: number | null,
  children: OutlineNode[] = [],
): OutlineNode {
  return { title, pageNumber, children };
}

/**
 * 1 序章        p1
 * 2 本論        p5
 *   2.1 前半    p5
 *   2.2 後半    p9
 *     2.2.1 補足 p11
 * 3 付録        null (unresolvable destination)
 */
const tree: OutlineNode[] = [
  node("序章", 1),
  node("本論", 5, [node("前半", 5), node("後半", 9, [node("補足", 11)])]),
  node("付録", null),
];

describe("flattenOutline", () => {
  it("returns nothing for a document without bookmarks", () => {
    expect(flattenOutline([])).toEqual([]);
  });

  it("lists every node in document order with its depth", () => {
    expect(
      flattenOutline(tree).map((row) => [row.id, row.title, row.depth]),
    ).toEqual([
      ["0", "序章", 0],
      ["1", "本論", 0],
      ["1.0", "前半", 1],
      ["1.1", "後半", 1],
      ["1.1.0", "補足", 2],
      ["2", "付録", 0],
    ]);
  });

  it("marks which rows have children and whether they are open", () => {
    const rows = flattenOutline(tree, new Set(["1.1"]));

    expect(rows.map((row) => [row.id, row.hasChildren, row.expanded])).toEqual([
      ["0", false, false],
      ["1", true, true],
      ["1.0", false, false],
      ["1.1", true, false],
      ["2", false, false],
    ]);
  });

  it("hides a collapsed node's whole subtree, not just its direct children", () => {
    const ids = flattenOutline(tree, new Set(["1"])).map((row) => row.id);

    expect(ids).toEqual(["0", "1", "2"]);
  });

  it("keeps a node with an unresolved destination in the tree", () => {
    const appendix = flattenOutline(tree).find((row) => row.id === "2");

    expect(appendix).toMatchObject({ title: "付録", pageNumber: null });
  });

  it("gives every node of a deeply nested tree a distinct path id", () => {
    const depth = 12;
    let deepest = node("leaf", depth);
    for (let level = depth - 1; level >= 1; level -= 1) {
      deepest = node(`level ${level}`, level, [deepest]);
    }

    const rows = flattenOutline([deepest]);

    expect(rows).toHaveLength(depth);
    expect(rows.at(-1)).toMatchObject({
      id: "0.0.0.0.0.0.0.0.0.0.0.0",
      depth: 11,
    });
    expect(new Set(rows.map((row) => row.id)).size).toBe(depth);
  });
});

describe("activeOutlineId", () => {
  it("has no active section before the first bookmark's page", () => {
    expect(activeOutlineId([node("第2章", 4)], 1)).toBeNull();
  });

  it("activates a bookmark exactly on its own first page", () => {
    expect(activeOutlineId(tree, 1)).toBe("0");
  });

  it("prefers the deepest section that has already started", () => {
    expect(activeOutlineId(tree, 5)).toBe("1.0");
    expect(activeOutlineId(tree, 9)).toBe("1.1");
    expect(activeOutlineId(tree, 10)).toBe("1.1");
    expect(activeOutlineId(tree, 11)).toBe("1.1.0");
  });

  it("stays on the last started section past the end of the outline", () => {
    expect(activeOutlineId(tree, 999)).toBe("1.1.0");
  });

  it("never activates a bookmark whose destination is unresolved", () => {
    const nodes = [node("序章", 1), node("付録", null)];

    expect(activeOutlineId(nodes, 50)).toBe("0");
  });

  it("still reaches children of an unresolved parent", () => {
    const nodes = [node("付録", null, [node("付録A", 3)])];

    expect(activeOutlineId(nodes, 4)).toBe("0.0");
  });

  it("returns null for an empty outline", () => {
    expect(activeOutlineId([], 7)).toBeNull();
  });
});

describe("visibleActiveId", () => {
  it("highlights the active row when it is on screen", () => {
    const rows = flattenOutline(tree);

    expect(visibleActiveId(rows, "1.1.0")).toBe("1.1.0");
  });

  it("falls back to the nearest visible ancestor of a hidden row", () => {
    const rows = flattenOutline(tree, new Set(["1.1"]));

    expect(visibleActiveId(rows, "1.1.0")).toBe("1.1");
  });

  it("walks up more than one level when several ancestors are collapsed", () => {
    const rows = flattenOutline(tree, new Set(["1"]));

    expect(visibleActiveId(rows, "1.1.0")).toBe("1");
  });

  it("highlights nothing when there is no active section", () => {
    expect(visibleActiveId(flattenOutline(tree), null)).toBeNull();
  });
});
