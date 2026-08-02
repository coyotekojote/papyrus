import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotesPanel, type NotesPanelProps } from "./NotesPanel";

/**
 * jsdom's own `navigator.userAgent` matches none of `detectDictationPlatform`'s
 * patterns, so it would silently fall through to "other" — stub a real Mac
 * here to keep these tests about the button's behaviour, not the platform
 * detection already covered by dictation.test.ts.
 */
beforeEach(() => {
  vi.stubGlobal("navigator", {
    platform: "MacIntel",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    maxTouchPoints: 0,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function props(overrides: Partial<NotesPanelProps> = {}): NotesPanelProps {
  return {
    pdfPath: "/papers/paper.pdf",
    clips: [],
    content: "",
    loaded: true,
    status: "saved",
    error: null,
    conflict: null,
    onChange: vi.fn(),
    onKeepLocal: vi.fn(),
    onTakeDisk: vi.fn(),
    ...overrides,
  };
}

describe("NotesPanel dictation button", () => {
  it("shows the button in edit mode and hides it in preview", async () => {
    const user = userEvent.setup();
    render(<NotesPanel {...props()} />);

    expect(
      screen.getByRole("button", { name: "音声入力" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "プレビュー" }));

    expect(
      screen.queryByRole("button", { name: "音声入力" }),
    ).not.toBeInTheDocument();
  });

  it("shows the hint and focuses the editor on click", async () => {
    const user = userEvent.setup();
    render(<NotesPanel {...props()} />);

    const button = screen.getByRole("button", { name: "音声入力" });
    expect(button).toHaveAttribute("aria-expanded", "false");

    await user.click(button);

    expect(button).toHaveAttribute("aria-expanded", "true");
    const editor = screen.getByLabelText("メモ (markdown)");
    expect(editor).toHaveFocus();
    const hint = screen.getByText(/fn キーを2回押すと音声入力が始まります/);
    expect(hint.id).toBe(button.getAttribute("aria-controls"));
  });

  it("hides the hint again when the button is clicked a second time", async () => {
    const user = userEvent.setup();
    render(<NotesPanel {...props()} />);

    const button = screen.getByRole("button", { name: "音声入力" });
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");

    await user.click(button);

    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/fn キーを2回押す/)).not.toBeInTheDocument();
  });

  it("closes the hint when switching to preview", async () => {
    const user = userEvent.setup();
    render(<NotesPanel {...props()} />);

    await user.click(screen.getByRole("button", { name: "音声入力" }));
    expect(screen.getByText(/fn キーを2回押す/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "プレビュー" }));
    await user.click(screen.getByRole("button", { name: "編集" }));

    expect(screen.queryByText(/fn キーを2回押す/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "音声入力" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("is disabled while the note has not loaded yet", () => {
    render(<NotesPanel {...props({ loaded: false })} />);

    expect(screen.getByRole("button", { name: "音声入力" })).toBeDisabled();
  });

  it("is disabled while a conflict is unresolved", () => {
    render(<NotesPanel {...props({ conflict: "ファイルの内容" })} />);

    expect(screen.getByRole("button", { name: "音声入力" })).toBeDisabled();
  });
});
