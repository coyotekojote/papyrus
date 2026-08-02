/**
 * Platform detection and guidance for OS dictation (issue #13).
 *
 * There is no web API to start OS dictation from JavaScript — Web Speech API
 * is not exposed inside a WKWebView, and macOS dictation only starts from a
 * user gesture the OS itself recognizes (the fn-key shortcut or the Edit
 * menu). So the app cannot trigger recognition; the best it can do is tell
 * the user how to start it themselves. This module only decides which
 * platform's instructions to show — it never touches the DOM or focuses
 * anything, so it can be tested without jsdom.
 */

export type DictationPlatform = "macos" | "ios" | "other";

/** The minimal `navigator` surface this module needs, so tests can fake it. */
export interface NavigatorLike {
  platform: string;
  userAgent: string;
  maxTouchPoints: number;
}

/**
 * iPadOS Safari (and WKWebView on iPad) reports `platform: "MacIntel"`, the
 * same as a real Mac — Apple never shipped a distinct iPad UA/platform after
 * "request desktop site" became the default. `maxTouchPoints > 1` is the
 * standard workaround: a Mac with a mouse/trackpad reports 0, an iPad
 * reports the number of simultaneous touches it supports (5+).
 */
export function detectDictationPlatform(
  navigatorLike: NavigatorLike,
): DictationPlatform {
  const ua = navigatorLike.userAgent;
  const platform = navigatorLike.platform;

  if (/iPhone|iPad|iPod/.test(ua) || /iPhone|iPad|iPod/.test(platform)) {
    return "ios";
  }

  if (platform === "MacIntel" && navigatorLike.maxTouchPoints > 1) {
    return "ios";
  }

  if (/Mac/.test(platform)) {
    return "macos";
  }

  return "other";
}

const HINT: Record<DictationPlatform, string> = {
  macos:
    "fn キーを2回押すと音声入力が始まります（システム設定 > キーボード で音声入力をオンにしておく必要があります）。メニューの「編集 > 音声入力を開始」からも起動できます。",
  ios: "キーボードのマイクボタンをタップすると音声入力できます。",
  other:
    "このOSでは標準の音声入力が使えない場合があります（Windowsは Win+H で音声入力を試せます）。",
};

/** The Japanese guidance text shown for a given platform. */
export function dictationHint(platform: DictationPlatform): string {
  return HINT[platform];
}
