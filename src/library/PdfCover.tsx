import { useCallback, useEffect, useState } from "react";
import { readPdfFile } from "../files/open";
import { MAX_RECENT_FILES } from "../files/recent";
import { LruCache, loadDefaultRenderer } from "../pdf";

/** Width a cover is rendered at, in CSS pixels. */
const COVER_WIDTH = 160;

/**
 * Rendered covers, keyed by file path. A cover costs a full document open just
 * to read its first page, so once painted it is not redone — including across
 * a grid/list toggle, which unmounts and remounts every tile.
 *
 * Held to the number of files the library can show at once: everything on
 * screen therefore stays cached, while a path that has aged out of the recent
 * list stops holding onto its PNG data URL.
 */
const coverCache = new LruCache<string, string>(MAX_RECENT_FILES);

/**
 * Covers are rendered one at a time. Each one opens a document of its own, and
 * pdf.js puts up a worker per document (`PDFWorker.create` runs per loading
 * task), so painting a whole library at once would run as many workers as
 * there are tiles.
 */
let coverQueue: Promise<void> = Promise.resolve();

/** Renders a document's first page and resolves to it as a data URL. */
async function renderCover(path: string): Promise<string> {
  const bytes = await readPdfFile(path);
  const renderer = await loadDefaultRenderer();
  const doc = await renderer.open(bytes);
  try {
    const size = await doc.getPageSize(1);
    const scale = size.width > 0 ? COVER_WIDTH / size.width : 1;
    const canvas = document.createElement("canvas");
    await doc.renderPage(1, { scale, canvas });
    return canvas.toDataURL("image/png");
  } finally {
    // Nobody waits on the teardown, but a rejection with no handler would
    // still surface as an unhandled one.
    doc.destroy().catch(() => {});
  }
}

interface PdfCoverProps {
  path: string;
  name: string;
}

/**
 * Tagged with the file it describes, so a cover that finishes rendering after
 * the tile has moved on to another path is dropped rather than painted over
 * the new one.
 */
type CoverState = { readonly path: string } & (
  | { status: "loading" }
  | { status: "ready"; src: string }
  | { status: "failed" }
);

function newState(path: string): CoverState {
  const cached = coverCache.get(path);
  return cached
    ? { path, status: "ready", src: cached }
    : { path, status: "loading" };
}

/**
 * A library tile's cover image: the document's first page, rendered once and
 * cached. Falls back to a placeholder when the file cannot be read or
 * rendered, which is never treated as a hard error — the file is still
 * openable from the list view.
 */
export function PdfCover({ path, name }: PdfCoverProps) {
  const cached = coverCache.get(path);
  const [state, setState] = useState<CoverState>(() => newState(path));

  // A tile is normally keyed by its path, so `path` changing under one is the
  // exception rather than the rule — but when it does happen the previous
  // file's cover must not stay on screen. Reset while rendering (React's
  // "adjusting state when a prop changes" pattern) rather than from an effect,
  // which would paint the stale cover for a frame first.
  if (state.path !== path) setState(newState(path));

  /**
   * Applies a result to the cover of `path`, and only while that is still the
   * file this tile shows. The check reads the state React is actually holding
   * rather than the `cancelled` flag below: cancelling happens in the effect
   * cleanup, which does not run until well after `path` has changed, so a
   * render finishing in between would otherwise land on the wrong file.
   */
  const apply = useCallback(
    (next: CoverState) =>
      setState((current) => (current.path === next.path ? next : current)),
    [],
  );

  useEffect(() => {
    // Already painted from the cache; nothing to open.
    if (cached) return;

    let cancelled = false;

    // Queued rather than started here, so a library's worth of tiles opens one
    // document at a time. A tile that goes away before its turn — filtered out
    // by the search box, or switched to the list view — never opens one at all.
    coverQueue = coverQueue.then(async () => {
      if (cancelled) return;
      try {
        const src = await renderCover(path);
        coverCache.set(path, src);
        if (!cancelled) apply({ path, status: "ready", src });
      } catch (cause) {
        // The placeholder says a cover is missing but not why, and a reader
        // has no way to ask. A corrupt file, a permission error and a renderer
        // that failed to start all look alike on screen, so the reason goes to
        // the console — the one place left to tell them apart.
        console.error(`Failed to render the cover for ${path}`, cause);
        if (!cancelled) apply({ path, status: "failed" });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [apply, path, cached]);

  if (state.status === "ready") {
    return <img className="cover__image" src={state.src} alt="" />;
  }
  return (
    <div
      className={`cover__placeholder${
        state.status === "failed" ? " cover__placeholder--failed" : ""
      }`}
      aria-hidden="true"
    >
      {state.status === "failed" ? name.slice(0, 1).toUpperCase() : null}
    </div>
  );
}
