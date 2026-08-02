import { useEffect, type ReactNode } from "react";
import { HIGHLIGHT_COLORS } from "./highlights";

export interface PopupPosition {
  /** CSS pixels relative to the positioned ancestor (.viewer__body). */
  left: number;
  top: number;
}

interface PopupShellProps {
  position: PopupPosition;
  label: string;
  onDismiss: () => void;
  children: ReactNode;
}

/** Floating action bar anchored near the pointer; Escape dismisses it. */
function PopupShell({ position, label, onDismiss, children }: PopupShellProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDismiss]);

  return (
    <div
      className="popup"
      role="toolbar"
      aria-label={label}
      style={{ left: position.left, top: position.top }}
      // A click inside must not reach the scroller's pointer handlers, which
      // would immediately dismiss the popup.
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}

interface SelectionActionsPopupProps {
  position: PopupPosition;
  onPick: (colorId: string) => void;
  onTranslate: () => void;
  onDismiss: () => void;
}

/** Shown over a fresh text selection: highlight it in a color, or translate it. */
export function SelectionActionsPopup({
  position,
  onPick,
  onTranslate,
  onDismiss,
}: SelectionActionsPopupProps) {
  return (
    <PopupShell
      position={position}
      label="選択したテキスト"
      onDismiss={onDismiss}
    >
      {HIGHLIGHT_COLORS.map((color) => (
        <button
          key={color.id}
          type="button"
          className="popup__swatch"
          style={{ background: color.css }}
          aria-label={`${color.label}でハイライト`}
          onClick={() => onPick(color.id)}
        />
      ))}
      <button type="button" className="popup__action" onClick={onTranslate}>
        翻訳
      </button>
    </PopupShell>
  );
}

interface HighlightActionsPopupProps {
  position: PopupPosition;
  onCopy: () => void;
  onTranslate: () => void;
  onInsertToNotes: () => void;
  onDelete: () => void;
  onDismiss: () => void;
}

/** Shown when an existing highlight is clicked. */
export function HighlightActionsPopup({
  position,
  onCopy,
  onTranslate,
  onInsertToNotes,
  onDelete,
  onDismiss,
}: HighlightActionsPopupProps) {
  return (
    <PopupShell
      position={position}
      label="ハイライト操作"
      onDismiss={onDismiss}
    >
      <button type="button" className="popup__action" onClick={onCopy}>
        コピー
      </button>
      <button type="button" className="popup__action" onClick={onTranslate}>
        翻訳
      </button>
      <button type="button" className="popup__action" onClick={onInsertToNotes}>
        メモに挿入
      </button>
      <button
        type="button"
        className="popup__action popup__action--danger"
        onClick={onDelete}
      >
        削除
      </button>
    </PopupShell>
  );
}
