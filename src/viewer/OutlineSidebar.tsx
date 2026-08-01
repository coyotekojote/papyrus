import { useEffect, useMemo, useRef, useState } from "react";
import type { OutlineNode } from "../pdf";
import { activeOutlineId, flattenOutline, visibleActiveId } from "./outline";

interface OutlineSidebarProps {
  nodes: readonly OutlineNode[];
  currentPage: number;
  onJumpToPage: (pageNumber: number) => void;
}

/** The bookmark tree, with the section being read highlighted. */
export function OutlineSidebar({
  nodes,
  currentPage,
  onJumpToPage,
}: OutlineSidebarProps) {
  // Bookmarks start expanded: a table of contents is only useful open.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const rows = useMemo(
    () => flattenOutline(nodes, collapsed),
    [nodes, collapsed],
  );
  const activeId = useMemo(
    () => visibleActiveId(rows, activeOutlineId(nodes, currentPage)),
    [rows, nodes, currentPage],
  );

  const activeRef = useRef<HTMLLIElement>(null);

  // Follow the reader: keep the highlighted bookmark in view as pages turn.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const toggle = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  return (
    <ul className="outline" role="tree" aria-label="目次">
      {rows.map((row) => (
        <li
          key={row.id}
          className="outline__row"
          role="treeitem"
          aria-level={row.depth + 1}
          aria-selected={row.id === activeId}
          aria-expanded={row.hasChildren ? row.expanded : undefined}
          ref={row.id === activeId ? activeRef : undefined}
        >
          <span
            className="outline__indent"
            style={{ width: `${row.depth * 0.85}rem` }}
          />
          {row.hasChildren ? (
            <button
              type="button"
              className="outline__twisty"
              onClick={() => toggle(row.id)}
              aria-label={`${row.title} を${row.expanded ? "折りたたむ" : "展開する"}`}
            >
              {row.expanded ? "▾" : "▸"}
            </button>
          ) : (
            <span className="outline__twisty outline__twisty--empty" />
          )}
          <button
            type="button"
            className="outline__link"
            // A bookmark whose destination could not be resolved has nowhere
            // to jump to, but still belongs in the tree as a heading.
            disabled={row.pageNumber === null}
            onClick={() => {
              if (row.pageNumber !== null) onJumpToPage(row.pageNumber);
            }}
          >
            <span className="outline__title">{row.title}</span>
            {row.pageNumber !== null ? (
              <span className="outline__page">{row.pageNumber}</span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}
