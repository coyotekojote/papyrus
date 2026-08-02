import { useCallback, useEffect, useRef, useState } from "react";
import { PdfFileMissingError, pickPdfFile, readPdfFile } from "./files/open";
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

  const openPath = useCallback(
    async (path: string) => {
      setBusy(true);
      setError(null);
      try {
        const bytes = await readPdfFile(path);
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
      if (path) await openPath(path);
    } catch (cause) {
      setError(describeError(cause));
    }
  }, [openPath]);

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
        onOpenRecent={(path) => void openPath(path)}
        onRemoveRecent={handleRemoveRecent}
        onOpenSettings={openSettings}
      />
      {settingsDialog}
    </>
  );
}

export default App;
