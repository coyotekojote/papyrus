import { describe, expect, it } from "vitest";
import { describeError, toError } from "./backend-error";

describe("backend errors", () => {
  it("names the setting that could not be written", () => {
    expect(describeError({ kind: "io", message: "permission denied" })).toBe(
      "設定を保存できませんでした: permission denied",
    );
  });

  it("explains a refused API key without echoing it", () => {
    expect(describeError({ kind: "emptyKey" })).toBe(
      "APIキーが入力されていません",
    );
  });

  it("says which provider was not recognized", () => {
    expect(describeError({ kind: "unknownProvider", provider: "gemini" })).toBe(
      "対応していない翻訳プロバイダです: gemini",
    );
  });

  it("reports a keychain failure with the reason the OS gave", () => {
    expect(describeError({ kind: "keychain", message: "locked" })).toBe(
      "キーチェーンを操作できませんでした: locked",
    );
  });

  it("still says something useful for a kind it has no wording for", () => {
    expect(describeError({ kind: "somethingNew", message: "details" })).toBe(
      "somethingNew: details",
    );
  });

  it("passes an Error through unchanged", () => {
    const cause = new Error("already an error");
    expect(toError(cause)).toBe(cause);
  });

  it("falls back to the string form of anything else", () => {
    expect(describeError("plain failure")).toBe("plain failure");
  });
});
