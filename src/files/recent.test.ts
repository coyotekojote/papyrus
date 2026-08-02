import { describe, expect, it, vi } from "vitest";
import {
  addRecentFile,
  fileNameFromPath,
  loadRecentFiles,
  MAX_RECENT_FILES,
  parseRecentFiles,
  RECENT_FILES_STORAGE_KEY,
  removeRecentFile,
  saveRecentFiles,
  type RecentFile,
  type RecentFilesStorage,
} from "./recent";

function entry(path: string, openedAt = 1): RecentFile {
  return { path, name: fileNameFromPath(path), openedAt };
}

function memoryStorage(
  initial?: string,
): RecentFilesStorage & { value: string | null } {
  return {
    value: initial ?? null,
    getItem(key) {
      return key === RECENT_FILES_STORAGE_KEY ? this.value : null;
    },
    setItem(key, value) {
      if (key === RECENT_FILES_STORAGE_KEY) this.value = value;
    },
  };
}

describe("fileNameFromPath", () => {
  it("takes the last POSIX segment", () => {
    expect(fileNameFromPath("/Users/me/Papers/attention.pdf")).toBe(
      "attention.pdf",
    );
  });

  it("takes the last Windows segment", () => {
    expect(fileNameFromPath("C:\\Users\\me\\attention.pdf")).toBe(
      "attention.pdf",
    );
  });

  it("ignores a trailing separator", () => {
    expect(fileNameFromPath("/Users/me/Papers/")).toBe("Papers");
  });

  it("returns the input when there is no separator", () => {
    expect(fileNameFromPath("attention.pdf")).toBe("attention.pdf");
  });

  it("returns the input for an empty path", () => {
    expect(fileNameFromPath("")).toBe("");
  });
});

describe("addRecentFile", () => {
  it("puts a new file at the head", () => {
    const list = [entry("/a.pdf")];
    expect(addRecentFile(list, entry("/b.pdf")).map((f) => f.path)).toEqual([
      "/b.pdf",
      "/a.pdf",
    ]);
  });

  it("de-duplicates by path and keeps the newest timestamp", () => {
    const list = [entry("/a.pdf", 1), entry("/b.pdf", 2)];
    const result = addRecentFile(list, entry("/a.pdf", 99));

    expect(result.map((f) => f.path)).toEqual(["/a.pdf", "/b.pdf"]);
    expect(result[0].openedAt).toBe(99);
    expect(result).toHaveLength(2);
  });

  it("caps the list at the limit, dropping the oldest", () => {
    let list: RecentFile[] = [];
    for (let i = 1; i <= MAX_RECENT_FILES + 3; i++) {
      list = addRecentFile(list, entry(`/file-${i}.pdf`, i));
    }

    expect(list).toHaveLength(MAX_RECENT_FILES);
    expect(list[0].path).toBe(`/file-${MAX_RECENT_FILES + 3}.pdf`);
    expect(list.at(-1)?.path).toBe("/file-4.pdf");
  });

  it("honours a custom limit", () => {
    const list = addRecentFile(
      [entry("/a.pdf"), entry("/b.pdf")],
      entry("/c.pdf"),
      2,
    );
    expect(list.map((f) => f.path)).toEqual(["/c.pdf", "/a.pdf"]);
  });

  it("returns an empty list for a limit of 0", () => {
    expect(addRecentFile([entry("/a.pdf")], entry("/b.pdf"), 0)).toEqual([]);
  });

  it("does not mutate the input list", () => {
    const list = [entry("/a.pdf")];
    addRecentFile(list, entry("/b.pdf"));
    expect(list).toHaveLength(1);
  });
});

describe("removeRecentFile", () => {
  it("removes the matching path", () => {
    const list = [entry("/a.pdf"), entry("/b.pdf")];
    expect(removeRecentFile(list, "/a.pdf").map((f) => f.path)).toEqual([
      "/b.pdf",
    ]);
  });

  it("leaves the list unchanged for an unknown path", () => {
    const list = [entry("/a.pdf")];
    expect(removeRecentFile(list, "/missing.pdf")).toEqual(list);
  });
});

describe("parseRecentFiles", () => {
  it("returns an empty list for null or empty input", () => {
    expect(parseRecentFiles(null)).toEqual([]);
    expect(parseRecentFiles("")).toEqual([]);
  });

  it("returns an empty list for malformed JSON", () => {
    expect(parseRecentFiles("{not json")).toEqual([]);
  });

  it("returns an empty list when the payload is not an array", () => {
    expect(parseRecentFiles('{"path":"/a.pdf"}')).toEqual([]);
  });

  it("keeps well-formed entries", () => {
    const raw = JSON.stringify([
      { path: "/a.pdf", name: "a.pdf", openedAt: 5 },
    ]);
    expect(parseRecentFiles(raw)).toEqual([
      { path: "/a.pdf", name: "a.pdf", openedAt: 5 },
    ]);
  });

  it("drops entries with missing or wrong-typed fields", () => {
    const raw = JSON.stringify([
      { path: "/good.pdf", name: "good.pdf", openedAt: 1 },
      { path: "", name: "empty", openedAt: 1 },
      { path: "/no-name.pdf", openedAt: 1 },
      { path: "/bad-time.pdf", name: "x", openedAt: "yesterday" },
      null,
      "just a string",
    ]);

    expect(parseRecentFiles(raw).map((f) => f.path)).toEqual(["/good.pdf"]);
  });

  it("drops duplicate paths, keeping the first occurrence", () => {
    const raw = JSON.stringify([
      { path: "/a.pdf", name: "a.pdf", openedAt: 2 },
      { path: "/a.pdf", name: "a.pdf", openedAt: 1 },
    ]);

    const parsed = parseRecentFiles(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].openedAt).toBe(2);
  });

  it("truncates an over-long stored list", () => {
    const raw = JSON.stringify(
      Array.from({ length: MAX_RECENT_FILES + 5 }, (_, i) => ({
        path: `/f-${i}.pdf`,
        name: `f-${i}.pdf`,
        openedAt: i,
      })),
    );

    expect(parseRecentFiles(raw)).toHaveLength(MAX_RECENT_FILES);
  });

  it("keeps a string bookmark alongside an entry", () => {
    const raw = JSON.stringify([
      { path: "/a.pdf", name: "a.pdf", openedAt: 5, bookmark: "Ym9va21hcms=" },
    ]);

    expect(parseRecentFiles(raw)).toEqual([
      { path: "/a.pdf", name: "a.pdf", openedAt: 5, bookmark: "Ym9va21hcms=" },
    ]);
  });

  it("keeps an entry with no bookmark field, for pre-#11 storage", () => {
    const raw = JSON.stringify([
      { path: "/a.pdf", name: "a.pdf", openedAt: 5 },
    ]);

    const parsed = parseRecentFiles(raw);
    expect(parsed).toEqual([{ path: "/a.pdf", name: "a.pdf", openedAt: 5 }]);
    expect(parsed[0].bookmark).toBeUndefined();
  });

  it("drops a non-string bookmark but keeps the rest of the entry", () => {
    const raw = JSON.stringify([
      { path: "/a.pdf", name: "a.pdf", openedAt: 5, bookmark: 12345 },
      { path: "/b.pdf", name: "b.pdf", openedAt: 4, bookmark: null },
    ]);

    const parsed = parseRecentFiles(raw);
    expect(parsed.map((f) => f.path)).toEqual(["/a.pdf", "/b.pdf"]);
    expect(parsed.every((f) => f.bookmark === undefined)).toBe(true);
  });
});

describe("loadRecentFiles / saveRecentFiles", () => {
  it("round-trips a list through storage", () => {
    const storage = memoryStorage();
    const list = [entry("/a.pdf", 3), entry("/b.pdf", 2)];

    saveRecentFiles(storage, list);

    expect(loadRecentFiles(storage)).toEqual(list);
  });

  it("returns an empty list when storage throws", () => {
    const storage: RecentFilesStorage = {
      getItem: vi.fn(() => {
        throw new Error("storage disabled");
      }),
      setItem: vi.fn(),
    };

    expect(loadRecentFiles(storage)).toEqual([]);
  });

  it("swallows write failures so opening a file still succeeds", () => {
    const storage: RecentFilesStorage = {
      getItem: () => null,
      setItem: vi.fn(() => {
        throw new Error("quota exceeded");
      }),
    };

    expect(() => saveRecentFiles(storage, [entry("/a.pdf")])).not.toThrow();
  });
});
