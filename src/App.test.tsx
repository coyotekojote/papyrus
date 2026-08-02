import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import {
  RECENT_FILES_STORAGE_KEY,
  parseRecentFiles,
  type RecentFile,
} from "./files/recent";
import { defaultSettings } from "./settings/settings";

const openDialog = vi.hoisted(() => vi.fn());
const exists = vi.hoisted(() => vi.fn());
const readFile = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog }));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists, readFile }));
// The settings (issue #9) are read at startup, over the same IPC as everything
// else the backend owns.
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function seedRecentFiles(files: RecentFile[]) {
  window.localStorage.setItem(RECENT_FILES_STORAGE_KEY, JSON.stringify(files));
}

/**
 * Renders the app and lets the settings read at startup settle, so no state
 * update lands after the test has finished.
 */
async function renderApp() {
  await act(async () => {
    render(<App />);
  });
}

function storedRecentFiles(): RecentFile[] {
  return parseRecentFiles(
    window.localStorage.getItem(RECENT_FILES_STORAGE_KEY),
  );
}

describe("App start screen", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    invoke.mockImplementation((command: string) =>
      command === "api_key_status"
        ? Promise.resolve([])
        : Promise.resolve(defaultSettings()),
    );
  });

  it("renders the Papyrus heading and tagline", async () => {
    await renderApp();

    expect(
      screen.getByRole("heading", { level: 1, name: "Papyrus" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("PDF viewer, built with Tauri + React."),
    ).toBeInTheDocument();
  });

  it("says the recent list is empty when nothing has been opened", async () => {
    await renderApp();

    expect(screen.getByText("まだありません。")).toBeInTheDocument();
  });

  it("lists the recent files stored from a previous session", async () => {
    seedRecentFiles([
      { path: "/Papers/attention.pdf", name: "attention.pdf", openedAt: 1 },
      { path: "/Papers/bert.pdf", name: "bert.pdf", openedAt: 2 },
    ]);

    await renderApp();

    expect(screen.getByText("attention.pdf")).toBeInTheDocument();
    expect(screen.getByText("bert.pdf")).toBeInTheDocument();
  });

  it("removes a recent file from the list and from storage", async () => {
    const user = userEvent.setup();
    seedRecentFiles([
      { path: "/Papers/attention.pdf", name: "attention.pdf", openedAt: 1 },
      { path: "/Papers/bert.pdf", name: "bert.pdf", openedAt: 2 },
    ]);

    await renderApp();
    await user.click(
      screen.getByRole("button", { name: "attention.pdf を一覧から削除" }),
    );

    expect(screen.queryByText("attention.pdf")).not.toBeInTheDocument();
    expect(storedRecentFiles().map((f) => f.path)).toEqual([
      "/Papers/bert.pdf",
    ]);
  });

  it("does nothing when the file picker is cancelled", async () => {
    const user = userEvent.setup();
    openDialog.mockResolvedValue(null);

    await renderApp();
    await user.click(screen.getByRole("button", { name: "PDFを開く" }));

    expect(readFile).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports a missing file and drops it from the recent list", async () => {
    const user = userEvent.setup();
    seedRecentFiles([
      { path: "/Papers/gone.pdf", name: "gone.pdf", openedAt: 1 },
    ]);
    exists.mockResolvedValue(false);

    await renderApp();
    await user.click(screen.getByRole("button", { name: "gone.pdf を開く" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "ファイルが見つかりません: /Papers/gone.pdf",
      );
    });
    expect(readFile).not.toHaveBeenCalled();
    expect(storedRecentFiles()).toEqual([]);
  });

  it("opens the settings from the start screen and closes them again", async () => {
    const user = userEvent.setup();

    await renderApp();
    await user.click(screen.getByRole("button", { name: "設定" }));

    const dialog = await screen.findByRole("dialog", { name: "設定" });
    expect(invoke).toHaveBeenCalledWith("load_settings", undefined);

    await user.click(screen.getByRole("button", { name: "設定を閉じる" }));
    expect(dialog).not.toBeInTheDocument();
  });
});
