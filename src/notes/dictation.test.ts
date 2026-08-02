import { describe, expect, it } from "vitest";
import {
  detectDictationPlatform,
  dictationHint,
  type NavigatorLike,
} from "./dictation";

function navigatorLike(overrides: Partial<NavigatorLike> = {}): NavigatorLike {
  return {
    platform: "MacIntel",
    userAgent: "",
    maxTouchPoints: 0,
    ...overrides,
  };
}

describe("detectDictationPlatform", () => {
  it("detects a real Mac (mouse/trackpad, no touch)", () => {
    const nav = navigatorLike({
      platform: "MacIntel",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      maxTouchPoints: 0,
    });

    expect(detectDictationPlatform(nav)).toBe("macos");
  });

  it("detects an iPhone from the user agent", () => {
    const nav = navigatorLike({
      platform: "iPhone",
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      maxTouchPoints: 5,
    });

    expect(detectDictationPlatform(nav)).toBe("ios");
  });

  it("detects an iPad that reports MacIntel with multi-touch", () => {
    const nav = navigatorLike({
      platform: "MacIntel",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15",
      maxTouchPoints: 5,
    });

    expect(detectDictationPlatform(nav)).toBe("ios");
  });

  it("treats maxTouchPoints of exactly 0 on MacIntel as macOS", () => {
    const nav = navigatorLike({ platform: "MacIntel", maxTouchPoints: 0 });

    expect(detectDictationPlatform(nav)).toBe("macos");
  });

  it("treats maxTouchPoints of exactly 1 on MacIntel as macOS", () => {
    // A single touch point is consistent with a touch-enabled trackpad-less
    // input device, not an iPad; only >1 flips the verdict.
    const nav = navigatorLike({ platform: "MacIntel", maxTouchPoints: 1 });

    expect(detectDictationPlatform(nav)).toBe("macos");
  });

  it("treats maxTouchPoints of exactly 2 on MacIntel as iOS", () => {
    const nav = navigatorLike({ platform: "MacIntel", maxTouchPoints: 2 });

    expect(detectDictationPlatform(nav)).toBe("ios");
  });

  it("falls back to other for Windows", () => {
    const nav = navigatorLike({
      platform: "Win32",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      maxTouchPoints: 0,
    });

    expect(detectDictationPlatform(nav)).toBe("other");
  });

  it("falls back to other for an unrecognized platform", () => {
    const nav = navigatorLike({
      platform: "Linux x86_64",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
      maxTouchPoints: 0,
    });

    expect(detectDictationPlatform(nav)).toBe("other");
  });
});

describe("dictationHint", () => {
  it("tells macOS users about the fn-key shortcut and Edit menu", () => {
    const hint = dictationHint("macos");

    expect(hint).toContain("fn キーを2回押す");
    expect(hint).toContain("編集 > 音声入力を開始");
  });

  it("tells iOS users about the keyboard microphone button", () => {
    const hint = dictationHint("ios");

    expect(hint).toContain("キーボードのマイクボタン");
  });

  it("warns other platforms that standard dictation may be unavailable", () => {
    const hint = dictationHint("other");

    expect(hint).toContain("音声入力が使えない場合があります");
  });
});
