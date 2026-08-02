import { useEffect, useState } from "react";
import { readPdfFile } from "../files/open";
import { loadDefaultRenderer } from "../pdf";

/** Width a cover is rendered at, in CSS pixels. */
const COVER_WIDTH = 160;

/**
 * Rendered covers, keyed by file path, kept for the app's lifetime. A cover
 * costs a full document open just to read its first page, so once painted it
 * is never redone — including across a grid/list toggle that unmounts and
 * remounts every tile.
 */
const coverCache = new Map<string, string>();

interface PdfCoverProps {
  path: string;
  name: string;
}

type CoverState =
  | { status: "loading" }
  | { status: "ready"; src: string }
  | { status: "failed" };

/**
 * A library tile's cover image: the document's first page, rendered once and
 * cached. Falls back to a placeholder when the file cannot be read or
 * rendered, which is never treated as a hard error — the file is still
 * openable from the list view.
 */
export function PdfCover({ path, name }: PdfCoverProps) {
  const cached = coverCache.get(path);
  const [state, setState] = useState<CoverState>(
    cached ? { status: "ready", src: cached } : { status: "loading" },
  );

  useEffect(() => {
    const fromCache = coverCache.get(path);
    if (fromCache) {
      setState({ status: "ready", src: fromCache });
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });

    void (async () => {
      const bytes = await readPdfFile(path);
      const renderer = await loadDefaultRenderer();
      const doc = await renderer.open(bytes);
      try {
        const size = await doc.getPageSize(1);
        const scale = size.width > 0 ? COVER_WIDTH / size.width : 1;
        const canvas = document.createElement("canvas");
        await doc.renderPage(1, { scale, canvas });
        if (cancelled) return;
        const src = canvas.toDataURL("image/png");
        coverCache.set(path, src);
        setState({ status: "ready", src });
      } finally {
        void doc.destroy();
      }
    })().catch(() => {
      if (!cancelled) setState({ status: "failed" });
    });

    return () => {
      cancelled = true;
    };
  }, [path]);

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
