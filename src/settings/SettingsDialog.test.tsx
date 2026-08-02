import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiKeyStatus,
  deleteApiKey,
  saveApiKey,
  type ApiKeyStatus,
} from "./api-keys";
import { SettingsDialog } from "./SettingsDialog";
import {
  TRANSLATION_PROVIDERS,
  defaultSettings,
  type Settings,
  type TranslationProviderId,
} from "./settings";

vi.mock("./api-keys", () => ({
  apiKeyStatus: vi.fn(),
  saveApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
}));

function status(
  configured: Partial<Record<TranslationProviderId, boolean>> = {},
): ApiKeyStatus[] {
  return TRANSLATION_PROVIDERS.map((provider) => ({
    provider: provider.id,
    configured: configured[provider.id] ?? false,
  }));
}

/** Renders with the key status already read, so nothing lands after the test. */
async function renderDialog(settings: Settings = defaultSettings()) {
  const onChange = vi.fn();
  const onClose = vi.fn();
  await act(async () => {
    render(
      <SettingsDialog
        settings={settings}
        loaded
        error={null}
        onChange={onChange}
        onClose={onClose}
      />,
    );
  });
  return { onChange, onClose, user: userEvent.setup() };
}

/** The settings the dialog would have produced from a change it reported. */
function changedTo(onChange: ReturnType<typeof vi.fn>, base: Settings) {
  const change = onChange.mock.calls.at(-1)?.[0] as (s: Settings) => Settings;
  return change(base);
}

beforeEach(() => {
  vi.mocked(apiKeyStatus).mockReset();
  vi.mocked(saveApiKey).mockReset();
  vi.mocked(deleteApiKey).mockReset();
  vi.mocked(apiKeyStatus).mockResolvedValue(status());
  vi.mocked(saveApiKey).mockResolvedValue(undefined);
  vi.mocked(deleteApiKey).mockResolvedValue(undefined);
});

describe("SettingsDialog", () => {
  it("shows the current general settings", async () => {
    await renderDialog({
      ...defaultSettings(),
      defaultBinding: "right",
      defaultViewMode: "spread",
    });

    expect(
      screen.getByRole("combobox", { name: "デフォルトの綴じ方向" }),
    ).toHaveValue("right");
    expect(
      screen.getByRole("combobox", { name: "デフォルトの表示モード" }),
    ).toHaveValue("spread");
    await waitFor(() => expect(apiKeyStatus).toHaveBeenCalled());
  });

  it("reports a change of binding direction", async () => {
    const { onChange, user } = await renderDialog();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "デフォルトの綴じ方向" }),
      "right",
    );

    expect(changedTo(onChange, defaultSettings())).toEqual({
      ...defaultSettings(),
      defaultBinding: "right",
    });
  });

  it("reports a change of translation provider and target language", async () => {
    const { onChange, user } = await renderDialog();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "プロバイダ" }),
      "deepl",
    );
    expect(changedTo(onChange, defaultSettings()).translation.provider).toBe(
      "deepl",
    );

    await user.selectOptions(
      screen.getByRole("combobox", { name: "翻訳先の言語" }),
      "en",
    );
    expect(
      changedTo(onChange, defaultSettings()).translation.targetLanguage,
    ).toBe("en");
  });

  it("offers a language tag that was set by hand outside the app", async () => {
    await renderDialog({
      ...defaultSettings(),
      translation: { provider: "claude", targetLanguage: "pt-BR" },
    });

    expect(screen.getByRole("combobox", { name: "翻訳先の言語" })).toHaveValue(
      "pt-BR",
    );
  });

  it("says which providers already have a key", async () => {
    vi.mocked(apiKeyStatus).mockResolvedValue(status({ openai: true }));

    await renderDialog();

    await waitFor(() => expect(screen.getByText("設定済み")).toBeVisible());
    expect(screen.getAllByText("未設定")).toHaveLength(2);
  });

  it("stores a typed key and clears the field afterwards", async () => {
    const { user } = await renderDialog();
    await waitFor(() => expect(apiKeyStatus).toHaveBeenCalled());
    vi.mocked(apiKeyStatus).mockResolvedValue(status({ claude: true }));

    const input = screen.getByLabelText("Claude");
    await user.type(input, "sk-ant-123");
    await user.click(screen.getAllByRole("button", { name: "保存" })[0]);

    expect(saveApiKey).toHaveBeenCalledWith("claude", "sk-ant-123");
    // Nothing keeps the key around once the keychain has it.
    await waitFor(() => expect(input).toHaveValue(""));
    await waitFor(() => expect(screen.getByText("設定済み")).toBeVisible());
  });

  it("keeps the typed key and explains why when the keychain refuses", async () => {
    vi.mocked(saveApiKey).mockRejectedValue({
      kind: "keychain",
      message: "locked",
    });
    const { user } = await renderDialog();
    await waitFor(() => expect(apiKeyStatus).toHaveBeenCalled());

    const input = screen.getByLabelText("DeepL");
    await user.type(input, "deepl-key");
    await user.click(screen.getAllByRole("button", { name: "保存" })[2]);

    await waitFor(() =>
      expect(
        screen.getByText("キーチェーンを操作できませんでした: locked"),
      ).toBeVisible(),
    );
    // Retyping a key that never landed is the reader's time wasted.
    expect(input).toHaveValue("deepl-key");
  });

  it("does not offer to save an empty key", async () => {
    await renderDialog();
    await waitFor(() => expect(apiKeyStatus).toHaveBeenCalled());

    expect(screen.getAllByRole("button", { name: "保存" })[0]).toBeDisabled();
  });

  it("deletes a stored key, and only offers deletion when there is one", async () => {
    vi.mocked(apiKeyStatus).mockResolvedValue(status({ openai: true }));
    const { user } = await renderDialog();

    const deleteButtons = await screen.findAllByRole("button", {
      name: "削除",
    });
    await waitFor(() => expect(deleteButtons[1]).toBeEnabled());
    expect(deleteButtons[0]).toBeDisabled();

    vi.mocked(apiKeyStatus).mockResolvedValue(status());
    await user.click(deleteButtons[1]);

    expect(deleteApiKey).toHaveBeenCalledWith("openai");
    await waitFor(() => expect(screen.getAllByText("未設定")).toHaveLength(3));
  });

  it("closes on Escape, on the close button and on the backdrop", async () => {
    const { onClose, user } = await renderDialog();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "設定を閉じる" }));
    expect(onClose).toHaveBeenCalledTimes(2);

    // Clicking the panel itself is not clicking past the modal.
    await user.click(screen.getByRole("dialog", { name: "設定" }));
    expect(onClose).toHaveBeenCalledTimes(2);

    await user.click(document.querySelector(".modal") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("keeps keystrokes away from the shortcuts behind it", async () => {
    const onKeyDown = vi.fn();
    window.addEventListener("keydown", onKeyDown);
    const { user } = await renderDialog();

    await user.type(screen.getByLabelText("Claude"), "{ArrowRight}");

    // The viewer turns a page on ArrowRight; typing a key must not.
    expect(onKeyDown).not.toHaveBeenCalled();
    window.removeEventListener("keydown", onKeyDown);
  });

  it("surfaces a settings error", async () => {
    await act(async () => {
      render(
        <SettingsDialog
          settings={defaultSettings()}
          loaded={false}
          error="設定を保存できませんでした: permission denied"
          onChange={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    expect(
      screen.getByText("設定を保存できませんでした: permission denied"),
    ).toBeVisible();
    // Nothing is written back over settings that were never read.
    expect(
      screen.getByRole("combobox", { name: "デフォルトの綴じ方向" }),
    ).toBeDisabled();
  });
});
