import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { exists, readFile } from "@tauri-apps/plugin-fs";

/**
 * All file I/O goes through the Tauri plugins (see docs/design.md): the WebView
 * never touches the filesystem directly.
 */

export class PdfFileMissingError extends Error {
  constructor(readonly path: string) {
    super(`File not found: ${path}`);
    this.name = "PdfFileMissingError";
  }
}

/** Shows the OS file picker. Returns null when the user cancels. */
export async function pickPdfFile(): Promise<string | null> {
  const selected = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  return typeof selected === "string" ? selected : null;
}

/**
 * Security-scoped bookmark for `path` (issue #11), so a document picked on
 * iOS can still be opened after the app relaunches. `create_bookmark` returns
 * `null` on every other platform, where a saved path keeps working on its own
 * and no bookmark is needed. A failure also becomes `null`: a bookmark is a
 * convenience for the *next* launch, and failing to make one must not stop
 * the file the reader just picked from opening now.
 */
export async function createBookmarkFor(path: string): Promise<string | null> {
  try {
    return await invoke<string | null>("create_bookmark", { path });
  } catch {
    return null;
  }
}

/**
 * Resolves a bookmark from {@link createBookmarkFor} back to a readable
 * `file://` URL. Returns `null` both off iOS and when resolution fails (a
 * moved or deleted file, a bookmark from a build too old to read) — either
 * way the caller falls back to the path the bookmark was made for.
 */
export async function resolveBookmark(
  bookmark: string,
): Promise<string | null> {
  try {
    return await invoke<string | null>("resolve_bookmark", { bookmark });
  } catch {
    return null;
  }
}

/**
 * Registers `path` with the backend's sidecar allow-list (issue #40), so
 * `save_notes` / `save_annotations` / `save_clip` / `load_clip` on this
 * pdf_path are permitted afterward — `fs:scope` only gates plugin-fs's own
 * reads, not those commands' writes. A thin wrapper only: unlike
 * {@link createBookmarkFor} and {@link resolveBookmark}, a failure here is
 * not swallowed — it is up to the caller (see `openPath` in App.tsx) to
 * decide how non-fatal that is.
 */
export async function registerPdfPath(path: string): Promise<void> {
  await invoke<void>("register_pdf_path", { path });
}

export async function pdfFileExists(path: string): Promise<boolean> {
  try {
    return await exists(path);
  } catch {
    return false;
  }
}

/** Reads a PDF's bytes, failing loudly when the file has moved or been deleted. */
export async function readPdfFile(path: string): Promise<Uint8Array> {
  if (!(await pdfFileExists(path))) throw new PdfFileMissingError(path);
  return readFile(path);
}

/**
 * Reads a PDF, preferring the path a bookmark resolves to over the saved
 * one. iOS can relocate a picked file's container between launches, so the
 * path a recent-files entry remembers may no longer be it — the bookmark, if
 * one was saved, is resolved fresh instead. Falls back to `path` when there
 * is no bookmark, resolution fails, or the resolved location turns out not to
 * be readable either.
 */
export async function readPdfFileWithBookmark(
  path: string,
  bookmark?: string,
): Promise<Uint8Array> {
  if (bookmark) {
    const resolved = await resolveBookmark(bookmark);
    if (resolved) {
      try {
        return await readPdfFile(resolved);
      } catch (cause) {
        if (!(cause instanceof PdfFileMissingError)) throw cause;
        // Falls through to the saved path below.
      }
    }
  }
  return readPdfFile(path);
}
