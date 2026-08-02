import { describe, expect, it } from "vitest";
import type { RecentFile } from "../files/recent";
import {
  DEFAULT_LIBRARY_VIEW_MODE,
  filterLibraryFiles,
  loadLibraryViewMode,
  saveLibraryViewMode,
  type LibraryViewModeStorage,
} from "./library";

const FILES: RecentFile[] = [
  { path: "/a/Report.pdf", name: "Report.pdf", openedAt: 1 },
  { path: "/a/契約書.pdf", name: "契約書.pdf", openedAt: 2 },
  { path: "/a/ＦＵＬＬwidth.pdf", name: "ＦＵＬＬwidth.pdf", openedAt: 3 },
];

describe("filterLibraryFiles", () => {
  it("returns every file for an empty query", () => {
    expect(filterLibraryFiles(FILES, "")).toEqual(FILES);
  });

  it("returns every file for a whitespace-only query", () => {
    expect(filterLibraryFiles(FILES, "   ")).toEqual(FILES);
  });

  it("matches case-insensitively", () => {
    expect(filterLibraryFiles(FILES, "report")).toEqual([FILES[0]]);
  });

  it("matches Japanese file names", () => {
    expect(filterLibraryFiles(FILES, "契約")).toEqual([FILES[1]]);
  });

  it("matches full-width input against a half-width name and vice versa", () => {
    expect(filterLibraryFiles(FILES, "full")).toEqual([FILES[2]]);
  });

  it("returns no files when nothing matches", () => {
    expect(filterLibraryFiles(FILES, "does-not-exist")).toEqual([]);
  });
});

class FakeStorage implements LibraryViewModeStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

describe("loadLibraryViewMode / saveLibraryViewMode", () => {
  it("defaults to grid when nothing is stored", () => {
    expect(loadLibraryViewMode(new FakeStorage())).toBe(
      DEFAULT_LIBRARY_VIEW_MODE,
    );
  });

  it("round-trips a saved mode", () => {
    const storage = new FakeStorage();
    saveLibraryViewMode(storage, "list");
    expect(loadLibraryViewMode(storage)).toBe("list");
  });

  it("falls back to the default for a malformed stored value", () => {
    const storage = new FakeStorage();
    storage.setItem("papyrus.libraryViewMode.v1", "not-a-mode");
    expect(loadLibraryViewMode(storage)).toBe(DEFAULT_LIBRARY_VIEW_MODE);
  });

  it("does not throw when the store rejects access", () => {
    const throwing: LibraryViewModeStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadLibraryViewMode(throwing)).toBe(DEFAULT_LIBRARY_VIEW_MODE);
    expect(() => saveLibraryViewMode(throwing, "grid")).not.toThrow();
  });
});
