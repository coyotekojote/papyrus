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
}

function describeError(cause: unknown): string {
  if (cause instanceof PdfFileMissingError) {
    return `ファイルが見つかりません: ${cause.path}`;
  }
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

function App() {
  const [recentFiles, setRecentFiles] = useState<readonly RecentFile[]>([]);
  const [openDocument, setOpenDocument] = useState<OpenDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const settings = useSettings();

  const openDocumentRef = useRef<OpenDocument | null>(null);
  openDocumentRef.current = openDocument;

  /**
   * Aborts the background half of a progressive page-size load (issue #12):
   * the part that keeps fetching after `openPath` has already handed back the
   * first chunk. Set fresh for every `openPath` call, and aborted whenever
   * that load's document stops being the one on screen — a new document
   * opening on top of it, or the reader closing it — so a slow read from a
   * huge PDF does not keep spending cycles once nobody is looking at it.
   */
  const pageSizeAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setRecentFiles(loadRecentFiles(window.localStorage));
  }, []);

  // Release the renderer's document (and its worker state) on teardown.
  useEffect(
    () => () => {
      pageSizeAbortRef.current?.abort();
      void openDocumentRef.current?.doc.destroy();
    },
    [],
  );

  const rememberRecentFiles = useCallback(
    (update: (current: readonly RecentFile[]) => RecentFile[]) => {
      setRecentFiles((current) => {
        const next = update(current);
        saveRecentFiles(window.localStorage, next);
        return next;
      });
    },
    [],
  );

  /**
   * `bookmark` is the security-scoped bookmark for `path`, when one exists
   * (issue #11): passed in fresh from `createBookmarkFor` for a newly picked
   * file, or carried over from the recent-files entry for a reopen. Either
   * way it is what lets the file still be readable after an iOS relaunch, and
   * is written back into the recent-files entry so it survives the next one.
   */
  const openPath = useCallback(
    async (path: string, bookmark?: string) => {
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

        const previous = openDocumentRef.current;
        // `name` stays derived from the original `path`, not `effectivePath`:
        // a resolved bookmark URL is percent-encoded (e.g. `%E8%AB%96%E6%96%87.pdf`)
        // and `fileNameFromPath` does not decode it, so the display name would
        // otherwise come out mangled.
        setOpenDocument({
          doc,
          pageSizes,
          path: effectivePath,
          name: fileNameFromPath(path),
        });
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
      await openPath(path, bookmark ?? undefined);
    } catch (cause) {
      setError(describeError(cause));
    }
  }, [openPath]);

  const handleOpenRecent = useCallback(
    (path: string) => {
      const bookmark = recentFiles.find((file) => file.path === path)?.bookmark;
      void openPath(path, bookmark);
    },
    [openPath, recentFiles],
  );

  const handleClose = useCallback(() => {
    pageSizeAbortRef.current?.abort();
    setOpenDocument((current) => {
      if (current) void current.doc.destroy();
      return null;
    });
  }, []);

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
