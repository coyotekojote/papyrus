import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultViewModeForScreen, useIsCompactScreen } from "./responsive";

describe("defaultViewModeForScreen", () => {
  it("forces single-page on a compact screen regardless of the setting", () => {
    expect(defaultViewModeForScreen("spread", true)).toBe("single");
    expect(defaultViewModeForScreen("single", true)).toBe("single");
  });

  it("uses the setting as-is once the screen is not compact", () => {
    expect(defaultViewModeForScreen("spread", false)).toBe("spread");
    expect(defaultViewModeForScreen("single", false)).toBe("single");
  });
});

describe("useIsCompactScreen", () => {
  /** A fake `matchMedia` whose `matches` can be flipped from the test. */
  function fakeMatchMedia(initialMatches: boolean) {
    let matches = initialMatches;
    let onChange: (() => void) | null = null;
    const query = {
      get matches() {
        return matches;
      },
      addEventListener: (_type: string, listener: () => void) => {
        onChange = listener;
      },
      removeEventListener: () => {
        onChange = null;
      },
    };
    return {
      matchMedia: vi.fn().mockReturnValue(query),
      setMatches(next: boolean) {
        matches = next;
        onChange?.();
      },
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the initial value from matchMedia", () => {
    const { matchMedia } = fakeMatchMedia(true);
    vi.stubGlobal("matchMedia", matchMedia);

    const { result } = renderHook(() => useIsCompactScreen());

    expect(result.current).toBe(true);
  });

  it("updates when the media query's match state changes", () => {
    const { matchMedia, setMatches } = fakeMatchMedia(false);
    vi.stubGlobal("matchMedia", matchMedia);

    const { result } = renderHook(() => useIsCompactScreen());
    expect(result.current).toBe(false);

    act(() => setMatches(true));
    expect(result.current).toBe(true);

    act(() => setMatches(false));
    expect(result.current).toBe(false);
  });

  it("defaults to false when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);

    const { result } = renderHook(() => useIsCompactScreen());

    expect(result.current).toBe(false);
  });
});
