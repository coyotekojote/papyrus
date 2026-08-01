import type { OutlineNode } from "./types";

/** A pdf.js outline item, narrowed to the fields the resolver needs. */
export interface RawOutlineItem {
  title?: string;
  dest?: string | unknown[] | null;
  items?: RawOutlineItem[];
}

/** A pdf.js object reference, as it appears at the head of a destination array. */
export interface PageRef {
  num: number;
  gen: number;
}

/** The slice of `PDFDocumentProxy` needed to turn destinations into pages. */
export interface DestinationLookup {
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: PageRef): Promise<number>;
}

function isPageRef(value: unknown): value is PageRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PageRef).num === "number" &&
    typeof (value as PageRef).gen === "number"
  );
}

/**
 * 1-based page a destination points at, or null when it cannot be resolved.
 *
 * Named destinations need a lookup in the document's name tree; explicit ones
 * carry their target directly, either as a page reference or — for documents
 * assembled from page indices — as a plain number.
 */
async function resolvePageNumber(
  dest: string | unknown[] | null | undefined,
  doc: DestinationLookup,
): Promise<number | null> {
  if (dest == null) return null;
  try {
    const explicit =
      typeof dest === "string" ? await doc.getDestination(dest) : dest;
    const target = explicit?.[0];
    if (typeof target === "number") {
      return Number.isInteger(target) && target >= 0 ? target + 1 : null;
    }
    if (isPageRef(target)) {
      // Guard the engine's answer too: a broken document can yield an index
      // that is negative or fractional, which must not become a "page".
      const index = await doc.getPageIndex(target);
      return Number.isInteger(index) && index >= 0 ? index + 1 : null;
    }
    return null;
  } catch {
    // A broken bookmark must not take the whole outline down with it.
    return null;
  }
}

/**
 * Converts a pdf.js outline into the engine-agnostic tree, resolving every
 * destination to a page number. Nodes that cannot be resolved are kept with a
 * null `pageNumber` so the tree still reflects the document's structure.
 *
 * Destinations resolve in batches of `chunkSize`, mirroring `loadPageSizes`:
 * each lookup is a worker round-trip, and a huge outline must not fire them
 * all at once.
 */
export async function resolveOutline(
  items: readonly RawOutlineItem[] | null | undefined,
  doc: DestinationLookup,
  chunkSize = 32,
): Promise<OutlineNode[]> {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError(
      `chunkSize must be a positive integer, got ${chunkSize}`,
    );
  }

  // Build the whole tree synchronously first; only the page lookups are async.
  const pending: { node: OutlineNode; dest: RawOutlineItem["dest"] }[] = [];
  const build = (
    raw: readonly RawOutlineItem[] | null | undefined,
  ): OutlineNode[] =>
    (raw ?? []).map((item) => {
      const node: OutlineNode = {
        title: item.title ?? "",
        pageNumber: null,
        children: build(item.items),
      };
      if (item.dest != null) pending.push({ node, dest: item.dest });
      return node;
    });

  const nodes = build(items);
  for (let start = 0; start < pending.length; start += chunkSize) {
    await Promise.all(
      pending.slice(start, start + chunkSize).map(async ({ node, dest }) => {
        node.pageNumber = await resolvePageNumber(dest, doc);
      }),
    );
  }
  return nodes;
}
