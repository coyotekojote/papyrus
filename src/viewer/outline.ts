import type { OutlineNode } from "../pdf";

/** One line of the rendered outline tree. */
export interface OutlineRow {
  /** Stable id derived from the node's path in the tree, e.g. `"0.2.1"`. */
  id: string;
  title: string;
  pageNumber: number | null;
  /** 0 for top-level bookmarks. */
  depth: number;
  hasChildren: boolean;
  /** False when the node has children and they are hidden. */
  expanded: boolean;
}

function childId(parentId: string, index: number): string {
  return parentId === "" ? String(index) : `${parentId}.${index}`;
}

/**
 * Flattens the bookmark tree into the rows to display, skipping the subtrees of
 * collapsed nodes. Ids are path-derived, so they survive re-renders without the
 * nodes having to carry identity themselves.
 */
export function flattenOutline(
  nodes: readonly OutlineNode[],
  collapsed: ReadonlySet<string> = new Set(),
): OutlineRow[] {
  const rows: OutlineRow[] = [];

  const walk = (
    items: readonly OutlineNode[],
    parentId: string,
    depth: number,
  ) => {
    items.forEach((node, index) => {
      const id = childId(parentId, index);
      const hasChildren = node.children.length > 0;
      const expanded = hasChildren && !collapsed.has(id);
      rows.push({
        id,
        title: node.title,
        pageNumber: node.pageNumber,
        depth,
        hasChildren,
        expanded,
      });
      if (expanded) walk(node.children, id, depth + 1);
    });
  };

  walk(nodes, "", 0);
  return rows;
}

/**
 * The bookmark the reader is currently inside: the last one in document order
 * whose page has already been reached.
 *
 * Returns null while the reader is still before the first bookmark. Nodes with
 * an unresolved destination cannot bound a section and are skipped, but their
 * children are still considered.
 */
export function activeOutlineId(
  nodes: readonly OutlineNode[],
  currentPage: number,
): string | null {
  let active: string | null = null;

  const walk = (items: readonly OutlineNode[], parentId: string) => {
    items.forEach((node, index) => {
      const id = childId(parentId, index);
      if (node.pageNumber !== null && node.pageNumber <= currentPage) {
        active = id;
      }
      walk(node.children, id);
    });
  };

  walk(nodes, "");
  return active;
}

/**
 * Which row to highlight for an active node. When the active node itself is
 * hidden inside a collapsed parent, the highlight moves up to the nearest
 * ancestor that is on screen, so the reader still sees where they are.
 */
export function visibleActiveId(
  rows: readonly OutlineRow[],
  activeId: string | null,
): string | null {
  if (activeId === null) return null;
  const ids = new Set(rows.map((row) => row.id));
  const path = activeId.split(".");
  for (let length = path.length; length > 0; length -= 1) {
    const candidate = path.slice(0, length).join(".");
    if (ids.has(candidate)) return candidate;
  }
  return null;
}
