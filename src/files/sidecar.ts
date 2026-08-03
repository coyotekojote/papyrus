import { invoke } from "@tauri-apps/api/core";

/**
 * Frontend wrapper for the Rust sidecar storage layer (issue #5).
 *
 * Notes and annotations live next to the PDF in `<name>.papyrus/` so iCloud
 * Drive syncs them between devices. Every load returns the file's mtime;
 * passing it back to save lets the backend reject writes that would clobber
 * an edit synced from another device (SidecarConflictError → reload first).
 */

export const ANNOTATIONS_VERSION = 1;

/** Normalized (0-1) page coordinates, zoom/device independent. */
export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Highlight {
  id: string;
  page: number;
  rects: NormalizedRect[];
  color: string;
  text: string;
  createdAt: string;
}

export interface Clip {
  id: string;
  page: number;
  rect: NormalizedRect;
  /** Path relative to the sidecar folder, e.g. `clips/clip-0001.png`. */
  file: string;
  createdAt: string;
}

export interface Annotations {
  version: number;
  highlights: Highlight[];
  clips: Clip[];
}

export interface LoadedAnnotations {
  annotations: Annotations;
  /** null when annotations.json does not exist yet. */
  modifiedAtMs: number | null;
}

export interface LoadedNotes {
  content: string;
  /** null when notes.md does not exist yet. */
  modifiedAtMs: number | null;
}

/** Snapshot of sidecar file mtimes, for polling external (iCloud) changes. */
export interface SidecarStatus {
  notesModifiedAtMs: number | null;
  annotationsModifiedAtMs: number | null;
}

interface BackendError {
  kind: string;
  path?: string;
  found?: number;
  supported?: number;
  message?: string;
}

/** The file changed on disk since it was loaded — reload before saving. */
export class SidecarConflictError extends Error {
  constructor(readonly path: string) {
    super(`Sidecar file changed on disk: ${path}`);
    this.name = "SidecarConflictError";
  }
}

export function emptyAnnotations(): Annotations {
  return { version: ANNOTATIONS_VERSION, highlights: [], clips: [] };
}

function isBackendError(error: unknown): error is BackendError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as BackendError).kind === "string"
  );
}

function toError(error: unknown): Error {
  if (isBackendError(error)) {
    if (error.kind === "conflict") {
      return new SidecarConflictError(error.path ?? "");
    }
    const detail =
      error.message ??
      error.path ??
      (error.found !== undefined
        ? `version ${error.found} (supported: ${error.supported})`
        : "");
    return new Error(`Sidecar ${error.kind}: ${detail}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function invokeSidecar<T>(
  command: string,
  args: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toError(error);
  }
}

export function loadAnnotations(pdfPath: string): Promise<LoadedAnnotations> {
  return invokeSidecar("load_annotations", { pdfPath });
}

/**
 * Saves and resolves to the new mtime. Pass the mtime from the last load
 * (null when the file did not exist); a mismatch with the file on disk
 * rejects with SidecarConflictError.
 */
export function saveAnnotations(
  pdfPath: string,
  annotations: Annotations,
  baseModifiedAtMs: number | null,
): Promise<number> {
  return invokeSidecar("save_annotations", {
    pdfPath,
    annotations,
    baseModifiedAtMs,
  });
}

export function loadNotes(pdfPath: string): Promise<LoadedNotes> {
  return invokeSidecar("load_notes", { pdfPath });
}

/** Same conflict contract as {@link saveAnnotations}. */
export function saveNotes(
  pdfPath: string,
  content: string,
  baseModifiedAtMs: number | null,
): Promise<number> {
  return invokeSidecar("save_notes", { pdfPath, content, baseModifiedAtMs });
}

/**
 * Writes a clipped figure into the sidecar's `clips/` folder and resolves to
 * its path relative to that folder, as `annotations.json` and the note's
 * `![](...)` both record it. The backend picks the name, so clips need none of
 * the mtime handshake the two shared files do — a clip is only ever created.
 *
 * The PNG goes over as base64: Tauri carries command arguments as JSON, where
 * a byte array would become one number per byte.
 */
export function saveClip(pdfPath: string, pngBase64: string): Promise<string> {
  return invokeSidecar("save_clip", { pdfPath, pngBase64 });
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "Array";
  if (typeof value === "object") return value.constructor?.name ?? "object";
  return typeof value;
}

/**
 * Reads a clip back, for showing it in the notes preview. `file` is a path
 * relative to the sidecar folder; the backend refuses anything pointing out
 * of it.
 *
 * `load_clip` is the only command returning a raw `tauri::ipc::Response`
 * rather than JSON. If the CSP blocks the IPC protocol's fetch, Tauri falls
 * back to a postMessage path that mangles this response instead of throwing
 * — so the bytes must be checked explicitly, or a broken clip surfaces only
 * as a corrupt image with no error anywhere (issue #42).
 */
export async function loadClip(
  pdfPath: string,
  file: string,
): Promise<ArrayBuffer> {
  const bytes = await invokeSidecar<unknown>("load_clip", { pdfPath, file });
  if (Object.prototype.toString.call(bytes) !== "[object ArrayBuffer]") {
    throw new Error(
      `load_clip returned ${describeType(bytes)} instead of ArrayBuffer`,
    );
  }
  return bytes;
}

export function sidecarStatus(pdfPath: string): Promise<SidecarStatus> {
  return invokeSidecar("sidecar_status", { pdfPath });
}
