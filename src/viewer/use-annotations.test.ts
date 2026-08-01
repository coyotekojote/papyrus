import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SidecarConflictError,
  emptyAnnotations,
  loadAnnotations,
  loadNotes,
  saveAnnotations,
  saveNotes,
  type Annotations,
  type Highlight,
} from "../files/sidecar";
import { appendHighlightToNotes, useAnnotations } from "./use-annotations";

vi.mock("../files/sidecar", async (importActual) => {
  const actual = await importActual<typeof import("../files/sidecar")>();
  return {
    ...actual,
    loadAnnotations: vi.fn(),
    saveAnnotations: vi.fn(),
    loadNotes: vi.fn(),
    saveNotes: vi.fn(),
  };
});

const PATH = "/papers/paper.pdf";

function highlight(id: string, page = 1): Highlight {
  return {
    id,
    page,
    rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.02 }],
    color: "yellow",
    text: `text-${id}`,
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

function withHighlights(...highlights: Highlight[]): Annotations {
  return { ...emptyAnnotations(), highlights };
}

beforeEach(() => {
  vi.mocked(loadAnnotations).mockReset();
  vi.mocked(saveAnnotations).mockReset();
  vi.mocked(loadNotes).mockReset();
  vi.mocked(saveNotes).mockReset();
});

describe("useAnnotations", () => {
  it("loads the sidecar annotations on mount", async () => {
    vi.mocked(loadAnnotations).mockResolvedValue({
      annotations: withHighlights(highlight("disk")),
      modifiedAtMs: 111,
    });

    const { result } = renderHook(() => useAnnotations(PATH));
    expect(result.current.loaded).toBe(false);

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.annotations.highlights.map((h) => h.id)).toEqual([
      "disk",
    ]);
    expect(loadAnnotations).toHaveBeenCalledWith(PATH);
  });

  it("surfaces a load failure", async () => {
    vi.mocked(loadAnnotations).mockRejectedValue(new Error("壊れています"));

    const { result } = renderHook(() => useAnnotations(PATH));

    await waitFor(() => expect(result.current.error).toBe("壊れています"));
    expect(result.current.loaded).toBe(false);
  });

  it("applies a highlight optimistically and saves it with the loaded mtime", async () => {
    vi.mocked(loadAnnotations).mockResolvedValue({
      annotations: emptyAnnotations(),
      modifiedAtMs: 111,
    });
    vi.mocked(saveAnnotations).mockResolvedValue(222);

    const { result } = renderHook(() => useAnnotations(PATH));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.addHighlight(highlight("new")));

    expect(result.current.annotations.highlights.map((h) => h.id)).toEqual([
      "new",
    ]);
    await waitFor(() => expect(saveAnnotations).toHaveBeenCalledOnce());
    expect(vi.mocked(saveAnnotations).mock.calls[0][1].highlights).toHaveLength(
      1,
    );
    expect(vi.mocked(saveAnnotations).mock.calls[0][2]).toBe(111);
  });

  it("chains the next save onto the new mtime", async () => {
    vi.mocked(loadAnnotations).mockResolvedValue({
      annotations: emptyAnnotations(),
      modifiedAtMs: 111,
    });
    vi.mocked(saveAnnotations)
      .mockResolvedValueOnce(222)
      .mockResolvedValueOnce(333);

    const { result } = renderHook(() => useAnnotations(PATH));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.addHighlight(highlight("a")));
    await waitFor(() => expect(saveAnnotations).toHaveBeenCalledOnce());
    act(() => result.current.addHighlight(highlight("b")));
    await waitFor(() => expect(saveAnnotations).toHaveBeenCalledTimes(2));

    expect(vi.mocked(saveAnnotations).mock.calls[1][2]).toBe(222);
  });

  it("rebases local changes onto the disk contents when the save conflicts", async () => {
    vi.mocked(loadAnnotations)
      .mockResolvedValueOnce({
        annotations: emptyAnnotations(),
        modifiedAtMs: 111,
      })
      // The reload after the conflict finds another device's highlight.
      .mockResolvedValueOnce({
        annotations: withHighlights(highlight("remote")),
        modifiedAtMs: 500,
      });
    vi.mocked(saveAnnotations)
      .mockRejectedValueOnce(new SidecarConflictError("annotations.json"))
      .mockResolvedValueOnce(600);

    const { result } = renderHook(() => useAnnotations(PATH));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.addHighlight(highlight("local")));

    await waitFor(() => expect(saveAnnotations).toHaveBeenCalledTimes(2));
    const retried = vi.mocked(saveAnnotations).mock.calls[1];
    expect(retried[1].highlights.map((h) => h.id)).toEqual(["remote", "local"]);
    expect(retried[2]).toBe(500);
    await waitFor(() =>
      expect(result.current.annotations.highlights.map((h) => h.id)).toEqual([
        "remote",
        "local",
      ]),
    );
    expect(result.current.error).toBeNull();
  });

  it("keeps saving after a conflict whose reload fails", async () => {
    vi.mocked(loadAnnotations)
      .mockResolvedValueOnce({
        annotations: emptyAnnotations(),
        modifiedAtMs: 111,
      })
      // The rebase reload fails (e.g. the sidecar folder became unreadable)…
      .mockRejectedValueOnce(new Error("読めません"))
      // …but recovers by the time the next mutation flushes.
      .mockResolvedValueOnce({
        annotations: emptyAnnotations(),
        modifiedAtMs: 700,
      });
    vi.mocked(saveAnnotations)
      .mockRejectedValueOnce(new SidecarConflictError("annotations.json"))
      .mockRejectedValueOnce(new SidecarConflictError("annotations.json"))
      .mockResolvedValueOnce(800);

    const { result } = renderHook(() => useAnnotations(PATH));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.addHighlight(highlight("first")));
    await waitFor(() => expect(result.current.error).toBe("読めません"));

    // A rejected flush must not poison the queue: the next mutation still
    // flushes (and carries the first one with it).
    act(() => result.current.addHighlight(highlight("second")));

    await waitFor(() => expect(saveAnnotations).toHaveBeenCalledTimes(3));
    expect(
      vi.mocked(saveAnnotations).mock.calls[2][1].highlights.map((h) => h.id),
    ).toEqual(["first", "second"]);
    expect(vi.mocked(saveAnnotations).mock.calls[2][2]).toBe(700);
  });

  it("keeps saving when each save has another edit land while in flight", async () => {
    vi.mocked(loadAnnotations).mockResolvedValue({
      annotations: emptyAnnotations(),
      modifiedAtMs: 111,
    });
    // Every save hangs until released, so each one can have an edit land
    // mid-flight — keeping a single flush() looping without any conflict.
    const releases: ((value: number) => void)[] = [];
    let mtime = 200;
    vi.mocked(saveAnnotations).mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          releases.push(() => resolve((mtime += 1)));
        }),
    );

    const { result } = renderHook(() => useAnnotations(PATH));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.addHighlight(highlight("a")));
    await waitFor(() => expect(releases).toHaveLength(1));

    for (const id of ["b", "c", "d"]) {
      act(() => result.current.addHighlight(highlight(id)));
      const saves = releases.length;
      await act(async () => releases[saves - 1](0));
      // The edit made mid-flight keeps the same flush() looping.
      await waitFor(() => expect(releases).toHaveLength(saves + 1));
    }

    await act(async () => releases.at(-1)?.(0));

    expect(result.current.error).toBeNull();
    expect(
      vi
        .mocked(saveAnnotations)
        .mock.calls.at(-1)?.[1]
        .highlights.map((h) => h.id),
    ).toEqual(["a", "b", "c", "d"]);
  });

  it("gives up with an error when every retry keeps conflicting", async () => {
    vi.mocked(loadAnnotations).mockResolvedValue({
      annotations: emptyAnnotations(),
      modifiedAtMs: 111,
    });
    vi.mocked(saveAnnotations).mockRejectedValue(
      new SidecarConflictError("annotations.json"),
    );

    const { result } = renderHook(() => useAnnotations(PATH));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.addHighlight(highlight("doomed")));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(saveAnnotations).toHaveBeenCalledTimes(3);
  });

  it("surfaces a non-conflict save failure", async () => {
    vi.mocked(loadAnnotations).mockResolvedValue({
      annotations: emptyAnnotations(),
      modifiedAtMs: 111,
    });
    vi.mocked(saveAnnotations).mockRejectedValue(new Error("ディスクが満杯"));

    const { result } = renderHook(() => useAnnotations(PATH));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.addHighlight(highlight("x")));

    await waitFor(() => expect(result.current.error).toBe("ディスクが満杯"));
  });

  it("ignores a load that resolves after the path changed", async () => {
    let resolveFirst!: (value: {
      annotations: Annotations;
      modifiedAtMs: number | null;
    }) => void;
    vi.mocked(loadAnnotations)
      .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce({
        annotations: withHighlights(highlight("second-doc")),
        modifiedAtMs: 900,
      });

    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => useAnnotations(path),
      { initialProps: { path: PATH } },
    );

    rerender({ path: "/papers/other.pdf" });
    await waitFor(() =>
      expect(result.current.annotations.highlights.map((h) => h.id)).toEqual([
        "second-doc",
      ]),
    );

    // The first document's load finally lands; it belongs to a document the
    // reader has left and must not overwrite the current one.
    await act(async () => {
      resolveFirst({
        annotations: withHighlights(highlight("first-doc")),
        modifiedAtMs: 100,
      });
    });

    expect(result.current.annotations.highlights.map((h) => h.id)).toEqual([
      "second-doc",
    ]);

    // The stale mtime must not leak into the next save either.
    vi.mocked(saveAnnotations).mockResolvedValue(901);
    act(() => result.current.addHighlight(highlight("added")));
    await waitFor(() => expect(saveAnnotations).toHaveBeenCalledOnce());
    expect(vi.mocked(saveAnnotations).mock.calls[0][0]).toBe(
      "/papers/other.pdf",
    );
    expect(vi.mocked(saveAnnotations).mock.calls[0][2]).toBe(900);
  });

  it("ignores mutations before the initial load resolves", async () => {
    let resolveLoad!: (value: {
      annotations: Annotations;
      modifiedAtMs: number | null;
    }) => void;
    vi.mocked(loadAnnotations).mockReturnValue(
      new Promise((resolve) => (resolveLoad = resolve)),
    );

    const { result } = renderHook(() => useAnnotations(PATH));
    act(() => result.current.addHighlight(highlight("early")));

    expect(result.current.annotations.highlights).toHaveLength(0);

    await act(async () => {
      resolveLoad({
        annotations: withHighlights(highlight("disk")),
        modifiedAtMs: 1,
      });
    });
    expect(result.current.annotations.highlights.map((h) => h.id)).toEqual([
      "disk",
    ]);
    expect(saveAnnotations).not.toHaveBeenCalled();
  });
});

describe("appendHighlightToNotes", () => {
  it("appends the quote to the loaded notes", async () => {
    vi.mocked(loadNotes).mockResolvedValue({
      content: "# メモ",
      modifiedAtMs: 10,
    });
    vi.mocked(saveNotes).mockResolvedValue(11);

    await appendHighlightToNotes(PATH, highlight("q", 4));

    expect(saveNotes).toHaveBeenCalledWith(
      PATH,
      "# メモ\n\n> text-q\n>\n> — p.4\n",
      10,
    );
  });

  it("reloads and retries once when the notes changed meanwhile", async () => {
    vi.mocked(loadNotes)
      .mockResolvedValueOnce({ content: "", modifiedAtMs: null })
      .mockResolvedValueOnce({ content: "他端末の追記", modifiedAtMs: 20 });
    vi.mocked(saveNotes)
      .mockRejectedValueOnce(new SidecarConflictError("notes.md"))
      .mockResolvedValueOnce(21);

    await appendHighlightToNotes(PATH, highlight("q", 2));

    expect(saveNotes).toHaveBeenCalledTimes(2);
    expect(vi.mocked(saveNotes).mock.calls[1][1]).toBe(
      "他端末の追記\n\n> text-q\n>\n> — p.2\n",
    );
    expect(vi.mocked(saveNotes).mock.calls[1][2]).toBe(20);
  });

  it("propagates a second conflict instead of looping", async () => {
    vi.mocked(loadNotes).mockResolvedValue({ content: "", modifiedAtMs: 1 });
    vi.mocked(saveNotes).mockRejectedValue(
      new SidecarConflictError("notes.md"),
    );

    await expect(appendHighlightToNotes(PATH, highlight("q"))).rejects.toThrow(
      SidecarConflictError,
    );
    expect(saveNotes).toHaveBeenCalledTimes(2);
  });
});
