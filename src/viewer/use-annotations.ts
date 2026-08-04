import { useCallback, useEffect, useRef, useState } from "react";
import {
  SidecarConflictError,
  emptyAnnotations,
  loadAnnotations,
  saveAnnotations,
  type Annotations,
  type Clip,
  type Highlight,
} from "../files/sidecar";
import { addClip } from "./clips";
import { addHighlight, removeHighlight } from "./highlights";

type Mutation = (annotations: Annotations) => Annotations;

/** A conflicting save is retried this many times before giving up. */
const MAX_SAVE_ATTEMPTS = 3;

export interface UseAnnotationsResult {
  annotations: Annotations;
  /**
   * False until the initial load succeeds — a failed load leaves it false for
   * good. Mutations are ignored while it is false, so a save can never write
   * an empty document over annotations that are still on disk.
   */
  loaded: boolean;
  /** Last load/save failure, for the UI to surface. */
  error: string | null;
  addHighlight(highlight: Highlight): void;
  removeHighlight(id: string): void;
  addClip(clip: Clip): void;
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
/**
 * Everything the hook puts on screen, tagged with the document it describes.
 * Held as one value (rather than three separate states) so an update can be
 * refused wholesale when it belongs to a document that is no longer open.
 */
interface AnnotationsView {
  readonly path: string;
  annotations: Annotations;
  loaded: boolean;
  error: string | null;
}

function newView(path: string): AnnotationsView {
  return {
    path,
    annotations: emptyAnnotations(),
    loaded: false,
    error: null,
  };
}

export function useAnnotations(pdfPath: string): UseAnnotationsResult {
  const [view, setView] = useState<AnnotationsView>(() => newView(pdfPath));
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
  const mountedRef = useRef(true);
  /**
   * Bumped for every path this hook loads. An async result carrying an older
   * generation belongs to a document the reader has already left, and must not
   * touch the state of the current one.
   */
  const generationRef = useRef(0);

  /**
   * Whether a generation is still the one being saved. Says nothing about
   * which document is on screen — `updateView` is what guards that.
   */
  const isCurrent = useCallback(
    (generation: number) =>
      mountedRef.current && generationRef.current === generation,
    [],
  );

  // Switching documents clears what the previous one put on screen. Done while
  // rendering (React's "adjusting state when a prop changes" pattern) rather
  // than from the load effect below, which only runs once the browser has
  // already been handed a frame showing the old document's annotations.
  if (view.path !== pdfPath) setView(newView(pdfPath));

  /**
   * Applies a change to the annotations of `path`, and only while those are
   * still the ones on screen. The check reads the state React is actually
   * holding rather than anything captured when the work started: `pdfPath` can
   * move on several renders before an effect — or its cleanup — gets to run,
   * so a closure over it, or a ref written from an effect, can still be
   * pointing at a document the reader has left.
   */
  const updateView = useCallback(
    (path: string, update: (current: AnnotationsView) => AnnotationsView) =>
      setView((current) => (current.path === path ? update(current) : current)),
    [],
  );

  /** Reports a load or save failure against the document it happened to. */
  const setError = useCallback(
    (path: string, cause: unknown) =>
      updateView(path, (current) => ({
        ...current,
        error: cause instanceof Error ? cause.message : String(cause),
      })),
    [updateView],
  );

  useEffect(() => {
    mountedRef.current = true;
    const generation = (generationRef.current += 1);
    loadedRef.current = false;
    pendingRef.current = [];
    persistedRef.current = {
      annotations: emptyAnnotations(),
      modifiedAtMs: null,
    };
    // Saves are only ordered within one document. Keeping the old chain would
    // make this document's first save wait on the previous one's — which may
    // still be hanging on a slow (or stalled) sidecar write.
    flushRef.current = Promise.resolve();

    void loadAnnotations(pdfPath)
      .then((result) => {
        if (!isCurrent(generation)) return;
        persistedRef.current = result;
        loadedRef.current = true;
        updateView(pdfPath, (current) => ({
          ...current,
          annotations: result.annotations,
          loaded: true,
        }));
      })
      .catch((cause: unknown) => {
        if (!isCurrent(generation)) return;
        setError(pdfPath, cause);
      });

    return () => {
      mountedRef.current = false;
    };
  }, [isCurrent, pdfPath, setError, updateView]);

  const applyPending = useCallback(
    (base: Annotations) =>
      pendingRef.current.reduce((current, fn) => fn(current), base),
    [],
  );

  const flush = useCallback(async () => {
    // Captured up front: a save that resolves after the reader moved to
    // another document must not write that document's persisted state.
    const generation = generationRef.current;
    // Counts conflicts only. A successful save resets it, so a reader making
    // many edits during one slow save never trips the give-up path.
    let conflicts = 0;
    while (pendingRef.current.length > 0 && isCurrent(generation)) {
      const taken = pendingRef.current.length;
      const next = applyPending(persistedRef.current.annotations);
      try {
        const modifiedAtMs = await saveAnnotations(
          pdfPath,
          next,
          persistedRef.current.modifiedAtMs,
        );
        if (!isCurrent(generation)) return;
        persistedRef.current = { annotations: next, modifiedAtMs };
        pendingRef.current.splice(0, taken);
        conflicts = 0;
      } catch (cause) {
        if (cause instanceof SidecarConflictError) {
          conflicts += 1;
          if (conflicts >= MAX_SAVE_ATTEMPTS) {
            if (isCurrent(generation)) {
              setError(
                pdfPath,
                "注釈を保存できませんでした（ファイルが変更され続けています）",
              );
            }
            return;
          }
          // Another writer got there first: rebase the pending mutations onto
          // whatever is on disk now and try again. A failed reload must not
          // reject flush() — that would poison flushRef's chain and block
          // every save after it.
          try {
            const fresh = await loadAnnotations(pdfPath);
            if (!isCurrent(generation)) return;
            persistedRef.current = fresh;
            // Applied here rather than inside the updater: `applyPending`
            // reads the pending queue, which the loop below trims as soon as
            // a save lands — an updater React runs later would rebase onto a
            // queue that no longer holds the mutations being rebased.
            const rebased = applyPending(fresh.annotations);
            updateView(pdfPath, (current) => ({
              ...current,
              annotations: rebased,
            }));
            continue;
          } catch (reloadCause) {
            if (isCurrent(generation)) setError(pdfPath, reloadCause);
            return;
          }
        }
        if (isCurrent(generation)) setError(pdfPath, cause);
        return;
      }
    }
  }, [applyPending, isCurrent, pdfPath, setError, updateView]);

  const mutate = useCallback(
    (fn: Mutation) => {
      // Before the initial load, a save could clobber highlights already on
      // disk with an empty base — refuse instead.
      if (!mountedRef.current || !loadedRef.current) return;
      pendingRef.current.push(fn);
      updateView(pdfPath, (current) => ({
        ...current,
        annotations: fn(current.annotations),
        error: null,
      }));
      flushRef.current = flushRef.current.then(flush);
    },
    [flush, pdfPath, updateView],
  );

  return {
    annotations: view.annotations,
    loaded: view.loaded,
    error: view.error,
    addHighlight: useCallback(
      (highlight: Highlight) =>
        mutate((current) => addHighlight(current, highlight)),
      [mutate],
    ),
    removeHighlight: useCallback(
      (id: string) => mutate((current) => removeHighlight(current, id)),
      [mutate],
    ),
    addClip: useCallback(
      (clip: Clip) => mutate((current) => addClip(current, clip)),
      [mutate],
    ),
  };
}
