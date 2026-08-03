import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SidecarConflictError,
  loadNotes,
  saveNotes,
  type Highlight,
} from "../files/sidecar";
import { SAVE_DEBOUNCE_MS, useNotes } from "./use-notes";

vi.mock("../files/sidecar", async (importActual) => {
  const actual = await importActual<typeof import("../files/sidecar")>();
  return { ...actual, loadNotes: vi.fn(), saveNotes: vi.fn() };
});

const PATH = "/papers/paper.pdf";

function highlight(overrides: Partial<Highlight> = {}): Highlight {
  return {
    id: "h1",
    page: 12,
    rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.02 }],
    color: "yellow",
    text: "抜き出した本文",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Settles the promise chains the hook queues. `waitFor` polls on timers, which
 * these tests have faked to drive the debounce, so it is not usable here.
 */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

/** Renders the hook and lets the initial load settle. */
async function mountLoaded(content = "", modifiedAtMs: number | null = 111) {
  vi.mocked(loadNotes).mockResolvedValue({ content, modifiedAtMs });
  const view = renderHook(() => useNotes(PATH));
  await settle();
  expect(view.result.current.loaded).toBe(true);
  return view;
}

/** Lets the debounce elapse and the queued save run to completion. */
async function runDebouncedSave() {
  act(() => vi.advanceTimersByTime(SAVE_DEBOUNCE_MS));
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(loadNotes).mockReset();
  vi.mocked(saveNotes).mockReset();
  vi.mocked(loadNotes).mockResolvedValue({ content: "", modifiedAtMs: null });
  vi.mocked(saveNotes).mockResolvedValue(222);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useNotes", () => {
  it("loads notes.md on mount", async () => {
    const { result } = await mountLoaded("# メモ");

    expect(result.current.content).toBe("# メモ");
    expect(result.current.status).toBe("saved");
    expect(loadNotes).toHaveBeenCalledWith(PATH);
  });

  it("surfaces a load failure and stays unloaded", async () => {
    vi.mocked(loadNotes).mockRejectedValue(new Error("読めません"));

    const { result } = renderHook(() => useNotes(PATH));
    await settle();

    expect(result.current.error).toBe("読めません");
    expect(result.current.loaded).toBe(false);
    expect(result.current.status).toBe("error");
  });

  it("ignores edits made before the load finishes", async () => {
    let resolveLoad: (value: { content: string; modifiedAtMs: null }) => void;
    vi.mocked(loadNotes).mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );

    const { result } = renderHook(() => useNotes(PATH));
    act(() => result.current.setContent("早すぎる編集"));

    expect(result.current.content).toBe("");
    await act(async () => {
      resolveLoad({ content: "ディスクの内容", modifiedAtMs: null });
    });
    await runDebouncedSave();

    expect(result.current.content).toBe("ディスクの内容");
    expect(saveNotes).not.toHaveBeenCalled();
  });

  it("waits for the typing to pause before saving", async () => {
    const { result } = await mountLoaded("", 111);

    act(() => result.current.setContent("あ"));
    expect(result.current.status).toBe("unsaved");

    act(() => vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1));
    expect(saveNotes).not.toHaveBeenCalled();

    await runDebouncedSave();
    expect(saveNotes).toHaveBeenCalledWith(PATH, "あ", 111);
    expect(result.current.status).toBe("saved");
  });

  it("coalesces a burst of keystrokes into one save", async () => {
    const { result } = await mountLoaded();

    act(() => result.current.setContent("あ"));
    act(() => vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1));
    act(() => result.current.setContent("あい"));
    act(() => vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1));
    act(() => result.current.setContent("あいう"));
    await runDebouncedSave();

    expect(saveNotes).toHaveBeenCalledTimes(1);
    expect(saveNotes).toHaveBeenCalledWith(PATH, "あいう", 111);
  });

  it("passes the mtime of the previous save to the next one", async () => {
    const { result } = await mountLoaded("", 111);
    vi.mocked(saveNotes).mockResolvedValue(222);

    act(() => result.current.setContent("一回目"));
    await runDebouncedSave();
    act(() => result.current.setContent("二回目"));
    await runDebouncedSave();

    expect(vi.mocked(saveNotes).mock.calls).toEqual([
      [PATH, "一回目", 111],
      [PATH, "二回目", 222],
    ]);
  });

  it("surfaces a save failure", async () => {
    const { result } = await mountLoaded();
    vi.mocked(saveNotes).mockRejectedValue(new Error("書けません"));

    act(() => result.current.setContent("あ"));
    await runDebouncedSave();

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("書けません");
  });

  it("re-saves with the fresh mtime when only the mtime moved", async () => {
    const { result } = await mountLoaded("元の内容", 111);
    vi.mocked(saveNotes)
      .mockRejectedValueOnce(new SidecarConflictError("notes.md"))
      .mockResolvedValue(333);
    // iCloud touched the file without changing what it says.
    vi.mocked(loadNotes).mockResolvedValue({
      content: "元の内容",
      modifiedAtMs: 222,
    });

    act(() => result.current.setContent("元の内容 + 追記"));
    await runDebouncedSave();

    expect(vi.mocked(saveNotes).mock.calls).toEqual([
      [PATH, "元の内容 + 追記", 111],
      [PATH, "元の内容 + 追記", 222],
    ]);
    expect(result.current.status).toBe("saved");
    expect(result.current.conflict).toBeNull();
  });

  it("stops autosaving and asks the reader when the note changed elsewhere", async () => {
    const { result } = await mountLoaded("元の内容", 111);
    vi.mocked(saveNotes).mockRejectedValue(
      new SidecarConflictError("notes.md"),
    );
    vi.mocked(loadNotes).mockResolvedValue({
      content: "別の端末で書かれた内容",
      modifiedAtMs: 222,
    });

    act(() => result.current.setContent("こちらの内容"));
    await runDebouncedSave();

    expect(result.current.status).toBe("conflict");
    expect(result.current.conflict).toBe("別の端末で書かれた内容");
    // Neither version has been overwritten.
    expect(saveNotes).toHaveBeenCalledTimes(1);
    expect(result.current.content).toBe("こちらの内容");

    // Further edits are refused until the reader chooses.
    act(() => result.current.setContent("もっと書く"));
    await runDebouncedSave();
    expect(result.current.content).toBe("こちらの内容");
    expect(saveNotes).toHaveBeenCalledTimes(1);
  });

  it("keepLocal writes the editor's text over the file", async () => {
    const { result } = await mountLoaded("元の内容", 111);
    vi.mocked(saveNotes).mockRejectedValueOnce(
      new SidecarConflictError("notes.md"),
    );
    vi.mocked(loadNotes).mockResolvedValue({
      content: "別の端末で書かれた内容",
      modifiedAtMs: 222,
    });

    act(() => result.current.setContent("こちらの内容"));
    await runDebouncedSave();
    vi.mocked(saveNotes).mockResolvedValue(444);
    act(() => result.current.keepLocal());
    await runDebouncedSave();

    expect(result.current.conflict).toBeNull();
    expect(result.current.content).toBe("こちらの内容");
    // Retried against the file's current mtime, so the write goes through.
    expect(saveNotes).toHaveBeenLastCalledWith(PATH, "こちらの内容", 222);
    expect(result.current.status).toBe("saved");
  });

  it("takeDisk adopts the file's text and saves nothing", async () => {
    const { result } = await mountLoaded("元の内容", 111);
    vi.mocked(saveNotes).mockRejectedValue(
      new SidecarConflictError("notes.md"),
    );
    vi.mocked(loadNotes).mockResolvedValue({
      content: "別の端末で書かれた内容",
      modifiedAtMs: 222,
    });

    act(() => result.current.setContent("こちらの内容"));
    await runDebouncedSave();
    act(() => result.current.takeDisk());
    await runDebouncedSave();

    expect(result.current.content).toBe("別の端末で書かれた内容");
    expect(result.current.conflict).toBeNull();
    expect(result.current.status).toBe("saved");
    expect(saveNotes).toHaveBeenCalledTimes(1);
  });

  it("appends a highlight as a quote with its page number", async () => {
    const { result } = await mountLoaded("既存のメモ", 111);

    act(() => result.current.insertQuote(highlight()));

    expect(result.current.content).toBe(
      "既存のメモ\n\n> 抜き出した本文\n>\n> — p.12\n",
    );
    await runDebouncedSave();
    expect(saveNotes).toHaveBeenCalledWith(PATH, result.current.content, 111);
  });

  it("writes what was typed in the last debounce window when the document closes", async () => {
    const { result, unmount } = await mountLoaded("", 111);

    act(() => result.current.setContent("閉じる直前の一文"));
    unmount();
    await settle();

    expect(saveNotes).toHaveBeenCalledWith(PATH, "閉じる直前の一文", 111);
  });

  describe("initializeContent", () => {
    it("fills an empty note without scheduling a save", async () => {
      const { result } = await mountLoaded("", 111);

      act(() => result.current.initializeContent("# 見出し\n"));

      expect(result.current.content).toBe("# 見出し\n");
      expect(result.current.status).toBe("saved");
      await runDebouncedSave();
      expect(saveNotes).not.toHaveBeenCalled();
    });

    it("does not overwrite a note that already has content", async () => {
      const { result } = await mountLoaded("既存のメモ", 111);

      act(() => result.current.initializeContent("# 見出し\n"));

      expect(result.current.content).toBe("既存のメモ");
      await runDebouncedSave();
      expect(saveNotes).not.toHaveBeenCalled();
    });

    it("is ignored before the initial load finishes", async () => {
      let resolveLoad: (value: { content: string; modifiedAtMs: null }) => void;
      vi.mocked(loadNotes).mockReturnValue(
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
      );

      const { result } = renderHook(() => useNotes(PATH));
      act(() => result.current.initializeContent("# 見出し\n"));

      expect(result.current.content).toBe("");
      await act(async () => {
        resolveLoad({ content: "", modifiedAtMs: null });
      });

      // The load itself must not have been clobbered by the earlier call.
      expect(result.current.content).toBe("");
    });

    it("is ignored while a conflict is open", async () => {
      const { result } = await mountLoaded("元の内容", 111);
      vi.mocked(saveNotes).mockRejectedValue(
        new SidecarConflictError("notes.md"),
      );
      vi.mocked(loadNotes).mockResolvedValue({
        content: "別の端末で書かれた内容",
        modifiedAtMs: 222,
      });
      act(() => result.current.setContent(""));
      await runDebouncedSave();
      expect(result.current.status).toBe("conflict");

      act(() => result.current.initializeContent("# 見出し\n"));

      expect(result.current.content).toBe("");
      expect(result.current.status).toBe("conflict");
    });

    it("lets a normal edit save afterwards", async () => {
      const { result } = await mountLoaded("", 111);

      act(() => result.current.initializeContent("# 見出し\n"));
      act(() => result.current.setContent("# 見出し\n本文"));
      await runDebouncedSave();

      expect(saveNotes).toHaveBeenCalledWith(PATH, "# 見出し\n本文", 111);
    });
  });

  it("reloads when the reader opens another document", async () => {
    vi.mocked(loadNotes).mockResolvedValue({
      content: "一冊目",
      modifiedAtMs: 111,
    });
    const { result, rerender } = renderHook(({ path }) => useNotes(path), {
      initialProps: { path: PATH },
    });
    await settle();
    expect(result.current.content).toBe("一冊目");

    vi.mocked(loadNotes).mockResolvedValue({
      content: "二冊目",
      modifiedAtMs: 999,
    });
    rerender({ path: "/papers/other.pdf" });
    await settle();

    expect(result.current.content).toBe("二冊目");
    expect(loadNotes).toHaveBeenLastCalledWith("/papers/other.pdf");
  });
});
