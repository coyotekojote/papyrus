import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Clip } from "../files/sidecar";
import { detectDictationPlatform, dictationHint } from "./dictation";
import { scrollOffsetIntoView } from "./follow-scroll";
import { MarkdownView } from "./MarkdownView";
import { findHeadingOffset } from "./outline-headings";
import { scrollPastEndPadding } from "./scroll-past-end";
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
  /**
   * Title of the section the reader is currently on (issue #46), or null
   * when there is none or the setting is off. A change moves the editor's
   * cursor to the matching heading, unless the reader is mid-edit.
   */
  followHeading: string | null;
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
  followHeading,
  onChange,
  onKeepLocal,
  onTakeDisk,
}: NotesPanelProps) {
  const [mode, setMode] = useState<Mode>("edit");
  const [dictationHintOpen, setDictationHintOpen] = useState(false);
  /**
   * Tracked as state, not read off `document.activeElement`, so blurring the
   * editor is itself a change the follow effect below reacts to — a
   * `followHeading` that arrived while the reader was typing must not be
   * lost just because nothing else changed after they clicked away.
   */
  const [editorFocused, setEditorFocused] = useState(false);
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
    // Opening still needs the guard the button's `disabled` used to provide
    // on its own: the button now stays enabled while the hint is open (so a
    // conflict that appears mid-hint doesn't strand it open), which means
    // this branch can no longer rely on disabled state blocking the click.
    if (editorDisabled) return;
    editorRef.current?.focus();
    setDictationHintOpen(true);
  }

  /**
   * The `followHeading` the caret was last moved to, so a `content` change
   * alone — a quote or clip inserted elsewhere in the note, a keystroke —
   * never re-triggers the jump. Only an actual change of section does.
   * Cleared on leaving edit mode, so returning to it re-applies whatever
   * `followHeading` is current at that point.
   */
  const appliedFollowHeadingRef = useRef<string | null>(null);

  // Follows the reader's current section (#46): moves the caret to the
  // matching heading when it changes. Left alone while the reader is
  // actually typing — `editorFocused` is the live signal for that — so the
  // cursor is never yanked out from under a keystroke. Focus itself is
  // never taken: this only helps a reader who is already looking at the
  // editor, and stealing focus would disrupt everything else. Because
  // `editorFocused` is a dependency, blurring the editor re-runs this even
  // when `followHeading` arrived and settled while the reader was still
  // typing, so the follow that was skipped then still happens once they
  // click away.
  useEffect(() => {
    if (mode !== "edit") {
      appliedFollowHeadingRef.current = null;
      return;
    }
    if (followHeading === null) {
      // Out of any section (before the first bookmark, say) is not a
      // heading to remember as "applied": without clearing this, leaving a
      // section and coming straight back to it — or turning the setting
      // off and back on — would look like no change at all and the follow
      // would be silently skipped.
      appliedFollowHeadingRef.current = null;
      return;
    }
    if (followHeading === appliedFollowHeadingRef.current) return;
    if (editorFocused) return;
    const textarea = editorRef.current;
    if (!textarea) return;

    const offset = findHeadingOffset(content, followHeading);
    if (offset === null) return;
    appliedFollowHeadingRef.current = followHeading;

    textarea.setSelectionRange(offset, offset);
    scrollOffsetIntoView(textarea, offset);
  }, [followHeading, mode, content, editorFocused]);

  // Keeps the editor scrollable past its own last line (issue #74; see
  // scroll-past-end.ts for the full derivation). Without this, a followed
  // heading that lands on or near the textarea's last line asks for a
  // `scrollTop` the browser clamps below — the note simply runs out of
  // content before the target scroll position does, so the jump above does
  // nothing at all, silently (an unfocused textarea's caret is invisible, so
  // there is no visual sign the follow was even attempted).
  //
  // A layout effect applies the padding before paint, so a freshly mounted
  // (or just-switched-back-to-edit) textarea never briefly renders with its
  // designed 0.6rem bottom padding first. The `ResizeObserver` then keeps it
  // current as the panel's own height changes (a window resize, the compact
  // layout's breakpoint) — `clientHeight` is the only input here that
  // changes after mount; `lineHeight`/`paddingTop` come from CSS that does
  // not change at runtime, and are re-read anyway since doing so costs
  // nothing extra. Re-runs on `mode`: switching to preview and back mounts a
  // *new* textarea element, which this must reattach to.
  useLayoutEffect(() => {
    if (mode !== "edit") return;
    const textarea = editorRef.current;
    if (!textarea) return;
    const view = textarea.ownerDocument.defaultView;
    if (!view) return;

    const applyPadding = () => {
      const computed = view.getComputedStyle(textarea);
      const lineHeight = Number.parseFloat(computed.lineHeight);
      const paddingTop = Number.parseFloat(computed.paddingTop) || 0;
      textarea.style.paddingBottom = `${scrollPastEndPadding(
        textarea.clientHeight,
        lineHeight,
        paddingTop,
      )}px`;
    };

    applyPadding();
    const observer = new ResizeObserver(applyPadding);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [mode]);

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
            // Disabled only blocks opening; once the hint is open it must
            // stay closable even if the editor becomes disabled underneath
            // it (e.g. a conflict shows up), or the only way out is
            // switching to preview.
            disabled={editorDisabled && !dictationHintOpen}
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
            onFocus={() => setEditorFocused(true)}
            onBlur={() => setEditorFocused(false)}
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
