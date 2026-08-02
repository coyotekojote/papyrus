import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecentFile } from "./files/recent";
import { StartScreen, type StartScreenProps } from "./StartScreen";

const readPdfFile = vi.hoisted(() => vi.fn());
const loadDefaultRenderer = vi.hoisted(() => vi.fn());

vi.mock("./files/open", () => ({ readPdfFile }));
vi.mock("./pdf", () => ({ loadDefaultRenderer }));

const FILES: RecentFile[] = [
  { path: "/a/Report.pdf", name: "Report.pdf", openedAt: 1000 },
  { path: "/a/契約書.pdf", name: "契約書.pdf", openedAt: 2000 },
];

function renderStartScreen(overrides: Partial<StartScreenProps> = {}) {
  const props: StartScreenProps = {
    recentFiles: FILES,
    busy: false,
    error: null,
    onOpen: vi.fn(),
    onOpenRecent: vi.fn(),
    onRemoveRecent: vi.fn(),
    onOpenSettings: vi.fn(),
    ...overrides,
  };
  render(<StartScreen {...props} />);
  return props;
}

beforeEach(() => {
  window.localStorage.clear();
  readPdfFile.mockReset().mockRejectedValue(new Error("not read in this test"));
  loadDefaultRenderer.mockReset();
});

describe("StartScreen", () => {
  it("shows covers for every recent file by default", async () => {
    renderStartScreen();
    expect(screen.getByRole("button", { name: "表紙" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(document.querySelectorAll(".library__tile")).toHaveLength(2);
    // The covers fail to load (readPdfFile is stubbed to reject) and settle
    // to a placeholder; wait for that so the state update lands inside this
    // test rather than bleeding into the next one.
    await waitFor(() => {
      expect(document.querySelectorAll(".cover__placeholder")).toHaveLength(2);
    });
  });

  it("switches to the file-name list view", async () => {
    const user = userEvent.setup();
    renderStartScreen();

    await user.click(screen.getByRole("button", { name: "ファイル名" }));

    expect(screen.getByRole("button", { name: "ファイル名" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("Report.pdf")).toBeInTheDocument();
    expect(screen.getByText("契約書.pdf")).toBeInTheDocument();
    expect(document.querySelectorAll(".recent__item")).toHaveLength(2);
  });

  it("filters files by name as the search box is typed into", async () => {
    const user = userEvent.setup();
    renderStartScreen();

    await user.type(
      screen.getByRole("searchbox", { name: "ライブラリを検索" }),
      "契約",
    );

    await waitFor(() => {
      expect(document.querySelectorAll(".library__tile")).toHaveLength(1);
    });
    expect(
      screen.getByRole("button", { name: "契約書.pdf を開く" }),
    ).toBeInTheDocument();
  });

  it("shows a no-match message when the search query matches nothing", async () => {
    const user = userEvent.setup();
    renderStartScreen();

    await user.type(
      screen.getByRole("searchbox", { name: "ライブラリを検索" }),
      "does-not-exist",
    );

    await waitFor(() => {
      expect(
        screen.getByText("一致するファイルがありません。"),
      ).toBeInTheDocument();
    });
  });

  it("hides search and view controls when there are no recent files", () => {
    renderStartScreen({ recentFiles: [] });
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.getByText("まだありません。")).toBeInTheDocument();
  });

  it("opens a file when its tile is clicked", async () => {
    const user = userEvent.setup();
    const onOpenRecent = vi.fn();
    renderStartScreen({ onOpenRecent });

    await user.click(screen.getByRole("button", { name: "Report.pdf を開く" }));

    expect(onOpenRecent).toHaveBeenCalledWith("/a/Report.pdf");
  });
});
