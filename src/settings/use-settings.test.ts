import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultSettings,
  loadSettings,
  saveSettings,
  type Settings,
} from "./settings";
import { useSettings } from "./use-settings";

vi.mock("./settings", async (importActual) => {
  const actual = await importActual<typeof import("./settings")>();
  return { ...actual, loadSettings: vi.fn(), saveSettings: vi.fn() };
});

function withBinding(defaultBinding: Settings["defaultBinding"]): Settings {
  return { ...defaultSettings(), defaultBinding };
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
  vi.mocked(loadSettings).mockReset();
  vi.mocked(saveSettings).mockReset();
  vi.mocked(loadSettings).mockResolvedValue(defaultSettings());
  vi.mocked(saveSettings).mockImplementation((settings) =>
    Promise.resolve(settings),
  );
});

describe("useSettings", () => {
  it("shows the defaults until the stored settings arrive", async () => {
    vi.mocked(loadSettings).mockResolvedValue(withBinding("right"));

    const { result } = renderHook(() => useSettings());

    expect(result.current.settings).toEqual(defaultSettings());
    expect(result.current.loaded).toBe(false);

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.settings).toEqual(withBinding("right"));
  });

  it("writes a change and takes back what the backend stored", async () => {
    vi.mocked(saveSettings).mockImplementation((settings) =>
      Promise.resolve({
        ...settings,
        translation: { ...settings.translation, targetLanguage: "en" },
      }),
    );
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => {
      result.current.update((current) => ({
        ...current,
        translation: { ...current.translation, targetLanguage: "  en  " },
      }));
    });

    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(result.current.settings.translation.targetLanguage).toBe("en"),
    );
  });

  it("refuses to write before the settings have been read", async () => {
    const load = deferred<Settings>();
    vi.mocked(loadSettings).mockReturnValue(load.promise);
    const { result } = renderHook(() => useSettings());

    act(() => {
      result.current.update((current) => ({
        ...current,
        defaultBinding: "right",
      }));
    });

    // Writing here would put the defaults over a file that was never read.
    expect(saveSettings).not.toHaveBeenCalled();
    expect(result.current.settings.defaultBinding).toBe("left");

    await act(async () => {
      load.release(withBinding("right"));
      await load.promise;
    });
    expect(result.current.settings.defaultBinding).toBe("right");
  });

  it("reports a failed load and still refuses to write", async () => {
    vi.mocked(loadSettings).mockRejectedValue(new Error("読み込み失敗"));
    const { result } = renderHook(() => useSettings());

    await waitFor(() => expect(result.current.error).toBe("読み込み失敗"));

    act(() => {
      result.current.update((current) => ({
        ...current,
        defaultBinding: "right",
      }));
    });
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("puts the stored value back when a save fails", async () => {
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    vi.mocked(saveSettings).mockRejectedValue(new Error("書き込み失敗"));

    act(() => {
      result.current.update((current) => ({
        ...current,
        defaultBinding: "right",
      }));
    });
    // Shown right away: the screen follows the click, then corrects itself.
    expect(result.current.settings.defaultBinding).toBe("right");

    await waitFor(() => expect(result.current.error).toBe("書き込み失敗"));
    expect(result.current.settings.defaultBinding).toBe("left");
  });

  it("keeps the newer change when an earlier save finishes late", async () => {
    const slow = deferred<Settings>();
    vi.mocked(saveSettings)
      .mockReturnValueOnce(slow.promise)
      .mockImplementation((settings) => Promise.resolve(settings));
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => {
      result.current.update((current) => ({
        ...current,
        defaultBinding: "right",
      }));
    });
    act(() => {
      result.current.update((current) => ({
        ...current,
        defaultViewMode: "spread",
      }));
    });

    await act(async () => {
      slow.release(withBinding("right"));
      await slow.promise;
    });

    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(2));
    expect(result.current.settings).toEqual({
      ...defaultSettings(),
      defaultBinding: "right",
      defaultViewMode: "spread",
    });
  });
});
