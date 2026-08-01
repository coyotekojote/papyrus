import { describe, expect, it } from "vitest";
import { blobToBase64 } from "./base64";

describe("blobToBase64", () => {
  it("encodes bytes without the data URL prefix", async () => {
    const blob = new Blob([new Uint8Array([104, 105])], { type: "image/png" });

    expect(await blobToBase64(blob)).toBe("aGk=");
  });

  it("encodes bytes that are not valid text", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]);
    const blob = new Blob([bytes], { type: "image/png" });

    expect(await blobToBase64(blob)).toBe("iVBORw0KGg==");
  });

  it("encodes an empty blob as an empty string", async () => {
    expect(await blobToBase64(new Blob([], { type: "image/png" }))).toBe("");
  });
});
