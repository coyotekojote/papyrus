import { useEffect } from "react";
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
  children: React.ReactNode;
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

interface CreateHighlightPopupProps {
  position: PopupPosition;
  onPick: (colorId: string) => void;
  onDismiss: () => void;
}

/** Shown over a fresh text selection: pick a color to create the highlight. */
export function CreateHighlightPopup({
  position,
  onPick,
  onDismiss,
}: CreateHighlightPopupProps) {
  return (
    <PopupShell
      position={position}
      label="ハイライトを作成"
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
    </PopupShell>
  );
}

interface HighlightActionsPopupProps {
  position: PopupPosition;
  onCopy: () => void;
  onInsertToNotes: () => void;
  onDelete: () => void;
  onDismiss: () => void;
}

/** Shown when an existing highlight is clicked. */
export function HighlightActionsPopup({
  position,
  onCopy,
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
