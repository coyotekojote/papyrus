import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import {
  ANNOTATIONS_VERSION,
  emptyAnnotations,
  loadAnnotations,
  loadNotes,
  saveAnnotations,
  saveNotes,
  sidecarStatus,
  SidecarConflictError,
  type Annotations,
} from "./sidecar";

const PDF = "/Papers/attention.pdf";

function sampleAnnotations(): Annotations {
  return {
    version: 1,
    highlights: [
      {
        id: "hl-1",
        page: 3,
        rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.02 }],
        color: "yellow",
        text: "抽出されたテキスト",
        createdAt: "2026-08-01T00:00:00Z",
      },
    ],
    clips: [],
  };
}

beforeEach(() => {
  invoke.mockReset();
});

describe("emptyAnnotations", () => {
  it("returns a v1 document with no entries", () => {
    expect(emptyAnnotations()).toEqual({
      version: ANNOTATIONS_VERSION,
      highlights: [],
      clips: [],
    });
  });

  it("returns a fresh object each call", () => {
    const a = emptyAnnotations();
    a.highlights.push(sampleAnnotations().highlights[0]);
    expect(emptyAnnotations().highlights).toEqual([]);
  });
});

describe("loadAnnotations", () => {
  it("passes the path and returns the backend payload", async () => {
    const payload = { annotations: sampleAnnotations(), modifiedAtMs: 1234 };
    invoke.mockResolvedValueOnce(payload);

    await expect(loadAnnotations(PDF)).resolves.toEqual(payload);
    expect(invoke).toHaveBeenCalledWith("load_annotations", { pdfPath: PDF });
  });

  it("wraps backend errors with their kind and detail", async () => {
    invoke.mockRejectedValueOnce({
      kind: "unsupportedVersion",
      found: 2,
      supported: 1,
    });

    await expect(loadAnnotations(PDF)).rejects.toThrow(
      "Sidecar unsupportedVersion: version 2 (supported: 1)",
    );
  });
});

describe("saveAnnotations", () => {
  it("sends annotations with the base mtime and resolves to the new mtime", async () => {
    invoke.mockResolvedValueOnce(5678);
    const annotations = sampleAnnotations();

    await expect(saveAnnotations(PDF, annotations, 1234)).resolves.toBe(5678);
    expect(invoke).toHaveBeenCalledWith("save_annotations", {
      pdfPath: PDF,
      annotations,
      baseModifiedAtMs: 1234,
    });
  });

  it("sends null base mtime for a first save", async () => {
    invoke.mockResolvedValueOnce(1);
    await saveAnnotations(PDF, emptyAnnotations(), null);
    expect(invoke).toHaveBeenCalledWith("save_annotations", {
      pdfPath: PDF,
      annotations: emptyAnnotations(),
      baseModifiedAtMs: null,
    });
  });

  it("rejects with SidecarConflictError on an external change", async () => {
    invoke.mockRejectedValueOnce({
      kind: "conflict",
      path: "/Papers/attention.papyrus/annotations.json",
    });

    const failure = saveAnnotations(PDF, emptyAnnotations(), 1234);
    await expect(failure).rejects.toBeInstanceOf(SidecarConflictError);
    await expect(failure).rejects.toMatchObject({
      path: "/Papers/attention.papyrus/annotations.json",
    });
  });
});

describe("notes", () => {
  it("loads content with its mtime", async () => {
    invoke.mockResolvedValueOnce({ content: "# メモ", modifiedAtMs: 42 });

    await expect(loadNotes(PDF)).resolves.toEqual({
      content: "# メモ",
      modifiedAtMs: 42,
    });
    expect(invoke).toHaveBeenCalledWith("load_notes", { pdfPath: PDF });
  });

  it("saves content with the base mtime", async () => {
    invoke.mockResolvedValueOnce(99);

    await expect(saveNotes(PDF, "本文", 42)).resolves.toBe(99);
    expect(invoke).toHaveBeenCalledWith("save_notes", {
      pdfPath: PDF,
      content: "本文",
      baseModifiedAtMs: 42,
    });
  });

  it("rejects with SidecarConflictError when notes changed on disk", async () => {
    invoke.mockRejectedValueOnce({ kind: "conflict", path: "notes.md" });
    await expect(saveNotes(PDF, "本文", 42)).rejects.toBeInstanceOf(
      SidecarConflictError,
    );
  });
});

describe("sidecarStatus", () => {
  it("returns both mtimes for change polling", async () => {
    invoke.mockResolvedValueOnce({
      notesModifiedAtMs: 10,
      annotationsModifiedAtMs: null,
    });

    await expect(sidecarStatus(PDF)).resolves.toEqual({
      notesModifiedAtMs: 10,
      annotationsModifiedAtMs: null,
    });
    expect(invoke).toHaveBeenCalledWith("sidecar_status", { pdfPath: PDF });
  });
});

describe("error mapping", () => {
  it("passes through plain Error rejections", async () => {
    invoke.mockRejectedValueOnce(new Error("ipc down"));
    await expect(loadNotes(PDF)).rejects.toThrow("ipc down");
  });

  it("converts non-object rejections to Error", async () => {
    invoke.mockRejectedValueOnce("boom");
    await expect(loadNotes(PDF)).rejects.toThrow("boom");
  });
});
