import { act, render, screen } from "@testing-library/react";
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
    followHeading: null,
    onChange: vi.fn(),
    onKeepLocal: vi.fn(),
    onTakeDisk: vi.fn(),
    ...overrides,
  };
}

function editor(): HTMLTextAreaElement {
  return screen.getByLabelText("メモ (markdown)") as HTMLTextAreaElement;
}

describe("NotesPanel", () => {
  it("moves the cursor to the matching heading when followHeading is set", () => {
    const content = "前書き\n\n# 第1章\n\n本文\n\n## 1.1節\n";
    const { rerender } = render(
      <NotesPanel {...props({ content, followHeading: null })} />,
    );

    rerender(<NotesPanel {...props({ content, followHeading: "1.1節" })} />);

    const textarea = editor();
    const expected = content.indexOf("## 1.1節");
    expect(textarea.selectionStart).toBe(expected);
    expect(textarea.selectionEnd).toBe(expected);
  });

  it("does not move the cursor while the reader is editing", async () => {
    const user = userEvent.setup();
    const content = "# 第1章\n\n本文\n";
    const { rerender } = render(
      <NotesPanel {...props({ content, followHeading: null })} />,
    );

    const textarea = editor();
    await user.click(textarea);
    await user.type(textarea, "x");
    // Move the caret away from the heading before the section changes.
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    act(() => {
      rerender(<NotesPanel {...props({ content, followHeading: "第1章" })} />);
    });

    expect(textarea.selectionStart).toBe(textarea.value.length);
  });

  it("does nothing when the heading cannot be found", () => {
    const content = "本文だけのメモ\n";
    const { rerender } = render(
      <NotesPanel {...props({ content, followHeading: null })} />,
    );
    const textarea = editor();
    textarea.setSelectionRange(2, 2);

    rerender(
      <NotesPanel {...props({ content, followHeading: "存在しない章" })} />,
    );

    expect(textarea.selectionStart).toBe(2);
  });

  it("does not move the cursor again when only content changes, not followHeading", () => {
    const content = "# 第1章\n\n本文\n";
    const { rerender } = render(
      <NotesPanel {...props({ content, followHeading: null })} />,
    );

    rerender(<NotesPanel {...props({ content, followHeading: "第1章" })} />);
    const textarea = editor();
    expect(textarea.selectionStart).toBe(0);

    // Something unrelated appends to the note — a quote, a clip, a
    // translation — while followHeading itself has not changed. Setting a
    // controlled textarea's value always moves the browser's own cursor to
    // the new end (that much is native behaviour, not this component's
    // doing); what must NOT happen is the follow effect re-running and
    // pulling it back to the heading at offset 0.
    const appended = `${content}> 引用\n`;
    rerender(
      <NotesPanel {...props({ content: appended, followHeading: "第1章" })} />,
    );

    expect(textarea.selectionStart).toBe(appended.length);
    expect(textarea.selectionStart).not.toBe(appended.indexOf("# 第1章"));
  });

  it("re-follows once the section actually changes again", () => {
    const content = "# 第1章\n\n本文\n\n# 第2章\n";
    const { rerender } = render(
      <NotesPanel {...props({ content, followHeading: null })} />,
    );

    rerender(<NotesPanel {...props({ content, followHeading: "第1章" })} />);
    const textarea = editor();
    expect(textarea.selectionStart).toBe(0);

    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    rerender(<NotesPanel {...props({ content, followHeading: "第2章" })} />);

    expect(textarea.selectionStart).toBe(content.indexOf("# 第2章"));
  });

  it("re-follows to the same heading after passing through null (leaving the section, or the setting toggled off and back on)", () => {
    const content = "# 第1章\n\n本文\n";
    const { rerender } = render(
      <NotesPanel {...props({ content, followHeading: null })} />,
    );

    rerender(<NotesPanel {...props({ content, followHeading: "第1章" })} />);
    const textarea = editor();
    expect(textarea.selectionStart).toBe(0);

    // The reader scrolls before the first bookmark (or the setting is
    // turned off) — followHeading goes back to null — and moves the caret
    // elsewhere in the meantime.
    rerender(<NotesPanel {...props({ content, followHeading: null })} />);
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    // Back to the same section. Without clearing the "applied" marker on
    // null, this would look like no change and the follow would be skipped.
    rerender(<NotesPanel {...props({ content, followHeading: "第1章" })} />);

    expect(textarea.selectionStart).toBe(0);
  });

  it("never steals focus while following", () => {
    const content = "# 第1章\n";
    const { rerender } = render(
      <NotesPanel {...props({ content, followHeading: null })} />,
    );

    rerender(<NotesPanel {...props({ content, followHeading: "第1章" })} />);

    expect(document.activeElement).not.toBe(editor());
  });
});

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
    const editorField = screen.getByLabelText("メモ (markdown)");
    expect(editorField).toHaveFocus();
    const hint = screen.getByText(/fn キーを2回押す/);
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

  it("stays closable if a conflict appears while the hint is open", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<NotesPanel {...props()} />);

    await user.click(screen.getByRole("button", { name: "音声入力" }));
    expect(screen.getByText(/fn キーを2回押す/)).toBeInTheDocument();

    // A conflict shows up mid-hint (e.g. another window saved notes.md).
    // The button must not be stranded disabled with the hint stuck open.
    rerender(<NotesPanel {...props({ conflict: "ファイルの内容" })} />);
    const button = screen.getByRole("button", { name: "音声入力" });
    expect(button).not.toBeDisabled();

    await user.click(button);

    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/fn キーを2回押す/)).not.toBeInTheDocument();
  });

  it("stays disabled while unloaded even if a hint could otherwise open", () => {
    render(<NotesPanel {...props({ loaded: false })} />);

    const button = screen.getByRole("button", { name: "音声入力" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-expanded", "false");
  });
});
