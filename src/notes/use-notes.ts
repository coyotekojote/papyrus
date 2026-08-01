import { useCallback, useEffect, useRef, useState } from "react";
import {
  SidecarConflictError,
  loadNotes,
  saveNotes,
  type Highlight,
} from "../files/sidecar";
import { appendQuote, formatHighlightQuote } from "../viewer/highlights";

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

/** A conflicting save is retried this many times before giving up. */
const MAX_SAVE_ATTEMPTS = 3;

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
  /** Appends a highlight to the note as a markdown quote, with its page. */
  insertQuote(highlight: Highlight): void;
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
  const [content, setContentState] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<NotesStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  const sessionRef = useRef<Session>(newSession(pdfPath));
  const mountedRef = useRef(true);

  /**
   * A session outlives the component only to finish its last write. Anything
   * belonging to a document the reader has left must not touch the UI.
   */
  const isCurrent = useCallback(
    (session: Session) => mountedRef.current && sessionRef.current === session,
    [],
  );

  const save = useCallback(
    async (session: Session) => {
      // Counts conflicts only; a successful save resets it, so a reader typing
      // through a slow save never trips the give-up path.
      let attempts = 0;
      while (session.loaded && !session.conflict) {
        const next = session.content;
        if (next === session.persisted.content) {
          if (isCurrent(session)) setStatus("saved");
          return;
        }
        if (isCurrent(session)) setStatus("saving");
        try {
          const modifiedAtMs = await saveNotes(
            session.path,
            next,
            session.persisted.modifiedAtMs,
          );
          session.persisted = { content: next, modifiedAtMs };
          attempts = 0;
          continue;
        } catch (cause) {
          if (!(cause instanceof SidecarConflictError)) {
            if (isCurrent(session)) {
              setError(message(cause));
              setStatus("error");
            }
            return;
          }
          attempts += 1;
          if (attempts >= MAX_SAVE_ATTEMPTS) {
            if (isCurrent(session)) {
              setError(
                "メモを保存できませんでした（ファイルが変更され続けています）",
              );
              setStatus("error");
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
              setError(message(reloadCause));
              setStatus("error");
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
            setConflict(fresh.content);
            setStatus("conflict");
            setError(null);
          }
          return;
        }
      }
    },
    [isCurrent],
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
    setContentState("");
    setLoaded(false);
    setStatus("loading");
    setError(null);
    setConflict(null);

    void loadNotes(pdfPath)
      .then((loadedNotes) => {
        session.loaded = true;
        session.content = loadedNotes.content;
        session.persisted = loadedNotes;
        if (!isCurrent(session)) return;
        setContentState(loadedNotes.content);
        setLoaded(true);
        setStatus("saved");
      })
      .catch((cause: unknown) => {
        if (!isCurrent(session)) return;
        setError(message(cause));
        setStatus("error");
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
  }, [isCurrent, pdfPath, save]);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const edit = useCallback(
    (next: (current: string) => string) => {
      const session = sessionRef.current;
      // Before the initial load, a save would write an empty note over
      // whatever is on disk. While a conflict is open, it would silently pick
      // a winner. Both are refused.
      if (!session.loaded || session.conflict) return;
      session.content = next(session.content);
      setContentState(session.content);
      setStatus("unsaved");
      setError(null);
      scheduleSave(session, SAVE_DEBOUNCE_MS);
    },
    [scheduleSave],
  );

  return {
    content,
    loaded,
    status,
    error,
    conflict,
    setContent: useCallback((next: string) => edit(() => next), [edit]),
    insertQuote: useCallback(
      (highlight: Highlight) =>
        edit((current) =>
          appendQuote(current, formatHighlightQuote(highlight)),
        ),
      [edit],
    ),
    keepLocal: useCallback(() => {
      const session = sessionRef.current;
      if (!session.conflict) return;
      // `persisted` already carries the file's current mtime, so the retry
      // passes the freshness check and the editor's text wins.
      session.conflict = false;
      setConflict(null);
      setStatus("unsaved");
      scheduleSave(session, 0);
    }, [scheduleSave]),
    takeDisk: useCallback(() => {
      const session = sessionRef.current;
      if (!session.conflict) return;
      session.conflict = false;
      session.content = session.persisted.content;
      setContentState(session.content);
      setConflict(null);
      setStatus("saved");
    }, []),
  };
}
