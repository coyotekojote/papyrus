import type { Highlight } from "../files/sidecar";
import { highlightColorCss, sortHighlights } from "./highlights";

interface HighlightsPanelProps {
  highlights: readonly Highlight[];
  onJumpToPage: (pageNumber: number) => void;
  onCopy: (highlight: Highlight) => void;
  onInsertToNotes: (highlight: Highlight) => void;
  onDelete: (highlight: Highlight) => void;
}

/** Sidebar list of every highlight, in reading order. */
export function HighlightsPanel({
  highlights,
  onJumpToPage,
  onCopy,
  onInsertToNotes,
  onDelete,
}: HighlightsPanelProps) {
  const sorted = sortHighlights(highlights);

  if (sorted.length === 0) {
    return (
      <p className="sidebar__status">
        テキストを選択して色を選ぶと、ハイライトがここに並びます。
      </p>
    );
  }

  return (
    <ul className="highlights" aria-label="ハイライト">
      {sorted.map((highlight) => (
        <li key={highlight.id} className="highlights__item">
          <button
            type="button"
            className="highlights__jump"
            onClick={() => onJumpToPage(highlight.page)}
          >
            <span
              className="highlights__chip"
              style={{ background: highlightColorCss(highlight.color) }}
              aria-hidden="true"
            />
            <span className="highlights__text">{highlight.text}</span>
            <span className="highlights__page">p.{highlight.page}</span>
          </button>
          <div
            className="highlights__actions"
            role="group"
            aria-label={`p.${highlight.page} のハイライト操作`}
          >
            <button
              type="button"
              className="highlights__action"
              onClick={() => onCopy(highlight)}
            >
              コピー
            </button>
            <button
              type="button"
              className="highlights__action"
              onClick={() => onInsertToNotes(highlight)}
            >
              メモに挿入
            </button>
            <button
              type="button"
              className="highlights__action highlights__action--danger"
              onClick={() => onDelete(highlight)}
            >
              削除
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
