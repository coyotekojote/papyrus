import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NotesPanel, type NotesPanelProps } from "./NotesPanel";

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

  it("never steals focus while following", () => {
    const content = "# 第1章\n";
    const { rerender } = render(
      <NotesPanel {...props({ content, followHeading: null })} />,
    );

    rerender(<NotesPanel {...props({ content, followHeading: "第1章" })} />);

    expect(document.activeElement).not.toBe(editor());
  });
});
