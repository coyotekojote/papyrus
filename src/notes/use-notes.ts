import { useCallback, useEffect, useRef, useState } from "react";
import {
  SidecarConflictError,
  loadNotes,
  saveNotes,
  type Clip,
  type Highlight,
} from "../files/sidecar";
import {
  formatTranslationNote,
  type TranslationNote,
} from "../translation/format";
import { formatClipImage } from "../viewer/clips";
import { formatHighlightQuote } from "../viewer/highlights";
import { appendBlock } from "./markdown";

/**
 * notes.md for one PDF (issue #7): loads it, autosaves the editor's content
 * after a pause in typing, and never resolves a conflict on its own.
 *
 * The backend writes atomically and rejects a save whose base mtime no longer
 * matches the file on disk. Annotations can be rebased onto such a change
 * (see use-annotations); prose cannot, so when the note really did change
 * elsewhere — an iCloud sync from another device, an edit in Obsidian —
 * autosave stops and the reader picks which version survives.
 */

/** How long typing has to pause before the note is written. */
export const SAVE_DEBOUNCE_MS = 800;

/**
 * How many conflicts in a row a save may hit before giving up. Counted
 * consecutively: a save that succeeds resets it, so a long editing session
 * that keeps racing an external writer is never cut off by a running total.
 */
const MAX_CONSECUTIVE_CONFLICTS = 3;

export type NotesStatus =
  "loading" | "saved" | "unsaved" | "saving" | "conflict" | "error";

export interface UseNotesResult {
  content: string;
  /** False until the initial load succeeds; edits are refused until it does. */
  loaded: boolean;
  status: NotesStatus;
  /** Last load/save failure, for the UI to surface. */
  error: string | null;
  /** The note as it is on disk, while a conflict is waiting to be resolved. */
  conflict: string | null;
  setContent(next: string): void;
  /**
   * Sets the content once, without marking it dirty or scheduling a save
   * (issue #46: the default outline insertion). Only takes effect while the
   * note is loaded, has no conflict pending, and is still empty — anything
   * else means either it is not safe to touch yet or there is already
   * something here the reader wrote or a previous insertion produced.
   */
  initializeContent(text: string): void;
  /** Appends a highlight to the note as a markdown quote, with its page. */
  insertQuote(highlight: Highlight): void;
  /** Appends a clip to the note as a markdown image, relative to the sidecar. */
  insertImage(clip: Clip): void;
  /** Appends a translation to the note, quoting the original above it. */
  insertTranslation(note: TranslationNote): void;
  /** Conflict resolution: overwrite the file with what is in the editor. */
  keepLocal(): void;
  /** Conflict resolution: take the file's content, dropping local edits. */
  takeDisk(): void;
}

interface Session {
  readonly path: string;
  loaded: boolean;
  /** Latest editor content, ahead of `persisted` while a save is pending. */
  content: string;
  persisted: { content: string; modifiedAtMs: number | null };
  /** Set while the reader has to choose a version; blocks every save. */
  conflict: boolean;
  /** Serializes saves so two writes never interleave. */
  flush: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Everything the hook puts on screen, tagged with the document it describes.
 * Held as one value (rather than five separate states) so an update can be
 * refused wholesale when it belongs to a document that is no longer open.
 */
interface NotesView {
  readonly path: string;
  content: string;
  loaded: boolean;
  status: NotesStatus;
  error: string | null;
  conflict: string | null;
}

function newView(path: string): NotesView {
  return {
    path,
    content: "",
    loaded: false,
    status: "loading",
    error: null,
    conflict: null,
  };
}

function newSession(path: string): Session {
  return {
    path,
    loaded: false,
    content: "",
    persisted: { content: "", modifiedAtMs: null },
    conflict: false,
    flush: Promise.resolve(),
    timer: null,
  };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function useNotes(pdfPath: string): UseNotesResult {
  const [view, setView] = useState<NotesView>(() => newView(pdfPath));

  const sessionRef = useRef<Session>(newSession(pdfPath));
  const mountedRef = useRef(true);

  // Switching documents clears everything the previous one put on screen.
  // Done while rendering (React's "adjusting state when a prop changes"
  // pattern) rather than from the load effect below: an effect runs after the
  // browser has already been handed a frame, so the previous document's note
  // would show for that frame under the new document's name.
  if (view.path !== pdfPath) setView(newView(pdfPath));

  /**
   * Applies a change to the note of `path`, and only while that is still the
   * note on screen. The check reads the state React is actually holding rather
   * than anything captured when the work started: `pdfPath` can move on
   * several renders before an effect — or its cleanup — gets to run, so a
   * closure over it, or a ref written from an effect, can still be pointing at
   * a document the reader has left.
   */
  const updateView = useCallback(
    (path: string, update: (current: NotesView) => NotesView) =>
      setView((current) => (current.path === path ? update(current) : current)),
    [],
  );

  const setStatus = useCallback(
    (path: string, status: NotesStatus) =>
      updateView(path, (current) => ({ ...current, status })),
    [updateView],
  );

  /** Reports a load or save failure against the note it happened to. */
  const setFailure = useCallback(
    (path: string, reason: string) =>
      updateView(path, (current) => ({
        ...current,
        error: reason,
        status: "error",
      })),
    [updateView],
  );

  /**
   * The session for the document on screen, or null while `pdfPath` has moved
   * on but the effect below has not yet swapped the session in — the previous
   * document's session must not be written to in that gap.
   */
  const currentSession = useCallback(() => {
    const session = sessionRef.current;
    return session.path === pdfPath ? session : null;
  }, [pdfPath]);

  /**
   * A session outlives the component only to finish its last write. Anything
   * belonging to a session that has been replaced must not touch the UI.
   * `updateView` is what guards against the document itself having changed —
   * this only says whether the session is still the one being edited.
   */
  const isCurrent = useCallback(
    (session: Session) => mountedRef.current && sessionRef.current === session,
    [],
  );

  const save = useCallback(
    async (session: Session) => {
      let conflicts = 0;
      while (session.loaded && !session.conflict) {
        const next = session.content;
        if (next === session.persisted.content) {
          if (isCurrent(session)) setStatus(session.path, "saved");
          return;
        }
        if (isCurrent(session)) setStatus(session.path, "saving");
        try {
          const modifiedAtMs = await saveNotes(
            session.path,
            next,
            session.persisted.modifiedAtMs,
          );
          session.persisted = { content: next, modifiedAtMs };
          conflicts = 0;
          continue;
        } catch (cause) {
          if (!(cause instanceof SidecarConflictError)) {
            if (isCurrent(session)) setFailure(session.path, message(cause));
            return;
          }
          conflicts += 1;
          if (conflicts >= MAX_CONSECUTIVE_CONFLICTS) {
            if (isCurrent(session)) {
              setFailure(
                session.path,
                "メモを保存できませんでした（ファイルが変更され続けています）",
              );
            }
            return;
          }
          let fresh;
          try {
            fresh = await loadNotes(session.path);
          } catch (reloadCause) {
            // A failed reload must not reject: this promise is the flush
            // chain, and a rejection there would block every later save.
            if (isCurrent(session)) {
              setFailure(session.path, message(reloadCause));
            }
            return;
          }
          if (fresh.content === session.persisted.content) {
            // Same text, newer mtime — iCloud touched the file rather than
            // changing it. Adopt the mtime and write again.
            session.persisted = {
              content: fresh.content,
              modifiedAtMs: fresh.modifiedAtMs,
            };
            continue;
          }
          // The note really did change elsewhere. Neither version gets thrown
          // away without the reader saying so.
          session.conflict = true;
          session.persisted = {
            content: fresh.content,
            modifiedAtMs: fresh.modifiedAtMs,
          };
          if (isCurrent(session)) {
            updateView(session.path, (current) => ({
              ...current,
              conflict: fresh.content,
              status: "conflict",
              error: null,
            }));
          }
          return;
        }
      }
    },
    [isCurrent, setFailure, setStatus, updateView],
  );

  const scheduleSave = useCallback(
    (session: Session, delayMs: number) => {
      if (session.timer !== null) clearTimeout(session.timer);
      session.timer = setTimeout(() => {
        session.timer = null;
        session.flush = session.flush.then(() => save(session));
      }, delayMs);
    },
    [save],
  );

  useEffect(() => {
    mountedRef.current = true;
    const session = newSession(pdfPath);
    sessionRef.current = session;

    void loadNotes(pdfPath)
      .then((loadedNotes) => {
        session.loaded = true;
        session.content = loadedNotes.content;
        session.persisted = loadedNotes;
        if (!isCurrent(session)) return;
        updateView(session.path, (current) => ({
          ...current,
          content: loadedNotes.content,
          loaded: true,
          status: "saved",
        }));
      })
      .catch((cause: unknown) => {
        if (!isCurrent(session)) return;
        setFailure(session.path, message(cause));
      });

    return () => {
      // Closing the document (or the app) must not drop what was typed in the
      // last debounce window: write it now, on the same chain as any save
      // already in flight.
      if (session.timer !== null) {
        clearTimeout(session.timer);
        session.timer = null;
      }
      if (session.loaded && !session.conflict) {
        session.flush = session.flush.then(() => save(session));
      }
    };
  }, [isCurrent, pdfPath, save, setFailure, updateView]);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const edit = useCallback(
    (next: (current: string) => string) => {
      const session = currentSession();
      // Before the initial load, a save would write an empty note over
      // whatever is on disk. While a conflict is open, it would silently pick
      // a winner. Both are refused.
      if (!session?.loaded || session.conflict) return;
      session.content = next(session.content);
      updateView(session.path, (current) => ({
        ...current,
        content: session.content,
        status: "unsaved",
        error: null,
      }));
      scheduleSave(session, SAVE_DEBOUNCE_MS);
    },
    [currentSession, scheduleSave, updateView],
  );

  return {
    content: view.content,
    loaded: view.loaded,
    status: view.status,
    error: view.error,
    conflict: view.conflict,
    setContent: useCallback((next: string) => edit(() => next), [edit]),
    initializeContent: useCallback(
      (text: string) => {
        const session = currentSession();
        // Same refusals as `edit`: before the load, or mid-conflict, nothing
        // here is safe to overwrite. A note with real text in it is left
        // alone — this is a one-time default, not something the reader asked
        // to happen — but one that is only whitespace still counts as empty
        // and gets the default, the same as no note at all.
        if (!session?.loaded || session.conflict) return;
        if (session.content.trim() !== "") return;
        session.content = text;
        updateView(session.path, (current) => ({ ...current, content: text }));
        // Deliberately no `setStatus`/`scheduleSave`: the file on disk is
        // still empty, and writing it now — just because a default was shown —
        // would create notes.md for a PDF the reader never actually annotated.
        // Autosave only starts once a real edit calls `edit()`.
      },
      [currentSession, updateView],
    ),
    insertQuote: useCallback(
      (highlight: Highlight) =>
        edit((current) =>
          appendBlock(current, formatHighlightQuote(highlight)),
        ),
      [edit],
    ),
    insertImage: useCallback(
      (clip: Clip) =>
        edit((current) => appendBlock(current, formatClipImage(clip))),
      [edit],
    ),
    insertTranslation: useCallback(
      (note: TranslationNote) =>
        edit((current) => appendBlock(current, formatTranslationNote(note))),
      [edit],
    ),
    keepLocal: useCallback(() => {
      const session = currentSession();
      if (!session?.conflict) return;
      // `persisted` already carries the file's current mtime, so the retry
      // passes the freshness check and the editor's text wins.
      session.conflict = false;
      updateView(session.path, (current) => ({
        ...current,
        conflict: null,
        status: "unsaved",
      }));
      scheduleSave(session, 0);
    }, [currentSession, scheduleSave, updateView]),
    takeDisk: useCallback(() => {
      const session = currentSession();
      if (!session?.conflict) return;
      session.conflict = false;
      session.content = session.persisted.content;
      updateView(session.path, (current) => ({
        ...current,
        content: session.content,
        conflict: null,
        status: "saved",
      }));
    }, [currentSession, updateView]),
  };
}
