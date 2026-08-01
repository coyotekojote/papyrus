import { afterEach, describe, expect, it, vi } from "vitest";
import { blobToBase64 } from "./base64";

afterEach(() => {
  vi.restoreAllMocks();
});

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
    // readAsDataURL still yields "data:image/png;base64," here, so the empty
    // payload is a genuine result rather than the failure below.
    expect(await blobToBase64(new Blob([], { type: "image/png" }))).toBe("");
  });

  it("fails rather than hand back an empty payload it cannot vouch for", async () => {
    const reader = {
      error: null,
      result: "not-a-data-url",
      onload: null as (() => void) | null,
      onerror: null as (() => void) | null,
      readAsDataURL() {
        this.onload?.();
      },
    };
    vi.spyOn(globalThis, "FileReader").mockImplementation(
      () => reader as unknown as FileReader,
    );

    await expect(
      blobToBase64(new Blob([new Uint8Array([1])], { type: "image/png" })),
    ).rejects.toThrow("Failed to encode the image");
  });
});
