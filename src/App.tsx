import { useCallback, useEffect, useRef, useState } from "react";
import {
  createBookmarkFor,
  PdfFileMissingError,
  pickPdfFile,
  readPdfFileWithBookmark,
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
  loadPageSizes,
  type PageSize,
  type PdfDocumentHandle,
} from "./pdf";
import { markEnd, markStart } from "./perf/marks";
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

  useEffect(() => {
    setRecentFiles(loadRecentFiles(window.localStorage));
  }, []);

  // Release the renderer's document (and its worker state) on teardown.
  useEffect(
    () => () => {
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
        const bytes = await readPdfFileWithBookmark(path, bookmark);
        markEnd("app:read-file");
        const renderer = await loadDefaultRenderer();
        const doc = await renderer.open(bytes);
        const pageSizes = await loadPageSizes(doc);

        const previous = openDocumentRef.current;
        setOpenDocument({ doc, pageSizes, path, name: fileNameFromPath(path) });
        if (previous) void previous.doc.destroy();

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
