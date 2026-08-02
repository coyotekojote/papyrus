import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PdfFileMissingError,
  createBookmarkFor,
  readPdfFile,
  readPdfFileWithBookmark,
  resolveBookmark,
} from "./open";

const exists = vi.hoisted(() => vi.fn());
const readFile = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists, readFile }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createBookmarkFor", () => {
  it("passes the path through to the create_bookmark command", async () => {
    invoke.mockResolvedValue("Ym9va21hcms=");

    const bookmark = await createBookmarkFor("/Papers/attention.pdf");

    expect(invoke).toHaveBeenCalledWith("create_bookmark", {
      path: "/Papers/attention.pdf",
    });
    expect(bookmark).toBe("Ym9va21hcms=");
  });

  it("returns null off iOS, where the backend answers with null", async () => {
    invoke.mockResolvedValue(null);

    expect(await createBookmarkFor("/Papers/attention.pdf")).toBeNull();
  });
});

describe("resolveBookmark", () => {
  it("returns the resolved file:// URL", async () => {
    invoke.mockResolvedValue("file:///private/var/mobile/attention.pdf");

    const resolved = await resolveBookmark("Ym9va21hcms=");

    expect(invoke).toHaveBeenCalledWith("resolve_bookmark", {
      bookmark: "Ym9va21hcms=",
    });
    expect(resolved).toBe("file:///private/var/mobile/attention.pdf");
  });

  it("returns null when the backend answers with null", async () => {
    invoke.mockResolvedValue(null);

    expect(await resolveBookmark("Ym9va21hcms=")).toBeNull();
  });

  it("returns null rather than throwing when the command rejects", async () => {
    invoke.mockRejectedValue(new Error("bookmark is stale"));

    expect(await resolveBookmark("Ym9va21hcms=")).toBeNull();
  });
});

describe("readPdfFileWithBookmark", () => {
  it("reads the saved path directly when there is no bookmark", async () => {
    exists.mockResolvedValue(true);
    readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));

    const bytes = await readPdfFileWithBookmark("/Papers/attention.pdf");

    expect(invoke).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledWith("/Papers/attention.pdf");
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("reads from the resolved bookmark location when resolution succeeds", async () => {
    invoke.mockResolvedValue("file:///private/var/mobile/attention.pdf");
    exists.mockResolvedValue(true);
    readFile.mockResolvedValue(new Uint8Array([9]));

    const bytes = await readPdfFileWithBookmark(
      "/Papers/attention.pdf",
      "Ym9va21hcms=",
    );

    expect(readFile).toHaveBeenCalledWith(
      "file:///private/var/mobile/attention.pdf",
    );
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(bytes).toEqual(new Uint8Array([9]));
  });

  it("falls back to the saved path when resolution returns null", async () => {
    invoke.mockResolvedValue(null);
    exists.mockResolvedValue(true);
    readFile.mockResolvedValue(new Uint8Array([4]));

    const bytes = await readPdfFileWithBookmark(
      "/Papers/attention.pdf",
      "Ym9va21hcms=",
    );

    expect(readFile).toHaveBeenCalledWith("/Papers/attention.pdf");
    expect(bytes).toEqual(new Uint8Array([4]));
  });

  it("falls back to the saved path when the resolved location is missing", async () => {
    invoke.mockResolvedValue("file:///private/var/mobile/moved.pdf");
    exists.mockImplementation((path: string) =>
      Promise.resolve(path === "/Papers/attention.pdf"),
    );
    readFile.mockResolvedValue(new Uint8Array([7]));

    const bytes = await readPdfFileWithBookmark(
      "/Papers/attention.pdf",
      "Ym9va21hcms=",
    );

    expect(readFile).toHaveBeenCalledWith("/Papers/attention.pdf");
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(bytes).toEqual(new Uint8Array([7]));
  });

  it("still fails with PdfFileMissingError when neither location has the file", async () => {
    invoke.mockResolvedValue("file:///private/var/mobile/moved.pdf");
    exists.mockResolvedValue(false);

    await expect(
      readPdfFileWithBookmark("/Papers/attention.pdf", "Ym9va21hcms="),
    ).rejects.toBeInstanceOf(PdfFileMissingError);
  });
});

describe("readPdfFile", () => {
  it("throws PdfFileMissingError instead of reading a file that is gone", async () => {
    exists.mockResolvedValue(false);

    await expect(readPdfFile("/Papers/gone.pdf")).rejects.toMatchObject({
      name: "PdfFileMissingError",
      path: "/Papers/gone.pdf",
    });
    expect(readFile).not.toHaveBeenCalled();
  });
});
