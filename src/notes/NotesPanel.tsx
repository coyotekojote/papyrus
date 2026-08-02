import { useId, useMemo, useRef, useState } from "react";
import type { Clip } from "../files/sidecar";
import { detectDictationPlatform, dictationHint } from "./dictation";
import { MarkdownView } from "./MarkdownView";
import { useClipImages } from "./use-clip-images";
import type { NotesStatus } from "./use-notes";

type Mode = "edit" | "preview";

const STATUS_LABEL: Record<NotesStatus, string> = {
  loading: "読み込み中…",
  saved: "保存済み",
  unsaved: "未保存",
  saving: "保存中…",
  conflict: "競合しています",
  // Covers a failed load as well as a failed save; the message below says which.
  error: "エラー",
};

export interface NotesPanelProps {
  /** Path of the PDF on disk; the clips the preview shows live in its sidecar. */
  pdfPath: string;
  /** Clips recorded for this document, for resolving `![](clips/…)`. */
  clips: readonly Clip[];
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
 * works in any text field, so voice input needs nothing of its own here. The
 * "音声入力" button (issue #13) does not start recognition itself: there is
 * no web API to trigger OS dictation from JavaScript (Web Speech API is not
 * exposed in a WKWebView, and macOS dictation only starts from its own
 * fn-key/menu gesture). It only focuses the editor and shows the user how to
 * start dictation themselves.
 */
export function NotesPanel({
  pdfPath,
  clips,
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
  const [dictationHintOpen, setDictationHintOpen] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const dictationHintId = useId();
  const clipFiles = useMemo(() => clips.map((clip) => clip.file), [clips]);
  // Clips are only read for the preview: the editor shows the markdown itself.
  const images = useClipImages(pdfPath, clipFiles, mode === "preview");
  const editorDisabled = !loaded || conflict !== null;

  function switchMode(next: Mode) {
    setMode(next);
    // The hint only makes sense next to the editor; switching away from it
    // would otherwise leave a stale hint floating over the preview.
    if (next === "preview") setDictationHintOpen(false);
  }

  function toggleDictationHint() {
    if (dictationHintOpen) {
      setDictationHintOpen(false);
      return;
    }
    editorRef.current?.focus();
    setDictationHintOpen(true);
  }

  return (
    <div className="notes">
      <div className="notes__header">
        <div className="notes__modes" role="group" aria-label="メモの表示">
          <button
            type="button"
            className="notes__mode"
            aria-pressed={mode === "edit"}
            onClick={() => switchMode("edit")}
          >
            編集
          </button>
          <button
            type="button"
            className="notes__mode"
            aria-pressed={mode === "preview"}
            onClick={() => switchMode("preview")}
          >
            プレビュー
          </button>
        </div>
        {mode === "edit" ? (
          <button
            type="button"
            className="notes__dictation-toggle"
            disabled={editorDisabled}
            aria-expanded={dictationHintOpen}
            aria-controls={dictationHintId}
            onClick={toggleDictationHint}
          >
            音声入力
          </button>
        ) : null}
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
        <>
          {dictationHintOpen ? (
            <p id={dictationHintId} className="notes__dictation-hint">
              {dictationHint(detectDictationPlatform(globalThis.navigator))}
            </p>
          ) : null}
          <textarea
            ref={editorRef}
            className="notes__editor"
            aria-label="メモ (markdown)"
            value={content}
            // Refusing the keystroke outright would look like a frozen editor;
            // the panel says why instead.
            disabled={editorDisabled}
            placeholder="markdown でメモを書く。ハイライトの「メモに挿入」で引用が追記されます。"
            spellCheck={false}
            onChange={(event) => onChange(event.target.value)}
          />
        </>
      ) : (
        <div className="notes__preview">
          {content.trim() === "" ? (
            <p className="sidebar__status">まだメモはありません。</p>
          ) : (
            <MarkdownView source={content} images={images} />
          )}
        </div>
      )}
    </div>
  );
}
