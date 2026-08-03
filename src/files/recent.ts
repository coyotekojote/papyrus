export interface RecentFile {
  /** Absolute path on disk — the identity of the entry. */
  path: string;
  /** File name shown in the UI. */
  name: string;
  /** Epoch milliseconds of the most recent open. */
  openedAt: number;
  /**
   * Security-scoped bookmark for `path` (iOS only, issue #11). iOS revokes a
   * document picker's access to a file once the app relaunches; the bookmark
   * is what lets the file be reopened from the recent list afterwards. Absent
   * on every other platform, and on entries saved before this field existed —
   * both cases just fall back to opening `path` directly.
   */
  bookmark?: string;
  /**
   * 1-based page number last shown for this file (issue #43), so reopening it
   * from the recent list picks up where reading left off. Absent on entries
   * saved before this field existed, and on any entry whose stored value
   * turned out malformed — both cases just fall back to page 1.
   */
  lastPage?: number;
}

export const MAX_RECENT_FILES = 10;
export const RECENT_FILES_STORAGE_KEY = "papyrus.recentFiles.v1";

/** Last path segment, tolerating both POSIX and Windows separators. */
export function fileNameFromPath(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? path;
}

/**
 * Puts `file` at the head of the list, removing any earlier entry for the same
 * path, and trims the result to {@link MAX_RECENT_FILES}. Pure: `list` is not
 * modified.
 */
export function addRecentFile(
  list: readonly RecentFile[],
  file: RecentFile,
  limit = MAX_RECENT_FILES,
): RecentFile[] {
  const withoutDuplicate = list.filter((entry) => entry.path !== file.path);
  return [file, ...withoutDuplicate].slice(0, Math.max(0, limit));
}

export function removeRecentFile(
  list: readonly RecentFile[],
  path: string,
): RecentFile[] {
  return list.filter((entry) => entry.path !== path);
}

function isRecentFile(value: unknown): value is RecentFile {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.path === "string" &&
    candidate.path.length > 0 &&
    typeof candidate.name === "string" &&
    typeof candidate.openedAt === "number" &&
    Number.isFinite(candidate.openedAt)
    // `bookmark` is checked separately, in the caller: a malformed bookmark
    // (missing, null, a stray number, …) should not sink the whole entry — an
    // entry saved before this field existed is still a valid recent file.
  );
}

/**
 * Parses a stored recent-files list, dropping anything malformed. Storage is
 * user-editable and survives app upgrades, so it is never trusted.
 */
export function parseRecentFiles(raw: string | null): RecentFile[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const files: RecentFile[] = [];
  for (const entry of parsed) {
    if (!isRecentFile(entry) || seen.has(entry.path)) continue;
    seen.add(entry.path);
    files.push({
      path: entry.path,
      name: entry.name,
      openedAt: entry.openedAt,
      ...(typeof entry.bookmark === "string"
        ? { bookmark: entry.bookmark }
        : {}),
      // Same treatment as `bookmark`: a malformed `lastPage` (0, negative, a
      // fraction, a string, …) just drops the field rather than the entry —
      // the reader still gets the file back, only without the saved position.
      ...(typeof entry.lastPage === "number" &&
      Number.isInteger(entry.lastPage) &&
      entry.lastPage >= 1
        ? { lastPage: entry.lastPage }
        : {}),
    });
    if (files.length >= MAX_RECENT_FILES) break;
  }
  return files;
}

/**
 * Updates the entry for `path` with `patch`, leaving order and every other
 * field untouched. Unlike {@link addRecentFile}, this never moves the entry
 * to the head or bumps `openedAt` — it exists for updates (the last page read,
 * issue #43) that happen continuously while a file is open and must not read
 * as "just opened" every time. A `path` not present in `list` is a no-op.
 */
export function updateRecentFile(
  list: readonly RecentFile[],
  path: string,
  patch: Partial<Pick<RecentFile, "lastPage">>,
): RecentFile[] {
  return list.map((entry) =>
    entry.path === path ? { ...entry, ...patch } : entry,
  );
}

export function serializeRecentFiles(list: readonly RecentFile[]): string {
  return JSON.stringify(list);
}

/** Storage subset used here; `localStorage` satisfies it. */
export interface RecentFilesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadRecentFiles(storage: RecentFilesStorage): RecentFile[] {
  try {
    return parseRecentFiles(storage.getItem(RECENT_FILES_STORAGE_KEY));
  } catch {
    // Private-mode browsers and locked-down WebViews can throw on access.
    return [];
  }
}

export function saveRecentFiles(
  storage: RecentFilesStorage,
  list: readonly RecentFile[],
): void {
  try {
    storage.setItem(RECENT_FILES_STORAGE_KEY, serializeRecentFiles(list));
  } catch {
    // A full or unavailable store must not break opening a document.
  }
}
