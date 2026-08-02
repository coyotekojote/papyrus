import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { translate, type Translation } from "./translate";
import { useTranslation, type TranslationSource } from "./use-translation";

vi.mock("./translate", async (importActual) => {
  const actual = await importActual<typeof import("./translate")>();
  return { ...actual, translate: vi.fn() };
});

function source(text = "Attention is all you need."): TranslationSource {
  return {
    input: { text, contextBefore: "before ", contextAfter: " after" },
    page: 3,
  };
}

function answer(text: string): Translation {
  return {
    text,
    provider: "claude",
    model: "claude-opus-5",
    targetLanguage: "ja",
  };
}

/** Resolves the promise it hands out only when `release` is called. */
function deferred<T>() {
  let release: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release: (value: T) => release(value) };
}

beforeEach(() => {
  vi.mocked(translate).mockReset();
});

describe("useTranslation", () => {
  it("shows the request running, then what came back", async () => {
    vi.mocked(translate).mockResolvedValue(answer("必要なのは注意だけ。"));
    const { result } = renderHook(() => useTranslation());

    expect(result.current.state.status).toBe("idle");
    act(() => result.current.start(source()));

    expect(result.current.state).toEqual({
      status: "loading",
      source: source(),
    });
    await waitFor(() => expect(result.current.state.status).toBe("done"));
    expect(vi.mocked(translate).mock.calls[0][0]).toEqual(source().input);
    if (result.current.state.status !== "done") throw new Error("not done");
    expect(result.current.state.result.text).toBe("必要なのは注意だけ。");
    // The source is kept: the note quotes the original next to the translation.
    expect(result.current.state.source.page).toBe(3);
  });

  it("reports a failure in words the reader can act on", async () => {
    vi.mocked(translate).mockRejectedValue({ kind: "missingKey" });
    const { result } = renderHook(() => useTranslation());

    act(() => result.current.start(source()));

    await waitFor(() => expect(result.current.state.status).toBe("error"));
    if (result.current.state.status !== "error")
      throw new Error("not an error");
    expect(result.current.state.message).toBe(
      "APIキーが設定されていません。設定画面で登録してください",
    );
  });

  it("keeps the newest request when an earlier one finishes late", async () => {
    const first = deferred<Translation>();
    vi.mocked(translate)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(answer("二番目の訳"));
    const { result } = renderHook(() => useTranslation());

    act(() => result.current.start(source("first")));
    act(() => result.current.start(source("second")));
    await waitFor(() => expect(result.current.state.status).toBe("done"));

    await act(async () => {
      first.release(answer("一番目の訳"));
      await first.promise;
    });

    if (result.current.state.status !== "done") throw new Error("not done");
    expect(result.current.state.result.text).toBe("二番目の訳");
  });

  it("does not reopen the panel when a dismissed request answers", async () => {
    const pending = deferred<Translation>();
    vi.mocked(translate).mockReturnValue(pending.promise);
    const { result } = renderHook(() => useTranslation());

    act(() => result.current.start(source()));
    act(() => result.current.dismiss());
    expect(result.current.state.status).toBe("idle");

    await act(async () => {
      pending.release(answer("遅れて届いた訳"));
      await pending.promise;
    });

    expect(result.current.state.status).toBe("idle");
  });

  it("retries the failed request unchanged", async () => {
    vi.mocked(translate)
      .mockRejectedValueOnce({ kind: "rateLimited" })
      .mockResolvedValueOnce(answer("再試行の訳"));
    const { result } = renderHook(() => useTranslation());

    act(() => result.current.start(source()));
    await waitFor(() => expect(result.current.state.status).toBe("error"));

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.state.status).toBe("done"));

    expect(vi.mocked(translate).mock.calls[1][0]).toEqual(source().input);
  });

  it("ignores a retry when nothing has failed", () => {
    const { result } = renderHook(() => useTranslation());

    act(() => result.current.retry());

    expect(translate).not.toHaveBeenCalled();
    expect(result.current.state.status).toBe("idle");
  });
});
