import { useEffect, useRef, useState } from "react";
import { loadClip } from "../files/sidecar";

/**
 * Blob URLs for the clips a note references (issue #8).
 *
 * The WebView cannot fetch `clips/clip-0001.png` itself — the sidecar folder
 * is somewhere on disk, not under the app's origin — so the bytes come through
 * the backend and become blob URLs, which the app's CSP already allows. That
 * beats opening Tauri's asset protocol for the whole filesystem, and it is the
 * same path on iOS, where the sandbox rules out the alternatives anyway.
 *
 * Only clips recorded in annotations.json are loaded. An image a reader added
 * to the note by hand in another editor keeps showing its alt text; the app has
 * no way to tell what it points at.
 */
export function useClipImages(
  pdfPath: string,
  /** Sidecar-relative paths, memoized by the caller — an effect depends on it. */
  files: readonly string[],
  /** False while the preview is hidden: an unread clip is not worth reading. */
  enabled: boolean,
): ReadonlyMap<string, string> {
  const [images, setImages] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const urlsRef = useRef<Map<string, string>>(new Map());

  // Every URL belongs to one document. Leaving them alive across a switch
  // would both leak the bytes and let the previous document's figures show up
  // in the next one's note.
  useEffect(() => {
    return () => {
      for (const url of urlsRef.current.values()) URL.revokeObjectURL(url);
      urlsRef.current = new Map();
      setImages(new Map());
    };
  }, [pdfPath]);

  useEffect(() => {
    if (!enabled) return;
    const pending = files.filter((file) => !urlsRef.current.has(file));
    if (pending.length === 0) return;

    let cancelled = false;
    void Promise.all(
      pending.map(async (file) => {
        try {
          const bytes = await loadClip(pdfPath, file);
          return [file, new Blob([bytes], { type: "image/png" })] as const;
        } catch {
          // A clip that was deleted, or never synced, is not an error worth
          // interrupting the note for: it renders as its alt text.
          return null;
        }
      }),
    ).then((loaded) => {
      // Nothing was allocated yet, so an abandoned load has nothing to free.
      if (cancelled) return;
      const next = new Map(urlsRef.current);
      for (const entry of loaded) {
        if (!entry || next.has(entry[0])) continue;
        next.set(entry[0], URL.createObjectURL(entry[1]));
      }
      urlsRef.current = next;
      setImages(next);
    });

    return () => {
      cancelled = true;
    };
  }, [enabled, files, pdfPath]);

  return images;
}
