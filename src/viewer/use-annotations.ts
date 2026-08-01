import { useCallback, useEffect, useRef, useState } from "react";
import {
  SidecarConflictError,
  emptyAnnotations,
  loadAnnotations,
  loadNotes,
  saveAnnotations,
  saveNotes,
  type Annotations,
  type Highlight,
} from "../files/sidecar";
import {
  addHighlight,
  appendQuote,
  formatHighlightQuote,
  removeHighlight,
} from "./highlights";

type Mutation = (annotations: Annotations) => Annotations;

/** A conflicting save is retried this many times before giving up. */
const MAX_SAVE_ATTEMPTS = 3;

export interface UseAnnotationsResult {
  annotations: Annotations;
  /** False until the initial load resolves; mutations are ignored before then. */
  loaded: boolean;
  /** Last load/save failure, for the UI to surface. */
  error: string | null;
  addHighlight(highlight: Highlight): void;
  removeHighlight(id: string): void;
}

/**
 * Annotations for one PDF: loads them from the sidecar, applies mutations
 * optimistically, and persists them serially in the background.
 *
 * When a save conflicts (the file changed on disk, e.g. an iCloud sync from
 * another device), the hook reloads the file, re-applies every not-yet-saved
 * mutation on top of the fresh contents, and saves again — so neither the
 * other device's highlights nor the local ones are lost.
 */
export function useAnnotations(pdfPath: string): UseAnnotationsResult {
  const [annotations, setAnnotations] = useState<Annotations>(emptyAnnotations);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  /** What the sidecar file held at the last load/save, with its mtime. */
  const persistedRef = useRef<{
    annotations: Annotations;
    modifiedAtMs: number | null;
  }>({ annotations: emptyAnnotations(), modifiedAtMs: null });
  /** Mutations applied to the UI but not yet on disk, oldest first. */
  const pendingRef = useRef<Mutation[]>([]);
  /** Serializes flushes so saves never interleave. */
  const flushRef = useRef<Promise<void>>(Promise.resolve());
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    loadedRef.current = false;
    pendingRef.current = [];
    setLoaded(false);
    setError(null);
    setAnnotations(emptyAnnotations());

    void loadAnnotations(pdfPath)
      .then((result) => {
        if (!activeRef.current) return;
        persistedRef.current = result;
        setAnnotations(result.annotations);
        loadedRef.current = true;
        setLoaded(true);
      })
      .catch((cause: unknown) => {
        if (!activeRef.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      activeRef.current = false;
    };
  }, [pdfPath]);

  const applyPending = useCallback(
    (base: Annotations) =>
      pendingRef.current.reduce((current, fn) => fn(current), base),
    [],
  );

  const flush = useCallback(async () => {
    for (
      let attempt = 0;
      pendingRef.current.length > 0 && activeRef.current;
      attempt += 1
    ) {
      if (attempt >= MAX_SAVE_ATTEMPTS) {
        setError(
          "注釈を保存できませんでした（ファイルが変更され続けています）",
        );
        return;
      }
      const taken = pendingRef.current.length;
      const next = applyPending(persistedRef.current.annotations);
      try {
        const modifiedAtMs = await saveAnnotations(
          pdfPath,
          next,
          persistedRef.current.modifiedAtMs,
        );
        persistedRef.current = { annotations: next, modifiedAtMs };
        pendingRef.current.splice(0, taken);
      } catch (cause) {
        if (cause instanceof SidecarConflictError) {
          // Another writer got there first: rebase the pending mutations onto
          // whatever is on disk now and try again.
          const fresh = await loadAnnotations(pdfPath);
          persistedRef.current = fresh;
          if (activeRef.current) {
            setAnnotations(applyPending(fresh.annotations));
          }
          continue;
        }
        if (activeRef.current) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
        return;
      }
    }
  }, [applyPending, pdfPath]);

  const mutate = useCallback(
    (fn: Mutation) => {
      // Before the initial load, a save could clobber highlights already on
      // disk with an empty base — refuse instead.
      if (!activeRef.current || !loadedRef.current) return;
      pendingRef.current.push(fn);
      setAnnotations((current) => fn(current));
      setError(null);
      flushRef.current = flushRef.current.then(flush);
    },
    [flush],
  );

  return {
    annotations,
    loaded,
    error,
    addHighlight: useCallback(
      (highlight: Highlight) =>
        mutate((current) => addHighlight(current, highlight)),
      [mutate],
    ),
    removeHighlight: useCallback(
      (id: string) => mutate((current) => removeHighlight(current, id)),
      [mutate],
    ),
  };
}

/**
 * Appends a highlight to notes.md as a markdown quote. Retries once when the
 * notes changed between load and save (same iCloud race as annotations).
 */
export async function appendHighlightToNotes(
  pdfPath: string,
  highlight: Highlight,
): Promise<void> {
  const quote = formatHighlightQuote(highlight);
  for (let attempt = 0; ; attempt += 1) {
    const { content, modifiedAtMs } = await loadNotes(pdfPath);
    try {
      await saveNotes(pdfPath, appendQuote(content, quote), modifiedAtMs);
      return;
    } catch (cause) {
      if (cause instanceof SidecarConflictError && attempt === 0) continue;
      throw cause;
    }
  }
}
