/**
 * Turns the tagged errors the settings and keychain commands reject with into
 * something a reader can act on. Tauri hands them over as plain objects, so
 * without this every failure would surface as "[object Object]".
 */

interface BackendError {
  kind: string;
  message?: string;
  provider?: string;
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

const MESSAGES: Record<string, Describe> = {
  configDirUnavailable: () => "設定の保存先フォルダが見つかりません",
  serialize: () => "設定を書き出せませんでした",
  io: (error, operation) =>
    `${IO_MESSAGE[operation]}: ${error.message ?? ""}`.trim(),
  unknownProvider: (error) =>
    `対応していない翻訳プロバイダです: ${error.provider ?? ""}`.trim(),
  emptyKey: () => "APIキーが入力されていません",
  keychain: (error) =>
    `キーチェーンを操作できませんでした: ${error.message ?? ""}`.trim(),
};

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
    const describe = MESSAGES[error.kind];
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
