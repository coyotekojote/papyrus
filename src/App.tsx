import { useCallback, useEffect, useRef, useState } from "react";
import {
  createBookmarkFor,
  PdfFileMissingError,
  pickPdfFile,
  readPdfFileWithBookmark,
  registerPdfPath,
} from "./files/open";
import {
  addRecentFile,
  fileNameFromPath,
  loadRecentFiles,
  removeRecentFile,
  saveRecentFiles,
  updateRecentFile,
  type RecentFile,
} from "./files/recent";
import {
  loadDefaultRenderer,
  loadPageSizesProgressive,
  type PageSize,
  type PdfDocumentHandle,
} from "./pdf";
import { clearStart, markEnd, markStart } from "./perf/marks";
import { SettingsDialog } from "./settings/SettingsDialog";
import { useSettings } from "./settings/use-settings";
import { StartScreen } from "./StartScreen";
import { PdfViewer } from "./viewer/PdfViewer";

interface OpenDocument {
  doc: PdfDocumentHandle;
  pageSizes: PageSize[];
  path: string;
  name: string;
  /**
   * The original `path` this document was opened from — the key its
   * recent-files entry lives under. `path` above is the bookmark-resolved
   * path (issue #51's `effectivePath`), which can change on every launch on
   * iOS; saving against it would both go stale immediately and miss the
   * entry `path` already dedups the recent-files list on. Everything that
   * persists to the recent-files list (issue #43's page-save included) must
   * key off this field, not `path`.
   */
  recentPath: string;
  /** Page to open the viewer on (issue #43); see {@link PdfViewerProps.initialPage}. */
  initialPage?: number;
}

/** How long to wait after the reader stops moving before the current page is
 * written to the recent-files entry (issue #43). Long enough that a fast
 * flick through several pages does not hit storage once per page; short
 * enough that quitting soon after settling still keeps the position. */
const LAST_PAGE_SAVE_DEBOUNCE_MS = 300;

function describeError(cause: unknown): string {
  if (cause instanceof PdfFileMissingError) {
    return `ファイルが見つかりません: ${cause.path}`;
  }
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

function App() {
  const [recentFiles, setRecentFiles] = useState<readonly RecentFile[]>(() =>
    loadRecentFiles(window.localStorage),
  );
  const [openDocument, setOpenDocument] = useState<OpenDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const settings = useSettings();

  /**
   * Mirrors `openDocument` for the callbacks that need the document currently
   * on screen without being re-created for each one — the unmount cleanup and
   * the debounced page save, both of which run long after the render that
   * produced the document. Kept in sync from an effect rather than during
   * render (refs must not be written while rendering); the two places that
   * swap the document out — `openPath` and `handleClose` — write it directly
   * as well, so a second call landing before the next commit still sees the
   * first one's result.
   */
  const openDocumentRef = useRef<OpenDocument | null>(null);
  useEffect(() => {
    openDocumentRef.current = openDocument;
  }, [openDocument]);

  /**
   * Mirrors `recentFiles`. `rememberRecentFiles` reads this instead of going
   * through `setRecentFiles`'s updater form: React drops an updater passed to
   * a state setter once the component has unmounted, which would otherwise
   * make a flush from the unmount-cleanup effect below a silent no-op — the
   * exact moment `flushPendingPageSave` (issue #43) most needs to still work.
   * Synced from an effect rather than during render: `rememberRecentFiles`
   * itself already keeps this current for calls made between renders (the
   * `recentFilesRef.current = next` below), so the effect only has to catch
   * `recentFiles` changing some other way — the initial load, most notably.
   */
  const recentFilesRef = useRef<readonly RecentFile[]>(recentFiles);
  useEffect(() => {
    recentFilesRef.current = recentFiles;
  }, [recentFiles]);

  /**
   * Aborts the background half of a progressive page-size load (issue #12):
   * the part that keeps fetching after `openPath` has already handed back the
   * first chunk. Set fresh for every `openPath` call, and aborted whenever
   * that load's document stops being the one on screen — a new document
   * opening on top of it, or the reader closing it — so a slow read from a
   * huge PDF does not keep spending cycles once nobody is looking at it.
   */
  const pageSizeAbortRef = useRef<AbortController | null>(null);

  /**
   * Computes the next list from `recentFilesRef` and writes it to storage
   * synchronously, rather than inside `setRecentFiles`'s updater — so a call
   * from the unmount-cleanup effect (issue #43's `flushPendingPageSave`)
   * still reaches storage even though React will not run an updater for a
   * component that has already unmounted. `recentFilesRef` is updated in the
   * same call so a second call before the next render still sees the first
   * call's result, matching what the updater form used to guarantee.
   */
  const rememberRecentFiles = useCallback(
    (update: (current: readonly RecentFile[]) => RecentFile[]) => {
      const next = update(recentFilesRef.current);
      saveRecentFiles(window.localStorage, next);
      recentFilesRef.current = next;
      setRecentFiles(next);
    },
    [],
  );

  /**
   * The most recently reported `{ path, page }` (issue #43) that has not yet
   * reached storage, and the timer counting down to when it will. `path` is
   * carried alongside the page rather than re-read from `openDocumentRef` at
   * flush time: if the reader closes the document (or opens another) before
   * the debounce fires, the write must still land against the document it was
   * actually read from, not whatever is open by then.
   */
  const pendingPageSaveRef = useRef<{ path: string; page: number } | null>(
    null,
  );
  const pageSaveTimerRef = useRef<number | null>(null);

  /** Writes the pending page, if any, to the recent-files entry right now —
   * skipping the debounce. Used when there is no later moment to fall back
   * on: closing the document, or the app itself going away. */
  const flushPendingPageSave = useCallback(() => {
    if (pageSaveTimerRef.current !== null) {
      window.clearTimeout(pageSaveTimerRef.current);
      pageSaveTimerRef.current = null;
    }
    const pending = pendingPageSaveRef.current;
    if (!pending) return;
    pendingPageSaveRef.current = null;
    rememberRecentFiles((current) =>
      updateRecentFile(current, pending.path, { lastPage: pending.page }),
    );
  }, [rememberRecentFiles]);

  // Release the renderer's document (and its worker state) on teardown, and
  // save whatever page was last reported so it is not lost with the app.
  useEffect(
    () => () => {
      pageSizeAbortRef.current?.abort();
      void openDocumentRef.current?.doc.destroy();
      flushPendingPageSave();
    },
    [flushPendingPageSave],
  );

  /**
   * `bookmark` is the security-scoped bookmark for `path`, when one exists
   * (issue #11): passed in fresh from `createBookmarkFor` for a newly picked
   * file, or carried over from the recent-files entry for a reopen. Either
   * way it is what lets the file still be readable after an iOS relaunch, and
   * is written back into the recent-files entry so it survives the next one.
   *
   * `lastPage` is the page last read (issue #43), carried over from the
   * recent-files entry the same way — absent for a freshly picked file, which
   * has no reading history yet.
   */
  const openPath = useCallback(
    async (path: string, opts?: { bookmark?: string; lastPage?: number }) => {
      const { bookmark, lastPage } = opts ?? {};
      setBusy(true);
      setError(null);
      try {
        markStart("app:read-file");
        let bytes: Uint8Array;
        let effectivePath: string;
        try {
          ({ bytes, path: effectivePath } = await readPdfFileWithBookmark(
            path,
            bookmark,
          ));
        } catch (cause) {
          // A missing/unreadable file never reaches markEnd below — without
          // this the start mark would sit unmeasured forever, the same
          // problem `clearStart` exists for elsewhere in this codebase.
          clearStart("app:read-file");
          throw cause;
        }
        markEnd("app:read-file");
        try {
          // Lets the sidecar commands (notes/annotations/clips) touch this
          // pdf_path for the rest of the session (issue #40). Non-fatal: the
          // read above already succeeded through plugin-fs, so a failure
          // here must not stop the document from opening — it only means a
          // later sidecar call on this path will fail on its own.
          await registerPdfPath(effectivePath);
        } catch (cause) {
          console.warn("failed to register pdf path for sidecar access", cause);
        }
        const renderer = await loadDefaultRenderer();
        const doc = await renderer.open(bytes);

        // A document opening on top of one still fetching its page sizes in
        // the background must not let that stale load keep running.
        pageSizeAbortRef.current?.abort();
        const pageSizeAbort = new AbortController();
        pageSizeAbortRef.current = pageSizeAbort;

        const { initial: pageSizes, done: pageSizesDone } =
          await loadPageSizesProgressive(doc, {
            signal: pageSizeAbort.signal,
            onProgress: (sizes) => {
              // Guards against a progress callback landing after the reader
              // has already moved on to a different document — the abort
              // above stops new fetches, but one already in flight can still
              // resolve and reach here before the signal is checked again.
              setOpenDocument((current) =>
                current?.doc === doc
                  ? { ...current, pageSizes: sizes }
                  : current,
              );
            },
          });
        // Loading the rest is not on openPath's critical path — the viewer
        // lays out fine with FALLBACK_PAGE_SIZE for pages not read yet, and
        // onProgress above is what carries the real sizes in as they arrive.
        pageSizesDone.catch((cause: unknown) => {
          // A failed background page size never reaches here (loadPageSizes*
          // falls back to FALLBACK_PAGE_SIZE internally), so a rejection here
          // is unexpected — logged rather than silently swallowed, so a bug
          // in that fallback is not invisible, without turning into an
          // unhandled rejection or interrupting the document that already
          // opened successfully.
          console.error("Background page-size load failed unexpectedly", cause);
        });

        // Clamped against *this* document's page count, not trusted as-is:
        // the stored value can predate a shorter revision of the file, or
        // (storage being user-editable) simply be wrong.
        const initialPage =
          lastPage === undefined
            ? undefined
            : Math.min(Math.max(lastPage, 1), Math.max(doc.pageCount, 1));

        const previous = openDocumentRef.current;
        // `name` stays derived from the original `path`, not `effectivePath`:
        // a resolved bookmark URL is percent-encoded (e.g. `%E8%AB%96%E6%96%87.pdf`)
        // and `fileNameFromPath` does not decode it, so the display name would
        // otherwise come out mangled.
        const next: OpenDocument = {
          doc,
          pageSizes,
          path: effectivePath,
          name: fileNameFromPath(path),
          recentPath: path,
          initialPage,
        };
        openDocumentRef.current = next;
        setOpenDocument(next);
        if (previous) void previous.doc.destroy();

        // Keyed on the original `path`, not `effectivePath`: a resolved
        // bookmark URL can change on every launch, so persisting it would
        // both go stale immediately and duplicate the entry `path` already
        // dedups on.
        rememberRecentFiles((current) =>
          addRecentFile(current, {
            path,
            name: fileNameFromPath(path),
            openedAt: Date.now(),
            ...(bookmark ? { bookmark } : {}),
            // Carried over as-is (not the clamped `initialPage` above), so
            // `addRecentFile` — which replaces the whole entry — does not
            // wipe the stored position out for the brief moment before the
            // viewer's own `onPageChange` (mounted with the clamped page)
            // overwrites it for real via the debounced save below.
            ...(lastPage !== undefined ? { lastPage } : {}),
          }),
        );
      } catch (cause) {
        setError(describeError(cause));
        if (cause instanceof PdfFileMissingError) {
          // A stale entry is worse than no entry: drop it so the list stays real.
          rememberRecentFiles((current) => removeRecentFile(current, path));
        }
      } finally {
        setBusy(false);
      }
    },
    [rememberRecentFiles],
  );

  const handleOpen = useCallback(async () => {
    try {
      const path = await pickPdfFile();
      if (!path) return;
      const bookmark = await createBookmarkFor(path);
      await openPath(path, { bookmark: bookmark ?? undefined });
    } catch (cause) {
      setError(describeError(cause));
    }
  }, [openPath]);

  const handleOpenRecent = useCallback(
    (path: string) => {
      const entry = recentFiles.find((file) => file.path === path);
      void openPath(path, {
        bookmark: entry?.bookmark,
        lastPage: entry?.lastPage,
      });
    },
    [openPath, recentFiles],
  );

  const handleClose = useCallback(() => {
    pageSizeAbortRef.current?.abort();
    // The page the reader was last on would otherwise wait out the debounce
    // (or simply never fire again for a document about to close) and be lost.
    flushPendingPageSave();
    openDocumentRef.current = null;
    setOpenDocument((current) => {
      if (current) void current.doc.destroy();
      return null;
    });
  }, [flushPendingPageSave]);

  /**
   * Persists the page the reader is on (issue #43), debounced so a fast flick
   * through several pages does not hit storage once per page — see
   * {@link LAST_PAGE_SAVE_DEBOUNCE_MS}. `openDocumentRef` is read here rather
   * than closed over, since this callback is stable across the document's
   * whole lifetime (`PdfViewer` only takes it once, on mount).
   */
  const handlePageChange = useCallback(
    (page: number) => {
      // `recentPath`, not `path`: `path` is the bookmark-resolved path, which
      // is not the key the recent-files entry lives under (see
      // `OpenDocument.recentPath`).
      const path = openDocumentRef.current?.recentPath;
      if (!path) return;
      pendingPageSaveRef.current = { path, page };
      if (pageSaveTimerRef.current !== null) {
        window.clearTimeout(pageSaveTimerRef.current);
      }
      pageSaveTimerRef.current = window.setTimeout(
        flushPendingPageSave,
        LAST_PAGE_SAVE_DEBOUNCE_MS,
      );
    },
    [flushPendingPageSave],
  );

  /**
   * Stores the width the notes panel was dragged to (issue #76). The viewer
   * only reports a width once a drag has settled, so this is one save per
   * resize rather than one per frame.
   */
  const updateSettings = settings.update;
  const handleNotesPanelWidthChange = useCallback(
    (width: number) => {
      updateSettings((current) => ({ ...current, notesPanelWidth: width }));
    },
    [updateSettings],
  );

  const handleRemoveRecent = useCallback(
    (path: string) =>
      rememberRecentFiles((current) => removeRecentFile(current, path)),
    [rememberRecentFiles],
  );

  // Rendered over whichever screen is up, so the settings are reachable both
  // before a document is opened and while one is being read.
  const settingsDialog = settingsOpen ? (
    <SettingsDialog
      settings={settings.settings}
      loaded={settings.loaded}
      error={settings.error}
      onChange={settings.update}
      onClose={() => setSettingsOpen(false)}
    />
  ) : null;
  const openSettings = () => setSettingsOpen(true);

  if (openDocument) {
    return (
      <>
        <PdfViewer
          key={openDocument.path}
          doc={openDocument.doc}
          pageSizes={openDocument.pageSizes}
          filePath={openDocument.path}
          fileName={openDocument.name}
          defaultBinding={settings.settings.defaultBinding}
          defaultViewMode={settings.settings.defaultViewMode}
          notesOutlineInsert={settings.settings.notesOutlineInsert}
          notesOutlineFollow={settings.settings.notesOutlineFollow}
          notesPanelWidth={settings.settings.notesPanelWidth}
          onNotesPanelWidthChange={handleNotesPanelWidthChange}
          initialPage={openDocument.initialPage}
          onPageChange={handlePageChange}
          onClose={handleClose}
          onOpenSettings={openSettings}
        />
        {settingsDialog}
      </>
    );
  }

  return (
    <>
      <StartScreen
        recentFiles={recentFiles}
        busy={busy}
        error={error}
        onOpen={() => void handleOpen()}
        onOpenRecent={handleOpenRecent}
        onRemoveRecent={handleRemoveRecent}
        onOpenSettings={openSettings}
      />
      {settingsDialog}
    </>
  );
}

export default App;
