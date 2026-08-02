import type { RecentFile } from "../files/recent";

/** How the library screen lays out its files. */
export type LibraryViewMode = "grid" | "list";

export const DEFAULT_LIBRARY_VIEW_MODE: LibraryViewMode = "grid";

export const LIBRARY_VIEW_MODE_STORAGE_KEY = "papyrus.libraryViewMode.v1";

function isLibraryViewMode(value: unknown): value is LibraryViewMode {
  return value === "grid" || value === "list";
}

/** Storage subset used here; `localStorage` satisfies it. */
export interface LibraryViewModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadLibraryViewMode(
  storage: LibraryViewModeStorage,
): LibraryViewMode {
  try {
    const raw = storage.getItem(LIBRARY_VIEW_MODE_STORAGE_KEY);
    return isLibraryViewMode(raw) ? raw : DEFAULT_LIBRARY_VIEW_MODE;
  } catch {
    // Private-mode browsers and locked-down WebViews can throw on access.
    return DEFAULT_LIBRARY_VIEW_MODE;
  }
}

export function saveLibraryViewMode(
  storage: LibraryViewModeStorage,
  mode: LibraryViewMode,
): void {
  try {
    storage.setItem(LIBRARY_VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // A full or unavailable store must not break switching views.
  }
}

/**
 * Files whose name matches `query`, case- and width-insensitively (so a
 * half-width search still finds a full-width Japanese file name and vice
 * versa). An empty or whitespace-only query matches everything, unfiltered.
 */
export function filterLibraryFiles(
  files: readonly RecentFile[],
  query: string,
): RecentFile[] {
  const needle = normalizeForSearch(query.trim());
  if (needle.length === 0) return [...files];
  return files.filter((file) => normalizeForSearch(file.name).includes(needle));
}

function normalizeForSearch(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}
