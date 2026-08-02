/**
 * Turns the tagged errors the backend commands reject with — settings,
 * keychain (issue #9) and translation (issue #10) — into something a reader
 * can act on. Tauri hands them over as plain objects, so without this every
 * failure would surface as "[object Object]".
 */

interface BackendError {
  kind: string;
  message?: string;
  provider?: string;
  status?: number;
  limit?: number;
}

/**
 * Which side of the settings file failed, for the errors that can happen on
 * either. Telling a reader their settings could not be *saved* when the read
 * is what failed sends them looking for the wrong problem.
 */
export type SettingsOperation = "load" | "save";

const IO_MESSAGE: Record<SettingsOperation | "unknown", string> = {
  load: "設定を読み込めませんでした",
  save: "設定を保存できませんでした",
  unknown: "設定を読み書きできませんでした",
};

type Describe = (
  error: BackendError,
  operation: SettingsOperation | "unknown",
) => string;

/**
 * A Map rather than an object: the `kind` comes off the wire, and a plain
 * object would answer `__proto__` or `toString` with something inherited —
 * turning the fallback for an unknown kind into a crash or a nonsense message.
 */
const MESSAGES = new Map<string, Describe>([
  ["configDirUnavailable", () => "設定の保存先フォルダが見つかりません"],
  ["serialize", () => "設定を書き出せませんでした"],
  [
    "io",
    (error, operation) =>
      `${IO_MESSAGE[operation]}: ${error.message ?? ""}`.trim(),
  ],
  [
    "unknownProvider",
    (error) =>
      `対応していない翻訳プロバイダです: ${error.provider ?? ""}`.trim(),
  ],
  ["emptyKey", () => "APIキーが入力されていません"],
  [
    "keychain",
    (error) =>
      `キーチェーンを操作できませんでした: ${error.message ?? ""}`.trim(),
  ],
  // Translation (issue #10). The provider is whichever one the settings name,
  // so the wording points at the setting to change rather than naming it.
  ["emptySelection", () => "翻訳するテキストが選択されていません"],
  [
    "textTooLong",
    (error) =>
      `選択が長すぎます（上限 ${error.limit ?? 0} 文字）。範囲を狭めてください`,
  ],
  [
    "missingKey",
    () => "APIキーが設定されていません。設定画面で登録してください",
  ],
  [
    "modelRequired",
    () => "翻訳に使うモデルが未設定です。設定画面で指定してください",
  ],
  [
    "unauthorized",
    () => "APIキーが拒否されました。キーと利用枠を確認してください",
  ],
  [
    "rateLimited",
    () => "リクエストが多すぎます。しばらく待ってから再試行してください",
  ],
  [
    "unavailable",
    (error) =>
      `翻訳サービスが応答しませんでした（HTTP ${error.status ?? 0}）。時間をおいて再試行してください`,
  ],
  [
    "badRequest",
    (error) => `翻訳を実行できませんでした: ${error.message ?? ""}`.trim(),
  ],
  ["refused", () => "このテキストの翻訳は拒否されました"],
  [
    "network",
    (error) =>
      `翻訳サービスに接続できませんでした: ${error.message ?? ""}`.trim(),
  ],
  [
    "malformedResponse",
    (error) => `翻訳結果を読み取れませんでした: ${error.message ?? ""}`.trim(),
  ],
  [
    "settings",
    (error) => `設定を読み込めませんでした: ${error.message ?? ""}`.trim(),
  ],
  [
    "internal",
    (error) => `翻訳を実行できませんでした: ${error.message ?? ""}`.trim(),
  ],
]);

function isBackendError(error: unknown): error is BackendError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as BackendError).kind === "string"
  );
}

export function toError(error: unknown, operation?: SettingsOperation): Error {
  if (error instanceof Error) return error;
  if (isBackendError(error)) {
    const describe = MESSAGES.get(error.kind);
    // An unrecognized kind still says which one it was: a build that adds an
    // error this one has no wording for should not go out as a blank message.
    return new Error(
      describe
        ? describe(error, operation ?? "unknown")
        : `${error.kind}: ${error.message ?? ""}`.trim(),
    );
  }
  return new Error(String(error));
}

/** The message to show for a rejection, already localized. */
export function describeError(error: unknown): string {
  return toError(error).message;
}
