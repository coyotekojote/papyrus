import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TranslationPanel } from "./TranslationPanel";
import type { TranslationSource, TranslationState } from "./use-translation";

const source: TranslationSource = {
  input: {
    text: "Attention is all you need.",
    contextBefore: "",
    contextAfter: "",
  },
  page: 3,
};

const done: TranslationState = {
  status: "done",
  source,
  result: {
    text: "必要なのは注意だけ。",
    provider: "claude",
    model: "claude-opus-5",
    targetLanguage: "ja",
  },
};

function renderPanel(state: Exclude<TranslationState, { status: "idle" }>) {
  const handlers = {
    onCopy: vi.fn(),
    onInsertToNotes: vi.fn(),
    onRetry: vi.fn(),
    onDismiss: vi.fn(),
  };
  render(
    <TranslationPanel
      position={{ left: 10, top: 20 }}
      state={state}
      {...handlers}
    />,
  );
  return { user: userEvent.setup(), ...handlers };
}

describe("TranslationPanel", () => {
  it("says the request is running, with nothing to act on yet", () => {
    renderPanel({ status: "loading", source });

    expect(screen.getByText("翻訳しています…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "コピー" })).toBeNull();
    expect(screen.queryByRole("button", { name: "メモに挿入" })).toBeNull();
  });

  it("shows the translation with the provider and language that produced it", () => {
    renderPanel(done);

    expect(screen.getByText("必要なのは注意だけ。")).toBeInTheDocument();
    expect(screen.getByText("Claude · 日本語")).toBeInTheDocument();
  });

  it("copies and inserts what came back", async () => {
    const { user, onCopy, onInsertToNotes } = renderPanel(done);

    await user.click(screen.getByRole("button", { name: "コピー" }));
    await user.click(screen.getByRole("button", { name: "メモに挿入" }));

    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onInsertToNotes).toHaveBeenCalledTimes(1);
  });

  it("offers a retry for a failure, and nothing to copy", async () => {
    const { user, onRetry } = renderPanel({
      status: "error",
      source,
      message: "リクエストが多すぎます",
    });

    expect(screen.getByText("リクエストが多すぎます")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "コピー" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "再試行" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("closes on the button and on Escape", async () => {
    const { user, onDismiss } = renderPanel(done);

    await user.click(screen.getByRole("button", { name: "翻訳を閉じる" }));
    await user.keyboard("{Escape}");

    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});
