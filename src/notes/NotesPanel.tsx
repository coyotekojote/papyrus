import { useState } from "react";
import { MarkdownView } from "./MarkdownView";
import type { NotesStatus } from "./use-notes";

type Mode = "edit" | "preview";

const STATUS_LABEL: Record<NotesStatus, string> = {
  loading: "読み込み中…",
  saved: "保存済み",
  unsaved: "未保存",
  saving: "保存中…",
  conflict: "競合しています",
  error: "保存できません",
};

export interface NotesPanelProps {
  content: string;
  loaded: boolean;
  status: NotesStatus;
  error: string | null;
  /** The note as it is on disk, while a conflict is waiting to be resolved. */
  conflict: string | null;
  onChange: (next: string) => void;
  onKeepLocal: () => void;
  onTakeDisk: () => void;
}

/**
 * The notes panel (issue #7): a plain markdown editor with a preview.
 *
 * The editor is an ordinary <textarea> on purpose — OS dictation (macOS / iOS)
 * works in any text field, so voice input needs nothing of its own here.
 */
export function NotesPanel({
  content,
  loaded,
  status,
  error,
  conflict,
  onChange,
  onKeepLocal,
  onTakeDisk,
}: NotesPanelProps) {
  const [mode, setMode] = useState<Mode>("edit");

  return (
    <div className="notes">
      <div className="notes__header">
        <div className="notes__modes" role="group" aria-label="メモの表示">
          <button
            type="button"
            className="notes__mode"
            aria-pressed={mode === "edit"}
            onClick={() => setMode("edit")}
          >
            編集
          </button>
          <button
            type="button"
            className="notes__mode"
            aria-pressed={mode === "preview"}
            onClick={() => setMode("preview")}
          >
            プレビュー
          </button>
        </div>
        <span
          className="notes__status"
          // Saving happens on its own; announce it without stealing focus.
          role="status"
        >
          {STATUS_LABEL[status]}
        </span>
      </div>

      {error ? (
        <p className="sidebar__status sidebar__status--error">{error}</p>
      ) : null}

      {conflict !== null ? (
        <div className="notes__conflict">
          <p className="notes__conflict-text">
            notes.md
            が他の場所で変更されました。どちらを残すか選んでください（選ぶまで自動保存は止まります）。
          </p>
          <div
            className="notes__conflict-actions"
            role="group"
            aria-label="競合の解決"
          >
            <button type="button" onClick={onKeepLocal}>
              こちらで上書き
            </button>
            <button type="button" onClick={onTakeDisk}>
              ファイルを読み込む
            </button>
          </div>
          <details className="notes__conflict-details">
            <summary>ファイルの内容</summary>
            <pre>{conflict}</pre>
          </details>
        </div>
      ) : null}

      {mode === "edit" ? (
        <textarea
          className="notes__editor"
          aria-label="メモ (markdown)"
          value={content}
          // Refusing the keystroke outright would look like a frozen editor;
          // the panel says why instead.
          disabled={!loaded || conflict !== null}
          placeholder="markdown でメモを書く。ハイライトの「メモに挿入」で引用が追記されます。"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <div className="notes__preview">
          {content.trim() === "" ? (
            <p className="sidebar__status">まだメモはありません。</p>
          ) : (
            <MarkdownView source={content} />
          )}
        </div>
      )}
    </div>
  );
}
