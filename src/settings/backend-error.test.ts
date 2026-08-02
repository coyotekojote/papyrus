import { describe, expect, it } from "vitest";
import { describeError, toError } from "./backend-error";

describe("backend errors", () => {
  it("says which half of the file access failed", () => {
    const failure = { kind: "io", message: "permission denied" };

    expect(toError(failure, "load").message).toBe(
      "設定を読み込めませんでした: permission denied",
    );
    expect(toError(failure, "save").message).toBe(
      "設定を保存できませんでした: permission denied",
    );
    // Without an operation the message commits to neither.
    expect(describeError(failure)).toBe(
      "設定を読み書きできませんでした: permission denied",
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

  it("treats an inherited property name as an unknown kind", () => {
    // The kind comes off the wire. Looked up on a plain object, these would
    // answer with something inherited — a crash, or a nonsense message.
    for (const kind of ["__proto__", "toString", "constructor"]) {
      expect(describeError({ kind, message: "details" })).toBe(
        `${kind}: details`,
      );
    }
  });

  it("passes an Error through unchanged", () => {
    const cause = new Error("already an error");
    expect(toError(cause)).toBe(cause);
  });

  it("falls back to the string form of anything else", () => {
    expect(describeError("plain failure")).toBe("plain failure");
  });
});
