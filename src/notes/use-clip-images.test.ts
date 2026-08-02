import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadClip } from "../files/sidecar";
import { useClipImages } from "./use-clip-images";

vi.mock("../files/sidecar", () => ({ loadClip: vi.fn() }));

const loadClipMock = vi.mocked(loadClip);

/** Blob URLs jsdom does not implement; each call hands back a unique one. */
const created: Blob[] = [];
const revoked: string[] = [];

beforeEach(() => {
  created.length = 0;
  revoked.length = 0;
  loadClipMock.mockReset();
  loadClipMock.mockImplementation((_path, file) =>
    Promise.resolve(new TextEncoder().encode(file).buffer as ArrayBuffer),
  );
  URL.createObjectURL = vi.fn((blob: Blob) => {
    created.push(blob);
    return `blob:clip-${created.length}`;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useClipImages", () => {
  it("resolves each clip to a blob URL", async () => {
    const files = ["clips/clip-0001.png", "clips/clip-0002.png"];
    const { result } = renderHook(() =>
      useClipImages("/Papers/paper.pdf", files, true),
    );

    await waitFor(() => expect(result.current.size).toBe(2));
    expect(result.current.get("clips/clip-0001.png")).toBe("blob:clip-1");
    expect(result.current.get("clips/clip-0002.png")).toBe("blob:clip-2");
    expect(loadClipMock).toHaveBeenCalledWith(
      "/Papers/paper.pdf",
      "clips/clip-0001.png",
    );
  });

  it("reads nothing until the preview asks for it", async () => {
    const files = ["clips/clip-0001.png"];
    const { rerender, result } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useClipImages("/Papers/paper.pdf", files, enabled),
      { initialProps: { enabled: false } },
    );

    expect(loadClipMock).not.toHaveBeenCalled();
    expect(result.current.size).toBe(0);

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.size).toBe(1));
  });

  it("reads a clip once, however often the panel re-renders", async () => {
    const files = ["clips/clip-0001.png"];
    const { rerender, result } = renderHook(() =>
      useClipImages("/Papers/paper.pdf", files, true),
    );

    await waitFor(() => expect(result.current.size).toBe(1));
    rerender();
    rerender();

    expect(loadClipMock).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
  });

  it("leaves out a clip that cannot be read, so its alt text stands in", async () => {
    loadClipMock.mockImplementation((_path, file) =>
      file.endsWith("0002.png")
        ? Promise.reject(new Error("Sidecar io: missing"))
        : Promise.resolve(new ArrayBuffer(4)),
    );
    const files = ["clips/clip-0001.png", "clips/clip-0002.png"];
    const { result } = renderHook(() =>
      useClipImages("/Papers/paper.pdf", files, true),
    );

    await waitFor(() => expect(result.current.size).toBe(1));
    expect(result.current.has("clips/clip-0001.png")).toBe(true);
    expect(result.current.has("clips/clip-0002.png")).toBe(false);
  });

  it("frees a clip that is no longer in the document", async () => {
    const both = ["clips/clip-0001.png", "clips/clip-0002.png"];
    const { rerender, result } = renderHook(
      ({ files }: { files: string[] }) =>
        useClipImages("/Papers/paper.pdf", files, true),
      { initialProps: { files: both } },
    );

    await waitFor(() => expect(result.current.size).toBe(2));
    rerender({ files: ["clips/clip-0001.png"] });

    expect(revoked).toEqual(["blob:clip-2"]);
    expect(result.current.has("clips/clip-0002.png")).toBe(false);
    // The one still referenced keeps the URL it already had.
    expect(result.current.get("clips/clip-0001.png")).toBe("blob:clip-1");
  });

  it("frees the URLs when the document changes", async () => {
    const files = ["clips/clip-0001.png"];
    const { rerender, result } = renderHook(
      ({ path }: { path: string }) => useClipImages(path, files, true),
      { initialProps: { path: "/Papers/first.pdf" } },
    );

    await waitFor(() => expect(result.current.size).toBe(1));
    rerender({ path: "/Papers/second.pdf" });

    expect(revoked).toEqual(["blob:clip-1"]);
    await waitFor(() => expect(result.current.size).toBe(1));
    expect(result.current.get("clips/clip-0001.png")).toBe("blob:clip-2");
  });

  it("frees the URLs when the panel closes", async () => {
    const files = ["clips/clip-0001.png"];
    const { result, unmount } = renderHook(() =>
      useClipImages("/Papers/paper.pdf", files, true),
    );

    await waitFor(() => expect(result.current.size).toBe(1));
    unmount();

    expect(revoked).toEqual(["blob:clip-1"]);
  });
});
