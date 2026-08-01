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
