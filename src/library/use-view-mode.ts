import { useCallback, useEffect, useState } from "react";
import {
  loadLibraryViewMode,
  saveLibraryViewMode,
  type LibraryViewMode,
} from "./library";

/**
 * Grid/list toggle for the library screen, persisted across launches the same
 * way the recent-files list is: read once at mount, written back on change.
 */
export function useLibraryViewMode(): [
  LibraryViewMode,
  (mode: LibraryViewMode) => void,
] {
  const [mode, setMode] = useState<LibraryViewMode>(
    loadLibraryViewMode(window.localStorage),
  );

  // Re-read on mount so a value written after this hook's initial state was
  // computed (e.g. jsdom resetting storage between tests) is not stale.
  useEffect(() => {
    setMode(loadLibraryViewMode(window.localStorage));
  }, []);

  const update = useCallback((next: LibraryViewMode) => {
    setMode(next);
    saveLibraryViewMode(window.localStorage, next);
  }, []);

  return [mode, update];
}
