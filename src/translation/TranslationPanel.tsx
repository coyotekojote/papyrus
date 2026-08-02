import { useEffect } from "react";
import { providerInfo } from "../settings/settings";
import type { PopupPosition } from "../viewer/SelectionPopup";
import { languageLabel } from "./format";
import type { TranslationState } from "./use-translation";

interface TranslationPanelProps {
  position: PopupPosition;
  /** Anything but `idle`; the caller renders nothing when there is no request. */
  state: Exclude<TranslationState, { status: "idle" }>;
  onCopy: () => void;
  onInsertToNotes: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}

/**
 * The translation itself (issue #10), floating where the selection was.
 *
 * A panel rather than a sidebar: the reader is looking at the sentence it came
 * from, and moving their eyes across the window to read the translation of a
 * line they are pointing at is worse than covering a little of the page.
 */
export function TranslationPanel({
  position,
  state,
  onCopy,
  onInsertToNotes,
  onRetry,
  onDismiss,
}: TranslationPanelProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDismiss]);

  const answered = state.status === "done" ? state.result : null;

  return (
    <div
      className="translation"
      role="dialog"
      aria-label="翻訳"
      style={{ left: position.left, top: position.top }}
      // Same as the popups: a click inside must not reach the scroller's
      // pointer handlers, which dismiss whatever is floating.
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
    >
      <div className="translation__header">
        <span className="translation__source">
          {answered
            ? `${providerInfo(answered.provider).label} · ${languageLabel(answered.targetLanguage)}`
            : "翻訳"}
        </span>
        <button
          type="button"
          className="translation__close"
          aria-label="翻訳を閉じる"
          onClick={onDismiss}
        >
          ×
        </button>
      </div>

      <div className="translation__body" role="status" aria-live="polite">
        {state.status === "loading" ? (
          <p className="translation__status">翻訳しています…</p>
        ) : null}
        {state.status === "error" ? (
          <p className="translation__status translation__status--error">
            {state.message}
          </p>
        ) : null}
        {answered ? <p className="translation__text">{answered.text}</p> : null}
      </div>

      <div className="translation__actions">
        {state.status === "error" ? (
          <button type="button" className="popup__action" onClick={onRetry}>
            再試行
          </button>
        ) : null}
        {answered ? (
          <>
            <button type="button" className="popup__action" onClick={onCopy}>
              コピー
            </button>
            <button
              type="button"
              className="popup__action"
              onClick={onInsertToNotes}
            >
              メモに挿入
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
